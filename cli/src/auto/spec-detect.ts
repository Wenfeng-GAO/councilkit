/**
 * Spec-contract hard gate for `councilkit review`.
 *
 * Before review starts we detect whether the PR/task has a **contract document**
 * from project-conventional sources. Missing spec → hard refuse (exit 2).
 * Present → auto-bind as the subtractive review contract and schedule verify
 * against named acceptance points extracted from that document.
 *
 * `--spec <path|label>` still overrides / explicitly selects; when omitted,
 * auto-detect must succeed or the command refuses.
 */

import { Buffer } from "node:buffer";
import {
  type Dirent,
  type Stats,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseAntCodePrUrl, parseApplyPrUrl } from "@shared/runtime/pr-url";
import { AGGREGATE_PROMPT_BUDGET, MAX_SPEC_TEXT_IN_PROMPT } from "./templates/review";

/** Directories this repo already treats as plans / design / acceptance / vibespec. */
export const SPEC_CONVENTIONAL_PREFIXES = [
  "docs/plans/",
  "docs/design/",
  "docs/vibespec/",
  "docs/verification/",
] as const;

/** Basename patterns treated as contract documents when under a conventional prefix. */
export const SPEC_CONTRACT_BASENAMES = new Set([
  "prd.md",
  "design.md",
  "tech.md",
  "tasks.md",
  "verify.md",
  "acceptance.md",
  "contract.md",
]);

