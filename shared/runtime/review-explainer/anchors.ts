import type { DiffFile, FindingAnchor } from "./contracts";
export interface AnchorInput {
  findingId?: string;
  parsedDiff: { files: DiffFile[] };
  side: "old" | "new";
  path: string;
  line: number;
  snippet?: string;
  headSha?: string;
  sourceSha?: string;
}
export function resolveFindingAnchor(input: AnchorInput): FindingAnchor {
  const unresolved = (reason: string): FindingAnchor => ({ status: "unresolved", reason });
  if (input.headSha && input.sourceSha && input.headSha !== input.sourceSha)
    return unresolved("引用来自不同审查版本，位置待确认");
  const file = input.parsedDiff.files.find(
    (row) => (input.side === "old" ? row.oldPath : row.newPath) === input.path,
  );
  if (!file || file.binary || !Number.isSafeInteger(input.line) || input.line < 1)
    return unresolved("找不到此版本的引用位置");
  const found = file.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((line) => (input.side === "old" ? line.oldLine : line.newLine) === input.line);
  if (found.length !== 1 || (input.snippet && !found[0]?.text.includes(input.snippet)))
    return unresolved("代码与引用不匹配，位置待确认");
  return {
    status: "resolved",
    path: input.path,
    side: input.side,
    line: input.line,
    endLine: input.line,
    snippet: found[0]?.text ?? "",
  };
}
export function resolveFindingAnchors(inputs: AnchorInput[]): FindingAnchor[] {
  return inputs.map(resolveFindingAnchor);
}
