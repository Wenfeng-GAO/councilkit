import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { jsonParse } from "@shared/runtime/json-parse";
import {
  REPAIR_CAPABILITIES,
  type RepairCapability,
  type RepairGrantRecord as RepairGrant,
  type RepairProfileRecord as RepairProfile,
  grantIntegrityHash,
  profileIntegrityHash,
  protocolIntegrityHash,
  repairGrantRecordSchema,
  repairProfileRecordSchema,
} from "@shared/runtime/repair-auth";
import { V2_TRIAL_DEFAULTS } from "@shared/runtime/repair-chain";
import { isRepairProfileName } from "@shared/runtime/repair-lease";
import { normalizeReviewPr } from "@shared/runtime/review-case";
import { errors } from "../errors";
import { atomicWriteJson, readFileText } from "../store/atomic-write";
import { ensureHome, resolvePaths } from "../store/paths";

export { REPAIR_CAPABILITIES, profileIntegrityHash, protocolIntegrityHash };
export type { RepairCapability, RepairGrant, RepairProfile };

export function saveRepairProfile(input: {
  name: string;
  prUrl: string;
  repo: string;
  sourceBranch: string;
  base: string;
  capabilities: RepairCapability[];
  expiresAt?: string | null;
  protocolVersion?: "v1" | "v2";
  isolationMode?: "strong" | "collaborative";
  sourceFixMax?: number;
  deadlineMs?: number;
  diagnoseMs?: number;
  expectedGatePolicyHash?: string;
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
  if (input.protocolVersion === "v2") {
    if (!input.isolationMode) {
      throw errors.usage("v2 repair profile requires an explicit isolation mode");
    }
    profile.protocolVersion = "v2";
    profile.isolationMode = input.isolationMode;
    profile.sourceFixMax = input.sourceFixMax ?? V2_TRIAL_DEFAULTS.sourceFixMax;
    profile.deadlineMs = input.deadlineMs ?? V2_TRIAL_DEFAULTS.deadlineMs;
    profile.diagnoseMs = input.diagnoseMs ?? V2_TRIAL_DEFAULTS.diagnoseMs;
    profile.expectedGatePolicyHash = input.expectedGatePolicyHash;
    profile.protocolHash = protocolIntegrityHash(profile);
  }
  profile.integrityHash = profileIntegrityHash(profile);
  writeProfile(profile);
  return profile;
}

export function loadRepairProfile(name: string): RepairProfile {
  const path = profilePath(assertProfileName(name));
  const text = readFileText(path);
  if (text === null) throw errors.usage(`repair profile "${name}" not found`);
  const parsed = repairProfileRecordSchema.safeParse(jsonParse(text));
  if (!parsed.success) throw errors.usage(`repair profile "${name}" is invalid`);
  const expected = profileIntegrityHash(parsed.data);
  if (parsed.data.integrityHash !== expected) {
    throw errors.usage(`repair profile "${name}" integrity hash mismatch`);
  }
  if (parsed.data.protocolVersion === "v2") {
    if (parsed.data.isolationMode !== "strong" && parsed.data.isolationMode !== "collaborative") {
      throw errors.usage(`repair profile "${name}" v2 requires an explicit isolation mode`);
    }
    if (parsed.data.protocolHash !== protocolIntegrityHash(parsed.data)) {
      throw errors.usage(`repair profile "${name}" protocol hash mismatch`);
    }
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
  const parsed = repairGrantRecordSchema.safeParse(jsonParse(text));
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
  const parsed = repairGrantRecordSchema.safeParse(grant);
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
