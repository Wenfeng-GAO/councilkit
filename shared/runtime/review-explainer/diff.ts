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
function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  // Git's core.quotePath uses C escapes, including UTF-8 bytes as octal.
  const bytes: number[] = [];
  const raw = value.slice(1, -1);
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "\\") {
      const oct = /^[0-7]{3}/.exec(raw.slice(i + 1));
      if (oct) {
        bytes.push(Number.parseInt(oct[0], 8));
        i += 3;
        continue;
      }
      i += 1;
      const next = raw[i] ?? "";
      bytes.push(...Buffer.from(next === "t" ? "\t" : next === "n" ? "\n" : next, "utf8"));
    } else {
      const point = raw.codePointAt(i);
      const char = point === undefined ? "" : String.fromCodePoint(point);
      bytes.push(...Buffer.from(char, "utf8"));
      i += char.length - 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
function headerPath(raw: string): string | null {
  const value = unquote(raw);
  return value === "/dev/null" ? null : repoPath(value.replace(/^[ab]\//, ""));
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
      const header = line.slice(11);
      const pair = /^("(?:\\.|[^"\\])+"|a\/.+) ("(?:\\.|[^"\\])+"|b\/.+)$/.exec(header);
      if (!pair?.[1] || !pair[2]) throw new ExplainerError("Invalid frozen diff file header");
      const oldPath = headerPath(pair[1]);
      const newPath = headerPath(pair[2]);
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
