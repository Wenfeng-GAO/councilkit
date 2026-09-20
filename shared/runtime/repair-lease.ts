import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

export { writerRepoFromPrUrl } from "./pr-url";
export { isRepairProfileName } from "./repair-name";

export const writerLeaseSchema = z
  .object({
    version: z.literal(1),
    key: z.string().min(1).max(400),
    holderKind: z.enum(["repair", "fix", "apply"]),
    holderRunId: z.string().min(1).max(80),
    pid: z.number().int().positive(),
    writerPids: z.array(z.number().int().positive()).max(16).optional(),
    epoch: z.number().int().nonnegative(),
    grantedAt: z.string().min(1).max(40),
  })
  .strict();
export type WriterLease = z.infer<typeof writerLeaseSchema>;

export function writerLeaseKey(input: { repo: string; sourceBranch: string }): string {
  return `${input.repo.trim().toLowerCase()}#${input.sourceBranch.trim()}`;
}

export function writerLeaseFileName(key: string): string {
  return `writer-${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`;
}

export function writerLeasePath(home: string, key: string): string {
  return join(home, "locks", writerLeaseFileName(key));
}

export function parseWriterLease(text: string): WriterLease | null {
  let rec: unknown;
  try {
    rec = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = writerLeaseSchema.safeParse(rec);
  return parsed.success ? parsed.data : null;
}

export function isActiveRepairHolder(input: {
  kind: string;
  status: string;
  businessResult?: "approved" | "needs_attention" | "stopped" | null;
  lease: WriterLease | null;
  pidAlive: boolean;
}): boolean {
  if (input.kind !== "repair" || input.lease === null) return false;
  if (
    input.businessResult === "approved" ||
    input.businessResult === "needs_attention" ||
    input.businessResult === "stopped"
  ) {
    return false;
  }
  if (input.status === "running") return input.pidAlive;
  return input.status === "interrupted";
}
