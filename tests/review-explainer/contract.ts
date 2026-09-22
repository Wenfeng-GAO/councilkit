/**
 * Frozen public contract for review-explainer (A01–A10).
 * Tests import these paths/shapes. Production must match; do not implement here.
 */

export const RUN_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01";
export const PR_URL = "https://github.com/acme-explainer/fixture/pull/1";
export const OTHER_PR_URL = "https://github.com/acme-explainer/other/pull/9";
export const ANTCODE_PR_URL =
  "https://code.alipay.com/explainer-fixture/session-runtime/pull_requests/7";
export const OTHER_ANTCODE_PR_URL =
  "https://code.alipay.com/explainer-fixture/session-runtime/pull_requests/8";

export const FINDING = {
  busy: "h-000000000101",
  stale: "h-000000000102",
  dup: "h-000000000103",
  deleted: "h-000000000104",
  unanchored: "h-000000000105",
  freshSameFile: "h-000000000106",
} as const;

/** Frozen assertions, independent of presentation titles or current line numbers. */
export const ASSERTION = {
  busy: "When recovery takes ownership after SubmitPrompt accepts a request, the manager returns ErrBusy while the runtime has accepted one turn.",
  busyExpected:
    "An accepted turn must have a durable matching record and must not be returned as a clean busy rejection.",
  busyCounterexample:
    "Pause SubmitPrompt after entry, acquire recovery ownership, release SubmitPrompt: acceptedCalls=1, ErrBusy, durable phase=idle.",
  newBusyMechanism:
    "A canceled request can retain a mutex forever and block all subsequent requests, even when no recovery runs.",
  stale:
    "A generation can change after the failure mutator checks it but before the failure is committed, leaving a stale error record.",
} as const;

/** Explicit opt-in preserves the existing unselected CLI export behavior. */
export const SELECTED_EXPORT_FLAG = "--selected";
export const REPAIR_PACKAGE_REVIEW_FLAG = "--repair-package";
// Each review/aggregate prompt carries the immutable RepairPackage as fenced JSON
// under "## 修复任务验收"; PR-wide observations remain outside this task scope.

export const DECISION = {
  undecided: "undecided",
  willFix: "will_fix",
  wontFix: "wont_fix",
} as const;

export type ReviewExplainerDecision = (typeof DECISION)[keyof typeof DECISION];

/** Production modules the next implementation phase must add or extend. */
export const MODULES = {
  diff: "@shared/runtime/review-explainer/diff",
  anchors: "@shared/runtime/review-explainer/anchors",
  decisions: "@shared/runtime/review-explainer/decisions",
  prDecisions: "@shared/runtime/review-explainer/pr-decisions",
  explanationSchema: "@shared/runtime/review-explainer/explanation-schema",
  canvas: "@shared/runtime/review-explainer/canvas",
  explanationCache: "@shared/runtime/review-explainer/explanation-cache",
  repairSelection: "@shared/runtime/review-explainer/repair-selection",
  hostRoutes: "@host/routes/review-explainer",
  explainSpawn: "../../cli/src/auto/explain-spawn.ts",
  skipPrompt: "../../cli/src/auto/review-skip.ts",
  prDecisionsCli: "../../cli/src/auto/pr-decisions.ts",
} as const;

/**
 * Host routes. Mutations are POST (runtime Route allows GET|POST|DELETE only).
 * All except health require session; POST also needs CSRF + Origin.
 */
export const ROUTES = {
  workspace: (runId: string) => `/api/v1/cli-runs/${runId}/review-explainer`,
  fileContent: (runId: string, fileKey: string) =>
    `/api/v1/cli-runs/${runId}/review-explainer/files/${fileKey}`,
  decisions: (runId: string) => `/api/v1/cli-runs/${runId}/review-explainer/decisions`,
  repairPackage: (runId: string) => `/api/v1/cli-runs/${runId}/review-explainer/repair-package`,
  explanation: (runId: string, findingId: string) =>
    `/api/v1/cli-runs/${runId}/review-explainer/explanations/${findingId}`,
} as const;

