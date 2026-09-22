import { constants, closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { DecisionItem, DecisionsFile, FindingDecision } from "./contracts";
import { ExplainerError, assertPrivatePath, atomicJson, readBounded } from "./io";

export const decisionSchema = z.enum(["undecided", "will_fix", "wont_fix"]);
const itemSchema = z
  .object({
    findingId: z.string().min(1).max(160),
    decision: decisionSchema,
    identity: z.object({ kind: z.literal("stable-id"), value: z.string().max(160) }).optional(),
    aliases: z
      .array(z.object({ id: z.string().min(1).max(160), basis: z.literal("explicit") }))
      .max(100)
      .optional(),
    originalAssertion: z.string().max(8000).optional(),
    assertionVersion: z.number().int().positive().optional(),
    assertionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    sourceRunId: z.string().max(160).optional(),
    decidedAt: z.string().max(100).optional(),
    audit: z.object({ event: z.literal("user_clicked"), reason: z.string().max(2000) }).optional(),
  })
  .strict();
const fileSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("councilkit-pr-decisions").optional(),
    prUrl: z.string().max(2048).optional(),
    revision: z.number().int().nonnegative(),
    items: z.record(z.string(), itemSchema),
  })
  .strict();
export function readFindingDecisions(file: string): DecisionsFile {
  const raw = readBounded(file, 4 * 1024 * 1024, true);
  if (raw === null) return { version: 1, revision: 0, items: {} };
  try {
    return fileSchema.parse(JSON.parse(raw));
  } catch {
    throw new ExplainerError("Corrupt decision storage; refusing to reset history", 500);
  }
}
export function decisionRevision(file: string): number {
  return readFindingDecisions(file).revision;
}
export function applyFindingDecision(input: {
  file: string;
  findingId: string;
  decision: FindingDecision;
  expectedRevision: number;
  item?: Partial<DecisionItem>;
  prUrl?: string;
  root?: string;
}): DecisionsFile {
  decisionSchema.parse(input.decision);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !input.findingId ||
    input.findingId.length > 160
  )
    throw new ExplainerError("Invalid decision request");
  const lock = `${input.file}.lock`;
  let fd: number | undefined;
  try {
    if (input.root) assertPrivatePath(input.root, input.file, true);
    mkdirSync(dirname(input.file), { recursive: true, mode: 0o700 });
    try {
      fd = openSync(
        lock,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new ExplainerError("Decision revision conflict; reload and retry", 409);
      throw error;
    }
    const prior = readFindingDecisions(input.file);
    if (prior.revision !== input.expectedRevision)
      throw new ExplainerError("Stale decision revision conflict; reload and retry", 409);
    const items = {
      ...prior.items,
      [input.findingId]: {
        ...prior.items[input.findingId],
        ...input.item,
        findingId: input.findingId,
        decision: input.decision,
      },
    };
    const next = fileSchema.parse({
      ...prior,
      ...(input.prUrl ? { kind: "councilkit-pr-decisions", prUrl: input.prUrl } : {}),
      revision: prior.revision + 1,
      items,
    });
    if (Buffer.byteLength(JSON.stringify(next)) > 4 * 1024 * 1024)
      throw new ExplainerError("Decision storage size limit reached", 413);
    atomicJson(input.file, next);
    return next;
  } catch (error) {
    if (error instanceof ExplainerError) throw error;
    throw new ExplainerError("Cannot persist decision: storage write failure", 500);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {
        /* failure leaves observable lock */
      }
    }
  }
}
