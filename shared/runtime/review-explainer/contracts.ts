import type { LedgerFinding } from "../cli-ledger";

export type FindingDecision = "undecided" | "will_fix" | "wont_fix";
export interface FrozenIdentity {
  prUrl: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  diffHash: string;
}
export interface DiffLine {
  type: "add" | "delete" | "context";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: "modified" | "added" | "deleted" | "renamed";
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}
export interface FindingAnchor {
  status: "resolved" | "context" | "unresolved";
  path?: string;
  side?: "old" | "new";
  line?: number;
  endLine?: number;
  snippet?: string;
  reason?: string;
}
export interface ExplainerFinding extends LedgerFinding {
  anchors: FindingAnchor[];
  decision: FindingDecision;
}
export interface DecisionItem {
  findingId: string;
  decision: FindingDecision;
  identity?: { kind: "stable-id"; value: string };
  aliases?: Array<{ id: string; basis: "explicit" }>;
  originalAssertion?: string;
  assertionVersion?: number;
  assertionHash?: string;
  sourceRunId?: string;
  decidedAt?: string;
  audit?: { event: "user_clicked"; reason: string };
}
export interface DecisionsFile {
  version: 1;
  kind?: "councilkit-pr-decisions";
  prUrl?: string;
  revision: number;
  items: Record<string, DecisionItem>;
}
export interface ReviewExplainerWorkspace {
  runId: string;
  identity: FrozenIdentity;
  files: DiffFile[];
  findings: ExplainerFinding[];
  decisions: DecisionsFile;
  revision: number;
  originalReport: string;
  totals: { files: number; hunks: number; additions: number; deletions: number };
  availability: "available" | "missing";
  notice?: string;
}
export interface FrozenFileContent {
  path: string;
  side: "old" | "new";
  sha: string;
  availability: "available" | "absent" | "binary";
  text: string;
  lines: Array<{ number: number; text: string }>;
}
export interface CanvasModel {
  template: "flow" | "sequence";
  nodes: Array<{
    id: string;
    label: string;
    evidence: "assertion" | "evidence" | "inference";
    actor?: string;
    location?: { path: string; side: "old" | "new"; line: number };
  }>;
  edges: Array<{ from: string; to: string; label?: string }>;
  participants?: Array<{ id: string; label: string }>;
}
export interface ExplanationPayload {
  kind: "code" | "flow" | "sequence" | "text";
  assertion: string;
  evidence: string[];
  inference: string[];
  preconditions?: string[];
  steps?: string[];
  suggestedCode?: { before: string; after: string; verifiedFixed: false };
  canvas?: CanvasModel;
  modelId?: string;
}
export interface ExplanationResult {
  status: "ready";
  payload: ExplanationPayload;
  provenance: {
    executionId: string;
    runId: string;
    findingId: string;
    headSha: string;
    modelId: string;
    driverId: string;
    generatedAt: string;
    sourceHash: string;
    cacheKey: string;
    schemaVersion: number;
    mode: "model" | "injected";
  };
  cached: boolean;
}
/** Inject only the external generation boundary; production uses the configured restricted CLI. */
export interface ExplainerExecutorInput {
  runId: string;
  findingId: string;
  headSha: string;
  prUrl: string;
  originalFinding: LedgerFinding;
  source: Array<{ path: string; side: "old" | "new"; sha: string; text: string }>;
  prompt: string;
  signal: AbortSignal;
}
export interface ExplainerExecutor {
  modelId?: string;
  generate(input: ExplainerExecutorInput): Promise<unknown>;
}