/** Path-like tokens that look like conventional contract sources. */
const PATH_REF_RE =
  /(?:^|[\s`"'([{])((?:docs\/(?:plans|design|vibespec|verification)\/[\w./@+-]+\.(?:md|mjs|json|txt))|(?:[\w./@+-]*(?:acceptance|contract|VERIFY|PRD|DESIGN|TECH)[\w./@+-]*\.md))(?=$|[\s`"' )\],.:;])/gim;

/**
 * Named acceptance / agentverify IDs inside a bound contract body.
 *
 * Two layers:
 * 1. Historical forms: `agentverify:…`, `AC-` / `INV-` / `AV-` (or underscore),
 *    bare `A1` / `A01`, `VT3`.
 * 2. Generic requirement ids: one leading letter, up to 7 more uppercase
 *    letters or digits, a single hyphen, then digits and an optional single
 *    trailing lowercase letter (`IN-12`, `SE-12`, `E2E-3`, `IN-12a`).
 *
 * The generic shape is intentionally narrow so it does not swallow tokens that
 * only look similar:
 * - Dates (`2026-10-16`) start with a digit, so the leading-letter rule misses them.
 * - A SHA-256 digest is hex without this prefix. The *name* `SHA-256` (and
 *   SHA-1/224/384/512) collides, so those names are denylisted. Same for
 *   encoding names `UTF-8` / `UTF-16` / `UTF-32`.
 * - ISO standard numbers (`ISO-8601`, `ISO-3166`) are denylisted by `ISO-` + digits.
 *   Country or language codes without a hyphen and a number never match.
 * - A dotted version (`GO-1.21`) is not an id: the match must not continue into `.\d`.
 *   `IN-12.` at the end of a sentence still matches, because the dot is not `.\d`.
 * - `RFC-2119` matches. It has the same shape as a requirement id; it is not a
 *   hash name, an encoding, or an ISO number, so it stays accepted.
 */
const NAMED_ACCEPTANCE_ID_RE =
  /\b(?:agentverify:[A-Za-z0-9][\w.:-]{0,80}|(?:AC|INV|AV)[-_][A-Za-z0-9][\w.-]{0,80}|A\d+|VT\d+)\b/g;

const GENERIC_ACCEPTANCE_ID_RE = /\b[A-Z][A-Z0-9]{0,7}-\d+[a-z]?(?!\.\d)\b/g;

/** Any prefix-hyphen-number token, including ones the generic rule rejects. */
const LOOSE_ID_RE = /\b[A-Za-z][A-Za-z0-9]{0,7}-\d+[A-Za-z]?(?!\.\d)\b/g;

const REJECTED_GENERIC_ID = /^(?:SHA-(?:1|2|3|224|256|384|512)|UTF-(?:8|16|32)|ISO-\d+)$/;

export interface DetectedSpec {
  /** Path or label used as `task.specSource`. */
  source: string;
  /** File body when readable; omitted for label-only explicit `--spec`. */
  text?: string;
  /** How the contract was chosen. */
  origin: "explicit-flag" | "auto-detect";
  /** Conventional path matches considered during detection (for diagnostics). */
  candidates: string[];
}

export interface SpecVerifyBinding {
  /** Named acceptance / agentverify points extracted from the bound spec. */
  acceptanceIds: string[];
  /** Human-readable schedule note injected into prompts / progress. */
  scheduleNote: string;
}

export const SPEC_REFUSAL_MESSAGE = [
  "review refused: no boundable spec-contract found for this PR/task.",
  "A review needs a contract document from project-conventional sources (refused in the review stage when --require-spec);",
  "PR description / --task text alone is not a contract and will not be used as a fallback.",
  "",
  "Where to put a spec (any one is enough):",
  "  - docs/plans/<feature>-plan.md",
  "  - docs/design/<feature>/…",
  "  - docs/vibespec/<project>/{PRD,DESIGN,TECH,TASKS,VERIFY}.md",
  "  - docs/verification/<feature>-acceptance.md (or other acceptance/contract doc)",
  "",
  "Then either:",
  "  - reference that path in the PR body / --task text (auto-detect), or",
  "  - pass --spec <path> (or a named label that resolves to such a file).",
].join("\n");

export const SPEC_VERIFY_UNBOUND_MESSAGE = [
  "review refused: a spec was bound, but verify cannot be scheduled —",
  "the contract has no named acceptance points / agentverify scenarios.",
].join("\n");

const SPEC_VERIFY_FORMAT_HINT = [
  "Add one of these to the bound spec:",
  "  - an acceptance id, for example IN-12, SE-12, E2E-3, AC-12, A01, VT3, or agentverify:cancel-path",
  "  - a markdown checkbox under a heading that contains 验收 or Acceptance:",
  "      ## 验收",
  "      - [ ] IN-12 空串仍返回问候",
  "  - a markdown table under that heading, or a table whose header cell is 编号 / 验收 / ID / Acceptance:",
  "      | 编号 | 标准 |",
  "      | --- | --- |",
  "      | IN-12 | 空串仍返回问候 |",
  "Generic ids match /\\b[A-Z][A-Z0-9]{0,7}-\\d+[a-z]?\\b/ (one optional trailing lowercase letter).",
  "Not acceptance ids: dates (YYYY-MM-DD), hash names (SHA-256), encodings (UTF-8), ISO standard numbers (ISO-8601).",
].join("\n");

/**
 * Resolve the review contract.
 * - `--spec` wins (explicit bind).
 * - Otherwise auto-detect from search text + optional repo root.
 * - Returns null when nothing boundable is found (caller soft-starts; review-stage gate may refuse).
 */
export function resolveSpecContract(input: {
  explicitSpec?: string | null;
  /** PR body, --task text, focus, title — scanned for conventional path refs. */
  searchText?: string | null;
  /** Local checkout root; used to validate / read detected paths. */
  repoRoot?: string | null;
}): DetectedSpec | null {
  const explicit = input.explicitSpec?.trim();
  if (explicit) {
    return bindExplicitSpec(explicit, input.repoRoot ?? null);
  }
  return autoDetectSpec({
    searchText: input.searchText ?? "",
    repoRoot: input.repoRoot ?? null,
  });
}

export function bindExplicitSpec(raw: string, repoRoot: string | null): DetectedSpec | null {
  const value = raw.trim();
  if (!value) return null;
  const resolved = resolveReadableSpecFile(value, repoRoot);
  if (resolved) {
    return {
      source: resolved.source,
      text: resolved.text,
      origin: "explicit-flag",
      candidates: [resolved.source],
    };
  }
  // Named label without a readable file: still counts as an explicit selection,
  // but verify will need body later (or refuse unbound verify).
  return {
    source: value,
    origin: "explicit-flag",
    candidates: [value],
  };
}

export function autoDetectSpec(input: {
  searchText: string;
  repoRoot: string | null;
}): DetectedSpec | null {
  const refs = extractConventionalSpecRefs(input.searchText);
  const candidates: string[] = [];
  for (const ref of refs) {
    const normalized = normalizeSpecRef(ref);
    if (!normalized) continue;
    if (!isConventionalSpecPath(normalized)) continue;
    candidates.push(normalized);
  }

  // Prefer a readable file under repoRoot (or cwd-relative).
  for (const candidate of candidates) {
    const resolved = resolveReadableSpecFile(candidate, input.repoRoot);
    if (resolved) {
      return {
        source: resolved.source,
        text: resolved.text,
        origin: "auto-detect",
        candidates,
      };
    }
  }

  // Bare basenames (PRD.md, VERIFY.md) match as path refs, so they never
  // reach this scan when the guard is `candidates.length === 0`. A nested
  // vibespec file is only found here. An explicit docs/... path that did
  // not read must not fall through onto a different file.
  const basenameOnly =
    candidates.length === 0 || candidates.every((candidate) => !candidate.includes("/"));
  if (input.repoRoot && basenameOnly) {
    const fromTree = scanRepoForReferencedContract(input.searchText, input.repoRoot);
    if (fromTree) {
      return {
        source: fromTree.source,
        text: fromTree.text,
        origin: "auto-detect",
        candidates: [fromTree.source],
      };
    }
  }

  // Path refs existed but none were readable: still not boundable.
  return null;
}

/** Extract conventional path references from free text (PR body / task). */
export function extractConventionalSpecRefs(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_REF_RE)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const normalized = normalizeSpecRef(raw);
    if (normalized && isConventionalSpecPath(normalized)) found.add(normalized);
  }
  return [...found];
}

