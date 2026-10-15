import type { DiffFile, DiffHunk } from "./contracts";
import { ExplainerError } from "./io";

export function repoPath(value: string): string {
  if (
    !value ||
    value.length > 1000 ||
    value.startsWith("/") ||
    value.startsWith("-") ||
    value.includes("\\") ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    value.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
  )
    throw new ExplainerError("Invalid repository-relative path", 403);
  return value;
}
/** Git C escapes from quote.c. Unknown escapes are rejected, not dropped. */
function cEscapeByte(next: string): number | null {
  switch (next) {
    case "a":
      return 0x07;
    case "b":
      return 0x08;
    case "t":
      return 0x09;
    case "n":
      return 0x0a;
    case "v":
      return 0x0b;
    case "f":
      return 0x0c;
    case "r":
      return 0x0d;
    case "\\":
    case '"':
      return next.charCodeAt(0);
    default:
      return null;
  }
}
/** Index just past the closing quote, or -1. */
function endOfCQuote(value: string, open: number): number {
  for (let i = open + 1; i < value.length; i += 1) {
    if (value[i] === "\\") {
      i += 1;
      continue;
    }
    if (value[i] === '"') return i + 1;
  }
  return -1;
}
/**
 * Decode one git path token.
 * An unquoted `---`/`+++` name ends at the timestamp tab (`a/my file.txt\t`).
 * A quoted name ends at its closing quote; the timestamp tab sits outside it.
 */
