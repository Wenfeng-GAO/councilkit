import {
  type RepairGrantRecord,
  type RepairProfileRecord,
  grantIntegrityHash,
  parseRepairGrantRecord,
  parseRepairProfileRecord,
  profileIntegrityHash,
  repairBranchHintsFromFrozenContext,
  verifyRepairGrantRecord,
} from "@shared/runtime/repair-auth";
import { describe, expect, it } from "vitest";

const profile: RepairProfileRecord = {
  version: 1,
  name: "default",
  prUrl: "https://github.com/acme/repo/pull/1",
  repo: "github.com/acme/repo",
  sourceBranch: "feat-x",
  base: "main",
  capabilities: ["push-source-branch"],
  integrityHash: "",
  expiresAt: null,
  revokedAt: null,
  createdAt: "2026-09-20T00:00:00.000Z",
};
profile.integrityHash = profileIntegrityHash(profile);

describe("repair grant verify", () => {
  it("accepts a matching grant and rejects a revoked profile", () => {
    const grant: RepairGrantRecord = {
      grantId: "g1",
      grantHash: "",
      profileName: "default",
      profileHash: profile.integrityHash,
      capabilities: ["push-source-branch"],
      prUrl: profile.prUrl,
      repo: profile.repo,
      sourceBranch: profile.sourceBranch,
      base: profile.base,
      issuedAt: "2026-09-20T00:00:00.000Z",
      expiresAt: null,
    };
    grant.grantHash = grantIntegrityHash(grant);
    expect(parseRepairProfileRecord(JSON.stringify(profile))?.name).toBe("default");
    expect(parseRepairGrantRecord(JSON.stringify(grant))?.grantId).toBe("g1");
    expect(verifyRepairGrantRecord(grant, profile, "2026-09-20T01:00:00.000Z")).toEqual({
      ok: true,
    });
    expect(
      verifyRepairGrantRecord(
        grant,
        { ...profile, revokedAt: "2026-09-20T00:30:00.000Z" },
        "2026-09-20T01:00:00.000Z",
      ),
    ).toEqual({ ok: false, reason: "repair profile is revoked" });
  });
});

describe("repairBranchHintsFromFrozenContext", () => {
  it("reads source and target branch names from frozen review-context.md", () => {
    expect(
      repairBranchHintsFromFrozenContext(
        "# Frozen review context\n\n- source: `feat/foo`\n- target: `main`\n",
      ),
    ).toEqual({ sourceBranch: "feat/foo", base: "main" });
  });

  it("ignores HEAD, origin/ prefixes, and unknown placeholders", () => {
    expect(
      repairBranchHintsFromFrozenContext("- source: `HEAD`\n- target: `origin/main`\n"),
    ).toEqual({ sourceBranch: null, base: null });
    expect(repairBranchHintsFromFrozenContext("- source: `unknown`\n- target: `HEAD~1`\n")).toEqual(
      { sourceBranch: null, base: null },
    );
  });
});
