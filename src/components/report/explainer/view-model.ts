import { isFindingVerifiedClosed } from "@shared/runtime/cli-ledger";
import type {
  DiffFile,
  ExplainerFinding,
  FindingDecision,
} from "@shared/runtime/review-explainer/contracts";
import type { CodeLocation } from "./ExplanationDiagram";

export interface ReviewFilters {
  query: string;
  status: "active" | "all" | "open" | "closed" | "accepted" | "regress";
  severity: "all" | ExplainerFinding["severity"];
  decision: "all" | FindingDecision;
}
export const initialReviewFilters: ReviewFilters = {
  query: "",
  status: "active",
  severity: "all",
  decision: "all",
};
export const decisionLabels: Record<FindingDecision, string> = {
  undecided: "待定",
  will_fix: "修复",
  wont_fix: "不修复",
};
export function findingDisplayStatus(finding: ExplainerFinding, headSha?: string) {
  if (finding.status === "accepted") return "已接受";
  if (isFindingVerifiedClosed(finding, headSha)) return "已验证关闭";
  if (finding.status === "closed") return finding.verification ? "待验证当前提交" : "历史未验证";
  return finding.status === "regress" ? "重新出现" : "未关闭";
}
export function isActiveFinding(finding: ExplainerFinding, headSha?: string) {
  return finding.status !== "accepted" && !isFindingVerifiedClosed(finding, headSha);
}
export { displayFindingTitle as findingDisplayTitle } from "./finding-presentation";
export function matchesFinding(
  finding: ExplainerFinding,
  number: number,
  decision: FindingDecision,
  filters: ReviewFilters,
  headSha?: string,
) {
  if (filters.status === "active" && !isActiveFinding(finding, headSha)) return false;
  if (filters.status === "closed" && !isFindingVerifiedClosed(finding, headSha)) return false;
  if (
    filters.status !== "active" &&
    filters.status !== "closed" &&
    filters.status !== "all" &&
    finding.status !== filters.status
  )
    return false;
  if (filters.severity !== "all" && finding.severity !== filters.severity) return false;
  if (filters.decision !== "all" && decision !== filters.decision) return false;
  const query = filters.query.trim().toLocaleLowerCase();
  return (
    !query ||
    `#${number} ${finding.title} ${finding.text} ${finding.files.join(" ")}`
      .toLocaleLowerCase()
      .includes(query)
  );
}
export function findingMatchesFile(finding: ExplainerFinding, file: DiffFile) {
  const paths = new Set([file.path, file.oldPath, file.newPath].filter(Boolean));
  return (
    finding.files.some((path) => paths.has(path)) ||
    finding.anchors.some((anchor) => anchor.path && paths.has(anchor.path))
  );
}
export function locationFile(files: DiffFile[], location: CodeLocation) {
  return files.find(
    (file) => (location.side === "old" ? file.oldPath : file.newPath) === location.path,
  );
}
export function hasDiffLocation(files: DiffFile[], location: CodeLocation) {
  const file = locationFile(files, location);
  return !!file?.hunks.some((hunk) =>
    hunk.lines.some(
      (line) => (location.side === "old" ? line.oldLine : line.newLine) === location.line,
    ),
  );
}
export function parentPaths(path: string) {
  const parts = path.split("/");
  parts.pop();
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}
