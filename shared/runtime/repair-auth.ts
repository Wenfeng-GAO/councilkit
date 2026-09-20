import { createHash } from "node:crypto";
import { z } from "zod";
import { isRepairProfileName } from "./repair-lease";

export const REPAIR_CAPABILITIES = ["push-source-branch"] as const;
export type RepairCapability = (typeof REPAIR_CAPABILITIES)[number];

const capabilitySchema = z.enum(REPAIR_CAPABILITIES);

export const repairProfileRecordSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(64),
    prUrl: z.string().min(1).max(500),
    repo: z.string().min(1).max(400),
    sourceBranch: z.string().min(1).max(200),
    base: z.string().min(1).max(200),
    capabilities: z.array(capabilitySchema).min(1).max(8),
    integrityHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().min(1).max(40).nullable(),
    revokedAt: z.string().min(1).max(40).nullable(),
    createdAt: z.string().min(1).max(40),
  })
  .strict();
export type RepairProfileRecord = z.infer<typeof repairProfileRecordSchema>;

export const repairGrantRecordSchema = z
  .object({
    grantId: z.string().min(1).max(80),
    grantHash: z.string().regex(/^[a-f0-9]{64}$/),
    profileName: z.string().min(1).max(64),
    profileHash: z.string().regex(/^[a-f0-9]{64}$/),
    capabilities: z.array(capabilitySchema).min(1).max(8),
    prUrl: z.string().min(1).max(500),
    repo: z.string().min(1).max(400),
    sourceBranch: z.string().min(1).max(200),
    base: z.string().min(1).max(200),
    issuedAt: z.string().min(1).max(40),
    expiresAt: z.string().min(1).max(40).nullable(),
  })
  .strict();
export type RepairGrantRecord = z.infer<typeof repairGrantRecordSchema>;

export function profileIntegrityHash(input: {
  prUrl: string;
  repo: string;
  sourceBranch: string;
  base: string;
  capabilities: readonly string[];
}): string {
  return sha(
    JSON.stringify({
      prUrl: input.prUrl,
      repo: input.repo.toLowerCase(),
      sourceBranch: input.sourceBranch,
      base: input.base,
      capabilities: [...input.capabilities].sort(),
    }),
  );
}

export function grantIntegrityHash(
  grant: Omit<RepairGrantRecord, "grantHash"> & { grantHash: string },
): string {
  return sha(
    JSON.stringify({
      grantId: grant.grantId,
      profileHash: grant.profileHash,
      capabilities: [...grant.capabilities].sort(),
      prUrl: grant.prUrl,
      repo: grant.repo,
      sourceBranch: grant.sourceBranch,
      base: grant.base,
    }),
  );
}

export function parseRepairProfileRecord(text: string): RepairProfileRecord | null {
  const parsed = repairProfileRecordSchema.safeParse(jsonParse(text));
  if (!parsed.success) return null;
  if (!isRepairProfileName(parsed.data.name)) return null;
  if (parsed.data.integrityHash !== profileIntegrityHash(parsed.data)) return null;
  return parsed.data;
}

export function parseRepairGrantRecord(text: string): RepairGrantRecord | null {
  const parsed = repairGrantRecordSchema.safeParse(jsonParse(text));
  if (!parsed.success) return null;
  if (parsed.data.grantHash !== grantIntegrityHash(parsed.data)) return null;
  return parsed.data;
}

export function verifyRepairGrantRecord(
  grant: RepairGrantRecord,
  profile: RepairProfileRecord,
  now: string,
): { ok: true } | { ok: false; reason: string } {
  if (profile.revokedAt) return { ok: false, reason: "repair profile is revoked" };
  if (isExpired(profile.expiresAt, now) || isExpired(grant.expiresAt, now)) {
    return { ok: false, reason: "repair grant is expired" };
  }
  if (grant.profileHash !== profile.integrityHash) {
    return { ok: false, reason: "profile hash mismatch" };
  }
  if (
    grant.prUrl !== profile.prUrl ||
    grant.repo !== profile.repo ||
    grant.sourceBranch !== profile.sourceBranch ||
    grant.base !== profile.base
  ) {
    return { ok: false, reason: "grant identity mismatch" };
  }
  return { ok: true };
}

function isExpired(expiresAt: string | null, now: string): boolean {
  if (expiresAt === null) return false;
  return Date.parse(expiresAt) <= Date.parse(now);
}

function jsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