export function isConventionalSpecPath(pathLike: string): boolean {
  const normalized = normalizeSpecRef(pathLike);
  if (!normalized) return false;
  if (SPEC_CONVENTIONAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  const base = basename(normalized).toLowerCase();
  if (SPEC_CONTRACT_BASENAMES.has(base)) return true;
  // acceptance / contract docs outside the prefix set still count when named so.
  if (/(?:^|\/)[^/]*(?:acceptance|contract)[^/]*\.md$/i.test(normalized)) return true;
  return false;
}

export function normalizeSpecRef(raw: string): string | null {
  let value = raw.trim().replace(/\\/g, "/");
  if (!value) return null;
  // Strip leading ./
  value = value.replace(/^\.\//, "");
  // Reject absolute / parent traversal for auto-detect safety.
  if (value.startsWith("/") || value.includes("..")) return null;
  return value;
}

/**
 * Extract acceptance / agentverify IDs from a bound contract body and build the
 * verify schedule note. Returns null when verify cannot be bound.
 */
export function bindVerifyFromSpec(input: {
  specSource: string;
  specText?: string | null;
}): SpecVerifyBinding | null {
  const body = input.specText?.trim() ?? "";
  if (!body) return null;
  const ids = extractAcceptanceIds(body);
  if (ids.length === 0) return null;
  const scheduleNote = [
    `Verify schedule: after/with contract review, verify against bound acceptance points from ${input.specSource}:`,
    ...ids.map((id) => `  - ${id}`),
  ].join("\n");
  return { acceptanceIds: ids, scheduleNote };
}

export function isRejectedAcceptanceToken(id: string): boolean {
  return REJECTED_GENERIC_ID.test(id);
}

/** True when `id` is a schedulable acceptance point (not a denylisted lookalike). */
export function isAcceptanceId(id: string): boolean {
  if (isRejectedAcceptanceToken(id)) return false;
  return (
    new RegExp(NAMED_ACCEPTANCE_ID_RE.source).test(id) ||
    new RegExp(GENERIC_ACCEPTANCE_ID_RE.source).test(id)
  );
}

export interface SpecAcceptanceInspection {
  acceptanceIds: string[];
  /** ATX headings in document order. */
  headings: string[];
  /**
   * Prefix-hyphen-number tokens that were seen but not accepted
   * (lowercase `in-12`, `SHA-256`, `UTF-8`, `ISO-8601`, …).
   */
  candidateIds: string[];
}

export function inspectSpecAcceptance(specText: string): SpecAcceptanceInspection {
  const acceptanceIds = extractAcceptanceIds(specText);
  const accepted = new Set(acceptanceIds);
  const headings: string[] = [];
  for (const line of specText.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
    if (heading?.[1]) headings.push(heading[1].trim());
  }
  const candidateIds: string[] = [];
  const seen = new Set<string>();
  for (const match of specText.matchAll(LOOSE_ID_RE)) {
    const id = match[0];
    if (!id || accepted.has(id) || seen.has(id) || isAcceptanceId(id)) continue;
    seen.add(id);
    candidateIds.push(id);
  }
  candidateIds.sort((a, b) => a.localeCompare(b));
  return { acceptanceIds, headings, candidateIds };
}

/** A `--spec` value that names a file, as opposed to a bare label. */
export function looksLikeSpecPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes("/") || trimmed.includes("\\")) return true;
  return /\.(?:md|txt|json|mjs)$/i.test(trimmed);
}