export const TEST_API = "/api/v1/__test__/review-explainer";

export const DISK = {
  // PR-level prDecisionsPath is the sole durable decision authority.
  decisions: "pr-decisions",
  explanations: "review-explainer/explanations",
  identity: "review-explainer/identity.json",
  prDecisionsDir: "pr-decisions",
} as const;

export const UI = {
  root: "review-explainer",
  fileNav: "review-explainer-file-nav",
  fileRow: (path: string) => `review-explainer-file-${path}`,
  diff: "review-explainer-diff",
  hunk: (path: string, index: number) => `review-explainer-hunk-${path}-${index}`,
  line: (side: "old" | "new", path: string, line: number) =>
    `review-explainer-line-${side}-${path}-${line}`,
  comment: (id: string) => `review-explainer-comment-${id}`,
  unanchored: "review-explainer-unanchored",
  understand: "review-explainer-understand",
  original: "review-explainer-original",
  willFix: "review-explainer-decide-will-fix",
  wontFix: "review-explainer-decide-wont-fix",
  undecided: "review-explainer-decide-undecided",
  drawer: "review-explainer-drawer",
  canvas: "review-explainer-canvas",
  canvasFallback: "review-explainer-canvas-fallback",
  suggested: "review-explainer-suggested-code",
  listFix: "review-explainer-list-fix",
  listSkip: "review-explainer-list-skip",
  listUndecided: "review-explainer-list-undecided",
  layoutUnified: "review-explainer-layout-unified",
  layoutSplit: "review-explainer-layout-split",
  generate: "review-explainer-generate",
  retry: "review-explainer-retry",
  saveError: "review-explainer-save-error",
  binary: "review-explainer-binary-status",
  missing: "review-explainer-missing-status",
  oldAbsent: "review-explainer-old-absent",
  identity: "review-explainer-identity",
  stickyHeader: "review-explainer-sticky-header",
} as const;

export function encodeFileKey(path: string): string {
  return encodeURIComponent(path);
}

export function prDecisionKey(prUrl: string): string {
  const url = new URL(prUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const host = url.hostname.toLowerCase();
  const owner = host === "github.com" ? (parts[0] ?? "").toLowerCase() : (parts[0] ?? "");
  const repo = host === "github.com" ? (parts[1] ?? "").toLowerCase() : (parts[1] ?? "");
  const number = parts[3] ?? "";
  if (host !== "github.com" && host !== "code.alipay.com")
    throw new Error("unsupported fixture PR host");
  const expectedSegment = host === "github.com" ? "pull" : "pull_requests";
  if (parts[2] !== expectedSegment || !/^\d+$/.test(number))
    throw new Error("invalid fixture PR URL");
  return `${host}/${owner}/${repo}#${number}`;
}

export function prDecisionsPath(home: string, prUrl: string): string {
  return `${home}/${DISK.prDecisionsDir}/${prDecisionKey(prUrl).split("/").join("__")}.json`;
}

export const EXPORTS = {
  diff: ["parseFrozenDiff", "summarizeDiff"],
  anchors: ["resolveFindingAnchor", "resolveFindingAnchors"],
  decisions: ["applyFindingDecision", "readFindingDecisions", "decisionRevision"],
  prDecisions: ["loadPrDecisions", "upsertPrDecision", "skipListForPr", "matchesSkippedIdentity"],
  explanationSchema: ["explanationPayloadSchema", "parseExplanationPayload"],
  canvas: ["renderCanvasModel", "canvasFallbackText"],
  explanationCache: ["createExplanationCache", "explanationCacheKey"],
  repairSelection: ["buildRepairPackageFromSelection"],
  hostRoutes: ["reviewExplainerRoutes"],
  explainSpawn: ["buildExplainSpawnSpec"],
  skipPrompt: ["formatSkipListForPrompt", "applySkipListToReviewTask"],
} as const;
