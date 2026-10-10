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
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

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

/**
 * Max UTF-8 bytes kept when binding a contract file. Matches
 * `MAX_SPEC_TEXT_IN_PROMPT` (= AGGREGATE_PROMPT_BUDGET − AGGREGATE_PROMPT_RESERVED_OVERHEAD)
 * so a bound body cannot consume the entire aggregate prompt budget.
 * Larger readable files are truncated (not refused) with a marker.
 */
export const MAX_SPEC_BYTES = 200 * 1024 - 48 * 1024; // 152 KiB; keep in sync with templates/review.ts

/** Path-like tokens that look like conventional contract sources. */
const PATH_REF_RE =
  /(?:^|[\s`"'([{])((?:docs\/(?:plans|design|vibespec|verification)\/[\w./@+-]+\.(?:md|mjs|json|txt))|(?:[\w./@+-]*(?:acceptance|contract|VERIFY|PRD|DESIGN|TECH)[\w./@+-]*\.md))(?=$|[\s`"' )\],.:;])/gim;

/** Named acceptance / agentverify IDs inside a bound contract body. */
const ACCEPTANCE_ID_RE =
  /\b(?:agentverify:[A-Za-z0-9][\w.:-]{0,80}|(?:AC|INV|AV)[-_][A-Za-z0-9][\w.-]{0,80}|A\d{2,}|VT\d+)\b/g;

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
  "Add IDs such as AC-12, A01, INV-1, VT3, or agentverify:<scenario>",
  "in the bound document (or under an ## 验收 / ## Acceptance section).",
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

  // No path refs, but repo has a vibespec VERIFY/PRD mentioned by basename in text.
  if (input.repoRoot && candidates.length === 0) {
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

export function extractAcceptanceIds(specText: string): string[] {
  const ids = new Set<string>();
  for (const match of specText.matchAll(ACCEPTANCE_ID_RE)) {
    const id = match[0]?.trim();
    if (id) ids.add(id);
  }
  // Checklist items under an acceptance-ish heading become synthetic IDs when
  // the document has no AC/INV tokens (common in narrative plans).
  if (ids.size === 0) {
    for (const synthetic of extractAcceptanceChecklistIds(specText)) {
      ids.add(synthetic);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function extractAcceptanceChecklistIds(specText: string): string[] {
  const lines = specText.split(/\r?\n/);
  let inAcceptance = false;
  const items: string[] = [];
  for (const line of lines) {
    if (/^#{1,3}\s+.*(验收|acceptance|verify|合同|contract)/i.test(line)) {
      inAcceptance = true;
      continue;
    }
    if (inAcceptance && /^#{1,3}\s+/.test(line)) {
      inAcceptance = false;
    }
    if (!inAcceptance) continue;
    const check = /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/.exec(line);
    if (!check?.[1]) continue;
    const slug = check[1]
      .trim()
      .toLowerCase()
      .replace(/[`*_]/g, "")
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    if (slug) items.push(`accept:${slug}`);
    if (items.length >= 32) break;
  }
  return items;
}


/** Truncate a bound spec body to `cap` UTF-8 bytes without splitting a code unit. */
function truncateSpecBody(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  let end = cap;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString("utf8")}\n[truncated at ${cap} bytes]`;
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
    let st;
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
    // Hard refuse absurdly large files (cannot be a useful contract); otherwise
    // truncate to MAX_SPEC_BYTES so aggregate prompts keep reserved overhead.
    if (Buffer.byteLength(body, "utf8") > 200 * 1024) continue;
    const source =
      repoRoot && candidate.startsWith(repoRoot)
        ? normalizeSpecRef(relative(repoRoot, candidate).split(sep).join("/")) ?? candidate
        : normalized;
    return { source, text: truncateSpecBody(body, MAX_SPEC_BYTES) };
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
  if (wanted.length === 0 && !/(vibespec|docs\/plans|docs\/design|docs\/verification)/i.test(searchText)) {
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
    let entries;
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
export function formatSpecRefusal(detail?: { searched?: string; repoRoot?: string | null }): string {
  const extra: string[] = [];
  if (detail?.searched && detail.searched.trim()) {
    const refs = extractConventionalSpecRefs(detail.searched);
    if (refs.length > 0) {
      extra.push(
        "",
        `Referenced but not readable under the local repo: ${refs.join(", ")}`,
      );
    }
  }
  if (detail?.repoRoot) {
    extra.push("", `Local repo scanned: ${detail.repoRoot}`);
  }
  return SPEC_REFUSAL_MESSAGE + (extra.length > 0 ? `\n${extra.join("\n")}` : "");
}

/** Best-effort PR title+body for auto-detect (GitHub via `gh`; AntCode ignored). */
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
    const view = await input.runCommand({
      executable: "gh",
      argv: ["pr", "view", input.prUrl, "--json", "title,body"],
      cwd: input.cwd ?? process.cwd(),
      env: input.env ?? process.env,
      timeoutMs: 30_000,
    });
    if (view.exitCode !== 0) return "";
    const parsed = JSON.parse(view.stdout) as { title?: unknown; body?: unknown };
    const title = typeof parsed.title === "string" ? parsed.title : "";
    const body = typeof parsed.body === "string" ? parsed.body : "";
    return [title, body].filter((s) => s.trim().length > 0).join("\n\n");
  } catch {
    return "";
  }
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
