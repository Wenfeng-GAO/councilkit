/**
 * Versioned finding-groups sidecar. Strict v1 findings.json / repair-package
 * stay unchanged; this file is an identity projection, never close authority.
 */
import { z } from "zod";

export const FINDING_GROUPS_FILE = "finding-groups.v1.json";
export const FINDING_GROUPS_KIND = "councilkit-finding-groups";

const text = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      Array.from(value).every((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code !== 0 && !(code >= 0xd800 && code <= 0xdfff);
      }),
    "Invalid text",
  );

export const findingGroupAdjudicationSchema = z
  .object({
    kind: z.enum(["duplicate", "unsupported", "dismissed", "still_open_disagreement"]),
    reason: text.max(4000),
    evidenceHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export const findingGroupSchema = z
  .object({
    rootCauseId: text.max(400),
    findingIds: z.array(text.max(160)).min(1).max(64),
    aliases: z.array(text.max(160)).max(64),
    basis: text.max(2000),
    adjudication: findingGroupAdjudicationSchema.optional(),
  })
  .strict();

export const findingGroupsFileSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal(FINDING_GROUPS_KIND),
    source: z
      .object({
        runId: text.max(160),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        findingsSha256: z.string().regex(/^[0-9a-f]{64}$/),
        againstRunId: z.string().max(160).nullable(),
      })
      .strict(),
    groups: z.array(findingGroupSchema).max(200),
  })
  .strict();
export type FindingGroupsFile = z.infer<typeof findingGroupsFileSchema>;
export type FindingGroup = z.infer<typeof findingGroupSchema>;

export class FindingGroupsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingGroupsError";
  }
}

/** Map each original finding id to a stable rootCause. Missing sidecar → id. */
export function rootCauseByFindingId(groups: FindingGroupsFile | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!groups) return map;
  for (const group of groups.groups) {
    for (const id of group.findingIds) map.set(id, group.rootCauseId);
    for (const alias of group.aliases) {
      if (!map.has(alias)) map.set(alias, group.rootCauseId);
    }
  }
  return map;
}

export function resolveRootCause(
  findingId: string,
  groups: FindingGroupsFile | null | undefined,
): string {
  return rootCauseByFindingId(groups).get(findingId) ?? findingId;
}

/**
 * Reject unknown members, conflicting maps, cycles, and unstable roots.
 * knownIds is the current ledger; omit only when validating fixture shape.
 */
export function validateFindingGroups(
  groups: FindingGroupsFile,
  knownIds?: ReadonlySet<string>,
): void {
  const claimed = new Map<string, string>();
  const membersOfRoot = new Map<string, Set<string>>();
  for (const [index, group] of groups.groups.entries()) {
    for (const id of group.findingIds) {
      const previous = claimed.get(id);
      if (previous !== undefined && previous !== group.rootCauseId) {
        throw new FindingGroupsError(
          `finding-groups conflict: ${id} maps to both ${previous} and ${group.rootCauseId}`,
        );
      }
      claimed.set(id, group.rootCauseId);
      if (knownIds && !knownIds.has(id)) {
        throw new FindingGroupsError(`finding-groups unknown member: ${id}`);
      }
    }
    const bucket = membersOfRoot.get(group.rootCauseId) ?? new Set<string>();
    for (const id of group.findingIds) bucket.add(id);
    membersOfRoot.set(group.rootCauseId, bucket);
    if (group.findingIds.length === 0) {
      throw new FindingGroupsError(`finding-groups[${index}] has no findingIds`);
    }
  }
  for (const [root, members] of membersOfRoot) {
    const pointed = claimed.get(root);
    if (pointed !== undefined && pointed !== root && !members.has(root)) {
      throw new FindingGroupsError(`finding-groups cycle: ${root} → ${pointed}`);
    }
  }
}

