import { z } from "zod";

export const writerLeaseSchema = z
  .object({
    version: z.literal(1),
    key: z.string().min(1).max(400),
    holderKind: z.enum(["repair", "fix", "apply"]),
    holderRunId: z.string().min(1).max(80),
    pid: z.number().int().positive(),
    epoch: z.number().int().nonnegative(),
    grantedAt: z.string().min(1).max(40),
  })
  .strict();
export type WriterLease = z.infer<typeof writerLeaseSchema>;

export function writerLeaseKey(input: { repo: string; sourceBranch: string }): string {
  return `${input.repo.trim().toLowerCase()}#${input.sourceBranch.trim()}`;
}

export function isRepairProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
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
