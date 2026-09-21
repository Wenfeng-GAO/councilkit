import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isRepairProfileName } from "@shared/runtime/repair-lease";
import { normalizeReviewPr } from "@shared/runtime/review-case";
import { z } from "zod";
import { errors } from "../errors";
import { atomicWriteJson, readFileText } from "../store/atomic-write";
import { ensureHome, resolvePaths } from "../store/paths";

export const REPAIR_CAPABILITIES = ["push-source-branch"] as const;
export type RepairCapability = (typeof REPAIR_CAPABILITIES)[number];

const capabilitySchema = z.enum(REPAIR_CAPABILITIES);

const repairProfileSchema = z
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
export type RepairProfile = z.infer<typeof repairProfileSchema>;

const repairGrantSchema = z
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
export type RepairGrant = z.infer<typeof repairGrantSchema>;

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

export function saveRepairProfile(input: {
  name: string;
  prUrl: string;
  repo: string;
  sourceBranch: string;
  base: string;
  capabilities: RepairCapability[];
  expiresAt?: string | null;
}): RepairProfile {
  const name = assertProfileName(input.name);
  const prUrl = normalizeReviewPr(input.prUrl);
  if (prUrl === null) throw errors.usage("repair profile requires a GitHub or AntCode PR URL");
  const capabilities = uniqueCaps(input.capabilities);
  const createdAt = new Date().toISOString();
  const profile: RepairProfile = {
    version: 1,
    name,
    prUrl,
    repo: input.repo.trim().toLowerCase(),
    sourceBranch: input.sourceBranch.trim(),
    base: input.base.trim(),
    capabilities,
    integrityHash: "",
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    createdAt,
  };
  profile.integrityHash = profileIntegrityHash(profile);
  writeProfile(profile);
  return profile;
}

export function loadRepairProfile(name: string): RepairProfile {
  const path = profilePath(assertProfileName(name));
  const text = readFileText(path);
  if (text === null) throw errors.usage(`repair profile "${name}" not found`);
  const parsed = repairProfileSchema.safeParse(jsonParse(text));
  if (!parsed.success) throw errors.usage(`repair profile "${name}" is invalid`);
  const expected = profileIntegrityHash(parsed.data);
  if (parsed.data.integrityHash !== expected) {
    throw errors.usage(`repair profile "${name}" integrity hash mismatch`);
  }
  return parsed.data;
}

export function reuseRepairProfile(
  name: string,
  expected: {
    prUrl: string;
    repo: string;
    sourceBranch: string;
    base: string;
    capabilities: RepairCapability[];
  },
  now = new Date().toISOString(),
): RepairProfile {
  const profile = loadRepairProfile(name);
  assertProfileUsable(profile, now);
  const prUrl = normalizeReviewPr(expected.prUrl) ?? expected.prUrl;
  if (
    profile.prUrl !== prUrl ||
    profile.repo !== expected.repo.trim().toLowerCase() ||
    profile.sourceBranch !== expected.sourceBranch.trim() ||
    profile.base !== expected.base.trim()
  ) {
    throw errors.usage("repair profile identity drifted (PR, source branch, or base changed)");
  }
  const requested = uniqueCaps(expected.capabilities);
  if (requested.some((cap) => !profile.capabilities.includes(cap))) {
    throw errors.usage("repair profile cannot grant capabilities beyond the saved allow-list");
  }
  return profile;
}

export function revokeRepairProfile(name: string, now = new Date().toISOString()): RepairProfile {
  const profile = loadRepairProfile(name);
  const next = { ...profile, revokedAt: now };
  writeProfile(next);
  return next;
}

export function readRepairGrantFile(runDir: string): RepairGrant | null {
  const text = readFileText(join(runDir, "repair-grant.json"));
  if (text === null) return null;
  const parsed = repairGrantSchema.safeParse(jsonParse(text));
  return parsed.success ? parsed.data : null;
}

