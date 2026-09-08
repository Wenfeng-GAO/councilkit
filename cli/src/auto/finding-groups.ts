/**
 * Persist and load finding-groups.v1.json next to findings.json.
 * A missing sidecar is a fallback; a present-but-invalid sidecar is a hard error.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FindingsFile, LedgerFinding } from "@shared/runtime/cli-ledger";
import {
  FINDING_GROUPS_FILE,
  FINDING_GROUPS_KIND,
  FindingGroupsError,
  type FindingGroupsFile,
  findingGroupsFileSchema,
  validateFindingGroups,
} from "@shared/runtime/finding-groups";
import { atomicWriteJson } from "../store/atomic-write";

export { FINDING_GROUPS_FILE, FindingGroupsError } from "@shared/runtime/finding-groups";

export function hashFindingsBytes(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

export function findingsFileBytes(file: FindingsFile): string {
  return `${JSON.stringify(file)}\n`;
}

export function buildFindingGroups(input: {
  runId: string;
  sha: string;
  findings: readonly LedgerFinding[];
  againstRunId: string | null;
  findingsSha256: string;
  matches?: readonly { originalId: string; aliasId: string; basis: string }[];
  priorGroups?: FindingGroupsFile | null;
}): FindingGroupsFile {
  const known = new Set(input.findings.map((row) => row.id));
  const byRoot = new Map<
    string,
    { findingIds: Set<string>; aliases: Set<string>; basis: string }
  >();
  const idToRoot = new Map<string, string>();
  for (const group of input.priorGroups?.groups ?? []) {
    const findingIds = group.findingIds.filter((id) => known.has(id));
    if (findingIds.length === 0) continue;
    const bucket = byRoot.get(group.rootCauseId) ?? {
      findingIds: new Set<string>(),
      aliases: new Set<string>(),
      basis: group.basis,
    };
    for (const id of findingIds) {
      bucket.findingIds.add(id);
      idToRoot.set(id, group.rootCauseId);
    }
    for (const alias of group.aliases) {
      bucket.aliases.add(alias);
      if (!idToRoot.has(alias)) idToRoot.set(alias, group.rootCauseId);
    }
    bucket.basis = group.basis;
    byRoot.set(group.rootCauseId, bucket);
  }
  for (const match of input.matches ?? []) {
    const root = idToRoot.get(match.originalId) ?? match.originalId;
    const bucket = byRoot.get(root) ?? {
      findingIds: new Set<string>(),
      aliases: new Set<string>(),
      basis: match.basis,
    };
    if (known.has(match.originalId)) bucket.findingIds.add(match.originalId);
    bucket.aliases.add(match.aliasId);
    if (known.has(match.aliasId)) bucket.findingIds.add(match.aliasId);
    bucket.basis = match.basis;
    byRoot.set(root, bucket);
    idToRoot.set(match.originalId, root);
    idToRoot.set(match.aliasId, root);
  }
  const groups = [...byRoot.entries()]
    .map(([rootCauseId, value]) => ({
      rootCauseId,
      findingIds: [...value.findingIds],
      aliases: [...value.aliases],
      basis: value.basis,
    }))
    .filter((group) => group.findingIds.length > 0);
  const file: FindingGroupsFile = {
    version: 1,
    kind: FINDING_GROUPS_KIND,
    source: {
      runId: input.runId,
      sha: input.sha.toLowerCase(),
      findingsSha256: input.findingsSha256,
      againstRunId: input.againstRunId,
    },
    groups,
  };
  validateFindingGroups(file, known);
  return findingGroupsFileSchema.parse(file);
}

export function writeFindingGroups(runDir: string, file: FindingGroupsFile): void {
  atomicWriteJson(join(runDir, FINDING_GROUPS_FILE), file);
}

export function readFindingGroupsFile(path: string): FindingGroupsFile {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") throw new FindingGroupsError("finding-groups sidecar is missing");
    throw new FindingGroupsError("finding-groups sidecar is unreadable");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new FindingGroupsError("finding-groups sidecar is not a regular file");
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new FindingGroupsError("finding-groups sidecar is unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FindingGroupsError("finding-groups sidecar is not JSON");
  }
  const result = findingGroupsFileSchema.safeParse(parsed);
  if (!result.success) {
    const version =
      parsed !== null && typeof parsed === "object" && "version" in parsed
        ? (parsed as { version?: unknown }).version
        : undefined;
    if (version !== 1) {
      throw new FindingGroupsError("finding-groups sidecar version is unknown");
    }
    throw new FindingGroupsError("finding-groups sidecar is invalid");
  }
  return result.data;
}

export function loadFindingGroups(input: {
  runDir: string;
  ledger: Pick<FindingsFile, "runId" | "sha" | "findings" | "againstRunId">;
  findingsBytes?: string;
}): FindingGroupsFile | null {
  const path = join(input.runDir, FINDING_GROUPS_FILE);
  let exists = true;
  try {
    const stat = lstatSync(path);
    exists = stat.isFile() || stat.isSymbolicLink();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new FindingGroupsError("finding-groups sidecar is unreadable");
  }
  if (!exists) return null;
  const groups = readFindingGroupsFile(path);
  const sha = (input.ledger.sha ?? "").toLowerCase();
  if (groups.source.runId !== input.ledger.runId || groups.source.sha !== sha) {
    throw new FindingGroupsError("finding-groups sidecar does not match this run");
  }
  if (
    input.ledger.againstRunId &&
    groups.source.againstRunId &&
    groups.source.againstRunId !== input.ledger.againstRunId
  ) {
    throw new FindingGroupsError("finding-groups sidecar against source does not match this run");
  }
  if (input.findingsBytes !== undefined) {
    const actual = hashFindingsBytes(input.findingsBytes);
    if (actual !== groups.source.findingsSha256) {
      throw new FindingGroupsError("finding-groups sidecar findings hash does not match");
    }
  }
  validateFindingGroups(groups, new Set(input.ledger.findings.map((row) => row.id)));
  return groups;
}