function unquote(value: string): string {
  if (!value.startsWith('"')) return value.split("\t", 1)[0] ?? value;
  const bytes: number[] = [];
  let i = 1;
  while (i < value.length) {
    const ch = value[i] ?? "";
    if (ch === '"') {
      const rest = value.slice(i + 1);
      if (rest.length === 0 || rest.startsWith("\t")) return Buffer.from(bytes).toString("utf8");
      throw new ExplainerError("Invalid frozen diff file header");
    }
    if (ch !== "\\") {
      const point = value.codePointAt(i);
      const char = point === undefined ? "" : String.fromCodePoint(point);
      bytes.push(...Buffer.from(char, "utf8"));
      i += Math.max(char.length, 1);
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) throw new ExplainerError("Invalid frozen diff file header");
    const named = cEscapeByte(next);
    if (named !== null) {
      bytes.push(named);
      i += 2;
      continue;
    }
    const oct = /^[0-7]{3}/.exec(value.slice(i + 1));
    if (!oct) throw new ExplainerError("Invalid frozen diff file header");
    const code = Number.parseInt(oct[0], 8);
    if (code > 255) throw new ExplainerError("Invalid frozen diff file header");
    bytes.push(code);
    i += 4;
  }
  throw new ExplainerError("Invalid frozen diff file header");
}
function headerPath(raw: string): string | null {
  const value = unquote(raw);
  return value === "/dev/null" ? null : repoPath(value.replace(/^[ab]\//, ""));
}
/**
 * `diff --git a/<old> b/<new>`.
 * Git quotes each side on its own, so one side may be quoted and the other not.
 * An unquoted name can contain spaces and ` b/`. The same name is the split
 * where both sides match. Renames differ and are corrected by `rename from` /
 * `rename to` or by the `---` / `+++` lines.
 */
function splitDiffGitPaths(header: string): { oldRaw: string; newRaw: string } {
  if (header.startsWith('"')) {
    const firstEnd = endOfCQuote(header, 0);
    if (firstEnd < 0 || header[firstEnd] !== " ") {
      throw new ExplainerError("Invalid frozen diff file header");
    }
    const second = header.slice(firstEnd + 1);
    if (second.startsWith('"')) {
      if (endOfCQuote(second, 0) !== second.length) {
        throw new ExplainerError("Invalid frozen diff file header");
      }
    } else if (!second.startsWith("b/")) {
      throw new ExplainerError("Invalid frozen diff file header");
    }
    return { oldRaw: header.slice(0, firstEnd), newRaw: second };
  }
  if (!header.startsWith("a/")) throw new ExplainerError("Invalid frozen diff file header");
  const quotedNew = header.indexOf(' "');
  if (quotedNew > 0 && endOfCQuote(header, quotedNew + 1) === header.length) {
    return { oldRaw: header.slice(0, quotedNew), newRaw: header.slice(quotedNew + 1) };
  }
  const rest = header.slice(2);
  let from = 0;
  let fallback: { oldRaw: string; newRaw: string } | null = null;
  while (from < rest.length) {
    const at = rest.indexOf(" b/", from);
    if (at <= 0) break;
    const name = rest.slice(0, at);
    const after = rest.slice(at + 3);
    if (after === name) return { oldRaw: `a/${name}`, newRaw: `b/${name}` };
    if (!fallback) fallback = { oldRaw: `a/${name}`, newRaw: `b/${after}` };
    from = at + 1;
  }
  if (!fallback) throw new ExplainerError("Invalid frozen diff file header");
  return fallback;
}
export function parseFrozenDiff(diff: string): { files: DiffFile[]; warnings: string[] } {
  if (
    Buffer.byteLength(diff) > 16 * 1024 * 1024 ||
    diff.includes(String.fromCharCode(0)) ||
    diff.includes(String.fromCharCode(27))
  )
    throw new ExplainerError("Invalid or oversized frozen diff");
  const files: DiffFile[] = [];
  const warnings: string[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  const finishHunk = () => {
    if (!hunk) return;
    const oldCount = hunk.lines.filter((line) => line.type !== "add").length;
    const newCount = hunk.lines.filter((line) => line.type !== "delete").length;
    if (oldCount !== hunk.oldLines || newCount !== hunk.newLines)
      warnings.push(`Incomplete hunk in ${file?.path ?? "file"}`);
    hunk = undefined;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finishHunk();
      const paths = splitDiffGitPaths(line.slice(11));
      const oldPath = headerPath(paths.oldRaw);
      const newPath = headerPath(paths.newRaw);
      file = {
        path: newPath ?? oldPath ?? "",
        oldPath,
        newPath,
        status: "modified",
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(file);
      continue;
    }
    if (!file) {
      if (line.trim()) throw new ExplainerError("Invalid frozen diff content");
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      finishHunk();
      hunk = {
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? 1),
        header: line,
        lines: [],
      };
      if (
        [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].some(
          (n) => !Number.isSafeInteger(n) || n < 0 || n > 10_000_000,
        )
      )
        throw new ExplainerError("Invalid diff line range");
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (hunk && ["+", "-", " "].includes(line[0] ?? "")) {
      const type = line[0] === "+" ? "add" : line[0] === "-" ? "delete" : "context";
      hunk.lines.push({
        type,
        text: line.slice(1),
        oldLine: type === "add" ? null : oldLine++,
        newLine: type === "delete" ? null : newLine++,
      });
      if (type === "add") file.additions += 1;
      if (type === "delete") file.deletions += 1;
      continue;
    }
    if (line.startsWith("--- ")) {
      file.oldPath = headerPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      file.newPath = headerPath(line.slice(4));
      file.path = file.newPath ?? file.oldPath ?? file.path;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.oldPath = null;
    }
    if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.newPath = null;
    }
    if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = repoPath(unquote(line.slice(12)));
    }
    if (line.startsWith("rename to ")) {
      file.newPath = repoPath(unquote(line.slice(10)));
      file.path = file.newPath;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
      file.hunks = [];
    }
  }
  finishHunk();
  if (files.length > 5000 || new Set(files.map((row) => row.path)).size !== files.length)
    throw new ExplainerError("Invalid diff file count or duplicate paths");
  return { files, warnings };
}
export function summarizeDiff(parsed: { files: DiffFile[] }) {
  return {
    files: parsed.files.length,
    hunks: parsed.files.reduce((n, file) => n + file.hunks.length, 0),
    additions: parsed.files.reduce((n, file) => n + file.additions, 0),
    deletions: parsed.files.reduce((n, file) => n + file.deletions, 0),
  };
}