export function loadReusableRepairGrant(input: {
  runDir: string;
  profile: RepairProfile;
  grantId?: string | null;
  grantHash?: string | null;
  now: string;
  hasWritableCycle: boolean;
}): RepairGrant {
  const existing = readRepairGrantFile(input.runDir);
  if (existing) {
    const verified = verifyRepairGrant(existing, input.profile, { now: input.now });
    if (!verified.ok) {
      throw errors.usage(`repair grant is not reusable: ${verified.reason}`);
    }
    if (input.grantId && input.grantId !== existing.grantId) {
      throw errors.usage("repair grant id drifted from parent state");
    }
    if (input.grantHash && input.grantHash !== existing.grantHash) {
      throw errors.usage("repair grant hash drifted from parent state");
    }
    return existing;
  }
  if (input.hasWritableCycle || input.grantId || input.grantHash) {
    throw errors.usage("repair grant is missing and cannot be reissued for an existing cycle");
  }
  const minted = createRepairGrant(input.profile, input.now);
  atomicWriteJson(join(input.runDir, "repair-grant.json"), minted);
  return minted;
}

export function createRepairGrant(
  profile: RepairProfile,
  now = new Date().toISOString(),
): RepairGrant {
  assertProfileUsable(profile, now);
  const grantId = randomUUID();
  const grant: RepairGrant = {
    grantId,
    grantHash: "",
    profileName: profile.name,
    profileHash: profile.integrityHash,
    capabilities: profile.capabilities,
    prUrl: profile.prUrl,
    repo: profile.repo,
    sourceBranch: profile.sourceBranch,
    base: profile.base,
    issuedAt: now,
    expiresAt: profile.expiresAt,
  };
  grant.grantHash = grantIntegrityHash(grant);
  return grant;
}

export function verifyRepairGrant(
  grant: RepairGrant,
  profile: RepairProfile,
  opts: { now: string },
): { ok: boolean; reason?: string } {
  const parsed = repairGrantSchema.safeParse(grant);
  if (!parsed.success) return { ok: false, reason: "invalid grant" };
  if (parsed.data.grantHash !== grantIntegrityHash(parsed.data)) {
    return { ok: false, reason: "grant hash mismatch" };
  }
  if (parsed.data.profileHash !== profile.integrityHash) {
    return { ok: false, reason: "profile hash mismatch" };
  }
  if (profile.revokedAt) return { ok: false, reason: "profile revoked" };
  if (isExpired(profile.expiresAt, opts.now) || isExpired(parsed.data.expiresAt, opts.now)) {
    return { ok: false, reason: "grant expired" };
  }
  if (
    parsed.data.prUrl !== profile.prUrl ||
    parsed.data.repo !== profile.repo ||
    parsed.data.sourceBranch !== profile.sourceBranch ||
    parsed.data.base !== profile.base
  ) {
    return { ok: false, reason: "grant identity mismatch" };
  }
  return { ok: true };
}

function grantIntegrityHash(grant: Omit<RepairGrant, "grantHash"> & { grantHash: string }): string {
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

function assertProfileUsable(profile: RepairProfile, now: string): void {
  if (profile.revokedAt) throw errors.usage("repair profile is revoked");
  if (isExpired(profile.expiresAt, now)) throw errors.usage("repair profile is expired");
}

function isExpired(expiresAt: string | null, now: string): boolean {
  if (expiresAt === null) return false;
  return Date.parse(expiresAt) <= Date.parse(now);
}

function assertProfileName(name: string): string {
  if (!isRepairProfileName(name)) {
    throw errors.usage("repair profile name must be a closed token, not a path");
  }
  return name;
}

function uniqueCaps(caps: readonly RepairCapability[]): RepairCapability[] {
  return [...new Set(caps)];
}

function profilePath(name: string): string {
  ensureHome();
  const dir = join(resolvePaths().home, "profiles");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${name}.json`);
}

function writeProfile(profile: RepairProfile): void {
  atomicWriteJson(profilePath(profile.name), profile);
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