/** Headline when `--spec` names a file that cannot be read. */
export function formatMissingSpecFile(path: string): string {
  return `找不到规格文件 \`${path.trim()}\`。请检查路径后重新运行。`;
}

/** SPEC_VERIFY_UNBOUND text that belongs inside a collapsed 详情 block. */
export function formatMissingSpecDetail(input: {
  specSource?: string | null;
  specText?: string | null;
}): string {
  return ["SPEC_VERIFY_UNBOUND", formatSpecVerifyUnbound(input)].join("\n");
}

export function formatSpecVerifyUnbound(input: {
  specSource?: string | null;
  specText?: string | null;
}): string {
  const inspected = inspectSpecAcceptance(input.specText ?? "");
  const headings = inspected.headings.length > 0 ? inspected.headings.join(" | ") : "(none)";
  const candidates =
    inspected.candidateIds.length > 0 ? inspected.candidateIds.join(", ") : "(none)";
  const source = input.specSource?.trim();
  return [
    SPEC_VERIFY_UNBOUND_MESSAGE,
    source ? `Bound spec: ${source}` : "",
    `Headings seen: ${headings}`,
    `Candidate IDs seen: ${candidates}`,
    "",
    SPEC_VERIFY_FORMAT_HINT,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function extractAcceptanceIds(specText: string): string[] {
  const ids = new Set<string>();
  for (const match of specText.matchAll(NAMED_ACCEPTANCE_ID_RE)) {
    const id = match[0]?.trim();
    if (id && !isRejectedAcceptanceToken(id)) ids.add(id);
  }
  for (const match of specText.matchAll(GENERIC_ACCEPTANCE_ID_RE)) {
    const id = match[0]?.trim();
    if (id && !isRejectedAcceptanceToken(id)) ids.add(id);
  }
  // Checklist items and table rows under an acceptance section become synthetic
  // IDs when the document has no schedulable tokens (narrative plans).
  if (ids.size === 0) {
    for (const synthetic of extractAcceptanceChecklistIds(specText)) {
      ids.add(synthetic);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

const ACCEPTANCE_HEADING_RE = /^#{1,3}\s+.*(验收|acceptance|verify|合同|contract)/i;
const ACCEPTANCE_HEADER_CELL_RE = /^(?:编号|id|验收|acceptance|用例|场景)$/i;

function slugAcceptanceText(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|");
}

function pushSynthetic(items: string[], raw: string): void {
  const slug = slugAcceptanceText(raw);
  if (!slug) return;
  const id = `accept:${slug}`;
  if (!items.includes(id)) items.push(id);
}

function extractAcceptanceChecklistIds(specText: string): string[] {
  const lines = specText.split(/\r?\n/);
  let inAcceptance = false;
  const items: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (ACCEPTANCE_HEADING_RE.test(line)) {
      inAcceptance = true;
      continue;
    }
    if (inAcceptance && /^#{1,3}\s+/.test(line)) {
      inAcceptance = false;
    }
    const check = /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/.exec(line);
    if (inAcceptance && check?.[1]) {
      pushSynthetic(items, check[1]);
      if (items.length >= 32) break;
      continue;
    }
    if (!isTableRow(line) || isTableSeparator(line)) continue;
    const header = splitTableCells(line);
    const headerIsAcceptance =
      inAcceptance || header.some((cell) => ACCEPTANCE_HEADER_CELL_RE.test(cell));
    if (!headerIsAcceptance) continue;
    // Consume this table. The current line is the header.
    i += 1;
    if (isTableSeparator(lines[i] ?? "")) i += 1;
    for (; i < lines.length; i++) {
      const row = lines[i] ?? "";
      if (!isTableRow(row) || isTableSeparator(row)) break;
      const cells = splitTableCells(row).filter((cell) => cell.length > 0 && !/^[-:]+$/.test(cell));
      if (cells.length === 0) continue;
      pushSynthetic(items, cells.join(" "));
      if (items.length >= 32) return items;
    }
    i -= 1;
  }
  return items;
}

/** Truncate a bound spec body to `cap` UTF-8 bytes without splitting a code unit. */
function truncateSpecBody(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  let end = cap;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString("utf8")}\n[truncated at ${cap} bytes]`;
}

/** Absolute path of a spec file, resolved from the process cwd when relative. */
function recordedSpecSource(candidate: string): string {
  const absolute = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function resolveReadableSpecFile(
  pathOrLabel: string,
  repoRoot: string | null,
): { source: string; text: string } | null {
  const tries: string[] = [];
  const normalized = pathOrLabel.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  tries.push(normalized);
  if (repoRoot) {
    tries.push(join(repoRoot, normalized));
  }
  for (const candidate of tries) {
    if (!existsSync(candidate)) continue;
    let st: Stats;
    try {
      st = lstatSync(candidate);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let body: string;
    try {
      body = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    // Hard refuse files larger than the aggregate prompt budget; otherwise
    // truncate to MAX_SPEC_TEXT_IN_PROMPT so reserved overhead stays available.
    if (Buffer.byteLength(body, "utf8") > AGGREGATE_PROMPT_BUDGET) continue;
    // Record the absolute path. A later re-review runs in the Host's cwd, so a
    // cwd-relative or repo-relative source would miss the file.
    return {
      source: recordedSpecSource(candidate),
      text: truncateSpecBody(body, MAX_SPEC_TEXT_IN_PROMPT),
    };
  }
  return null;
}

/** When search text names VERIFY.md / PRD.md etc., pick the first match under vibespec/plans. */
function scanRepoForReferencedContract(
  searchText: string,
  repoRoot: string,
): { source: string; text: string } | null {
  const lower = searchText.toLowerCase();
  const wanted = [...SPEC_CONTRACT_BASENAMES].filter((name) => lower.includes(name));
  if (
    wanted.length === 0 &&
    !/(vibespec|docs\/plans|docs\/design|docs\/verification)/i.test(searchText)
  ) {
    return null;
  }
  for (const prefix of SPEC_CONVENTIONAL_PREFIXES) {
    const abs = join(repoRoot, prefix);
    if (!existsSync(abs)) continue;
    const hits = listMarkdownFiles(abs, 40);
    for (const file of hits) {
      const rel = relative(repoRoot, file).split(sep).join("/");
      const base = basename(file).toLowerCase();
      if (wanted.length > 0 && !wanted.includes(base)) continue;
      if (wanted.length === 0 && !isConventionalSpecPath(rel)) continue;
      const resolved = resolveReadableSpecFile(rel, repoRoot);
      if (resolved) return resolved;
    }
  }
  return null;
}

function listMarkdownFiles(dir: string, limit: number): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (out.length >= limit || depth > 6) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && /\.(md|mjs|json)$/i.test(entry.name)) {
        try {
          if (statSync(full).isFile()) out.push(full);
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** Exact refusal copy for the CLI hard gate (usage / exit 2). */
export function formatSpecRefusal(detail?: {
  searched?: string;
  repoRoot?: string | null;
}): string {
  const extra: string[] = [];
  if (detail?.searched?.trim()) {
    const refs = extractConventionalSpecRefs(detail.searched);
    if (refs.length > 0) {
      extra.push("", `Referenced but not readable under the local repo: ${refs.join(", ")}`);
    }
  }
  if (detail?.repoRoot) {
    extra.push("", `Local repo scanned: ${detail.repoRoot}`);
  }
  return SPEC_REFUSAL_MESSAGE + (extra.length > 0 ? `\n${extra.join("\n")}` : "");
}

/** Best-effort PR title+body for auto-detect (GitHub via `gh`; AntCode via `antcode`). */
export async function fetchPrSpecSearchText(input: {
  prUrl: string;
  runCommand: (args: {
    executable: string;
    argv: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  try {
    const parsedUrl = parseApplyPrUrl(input.prUrl);
    if (parsedUrl === null) return "";
    const cwd = input.cwd ?? process.cwd();
    const baseEnv = input.env ?? process.env;
    if (parsedUrl.kind === "github") {
      const view = await input.runCommand({
        executable: "gh",
        argv: ["pr", "view", input.prUrl, "--json", "title,body"],
        cwd,
        env: baseEnv,
        timeoutMs: 30_000,
      });
      if (view.exitCode !== 0) return "";
      return joinPrTitleBody(JSON.parse(view.stdout));
    }
    const ant = parseAntCodePrUrl(parsedUrl.url);
    if (ant === null) return "";
    const shown = await input.runCommand({
      executable: "antcode",
      argv: ["pr", "show", ant.iid, "-P", ant.project, "--json", "--raw", "--no-pager"],
      cwd,
      // AntCode is an internal CLI — strip proxies on this one command only.
      env: {
        ...baseEnv,
        NO_PROXY: "*",
        no_proxy: "*",
        HTTPS_PROXY: "",
        HTTP_PROXY: "",
        https_proxy: "",
        http_proxy: "",
      },
      timeoutMs: 30_000,
    });
    if (shown.exitCode !== 0) return "";
    return joinPrTitleBody(JSON.parse(shown.stdout));
  } catch {
    return "";
  }
}

/** Normalize GitHub (`title`/`body`) and AntCode/GitLab (`title`/`description`) payloads. */
function joinPrTitleBody(parsed: unknown): string {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const row = parsed as Record<string, unknown>;
  const title = typeof row.title === "string" ? row.title : "";
  const body =
    typeof row.body === "string"
      ? row.body
      : typeof row.description === "string"
        ? row.description
        : "";
  return [title, body].filter((s) => s.trim().length > 0).join("\n\n");
}

/** Apply a DetectedSpec + verify binding onto a ReviewTask-shaped object. */
export function applySpecToTask(
  task: {
    specSource?: string;
    specText?: string;
    acceptanceIds?: string[];
    verifyScheduleNote?: string;
  },
  detected: DetectedSpec,
  verify: SpecVerifyBinding,
): void {
  task.specSource = detected.source;
  if (detected.text !== undefined) task.specText = detected.text;
  task.acceptanceIds = verify.acceptanceIds;
  task.verifyScheduleNote = verify.scheduleNote;
}
