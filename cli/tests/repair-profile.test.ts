import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRepairGrant,
  loadRepairProfile,
  reuseRepairProfile,
  revokeRepairProfile,
  saveRepairProfile,
  verifyRepairGrant,
} from "../src/auto/repair-profile";
import { CliError } from "../src/errors";

const PR = "https://github.com/acme/repo/pull/9";
const IDENTITY = {
  prUrl: PR,
  repo: "github.com/acme/repo",
  sourceBranch: "feat-x",
  base: "main",
};

describe("repair profile and grant", () => {
  let home: string;
  let previous: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-repair-profile-"));
    previous = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
    else process.env.COUNCILKIT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it("saves a named profile and reuses it when identity and capabilities match", () => {
    const saved = saveRepairProfile({
      name: "default",
      ...IDENTITY,
      capabilities: ["push-source-branch"],
    });
    expect(saved.integrityHash).toMatch(/^[a-f0-9]{64}$/);
    const loaded = loadRepairProfile("default");
    expect(loaded.repo).toBe("github.com/acme/repo");
    const reused = reuseRepairProfile("default", {
      ...IDENTITY,
      capabilities: ["push-source-branch"],
    });
    expect(reused.integrityHash).toBe(saved.integrityHash);
    const grant = createRepairGrant(reused);
    expect(verifyRepairGrant(grant, reused, { now: new Date().toISOString() }).ok).toBe(true);
    const grantPath = join(home, "runs", "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3");
    mkdirSync(grantPath, { recursive: true });
    writeFileSync(join(grantPath, "repair-grant.json"), `${JSON.stringify(grant, null, 2)}\n`);
    expect(JSON.parse(readFileSync(join(grantPath, "repair-grant.json"), "utf8")).grantHash).toBe(
      grant.grantHash,
    );
  });

  it("rejects path-shaped profile names", () => {
    expect(() =>
      saveRepairProfile({
        name: "../etc",
        ...IDENTITY,
        capabilities: ["push-source-branch"],
      }),
    ).toThrow(CliError);
  });

  it("rejects reuse when the source branch or base has drifted", () => {
    saveRepairProfile({
      name: "default",
      ...IDENTITY,
      capabilities: ["push-source-branch"],
    });
    expect(() =>
      reuseRepairProfile("default", {
        ...IDENTITY,
        sourceBranch: "feat-y",
        capabilities: ["push-source-branch"],
      }),
    ).toThrow(/source branch|identity/i);
  });

  it("rejects reuse after revoke or expiry", () => {
    saveRepairProfile({
      name: "default",
      ...IDENTITY,
      capabilities: ["push-source-branch"],
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(() =>
      reuseRepairProfile("default", {
        ...IDENTITY,
        capabilities: ["push-source-branch"],
      }),
    ).toThrow(/expired|revoked/i);
    saveRepairProfile({
      name: "live",
      ...IDENTITY,
      capabilities: ["push-source-branch"],
    });
    revokeRepairProfile("live");
    expect(() =>
      reuseRepairProfile("live", {
        ...IDENTITY,
        capabilities: ["push-source-branch"],
      }),
    ).toThrow(/revoked/i);
  });

  it("refuses a grant when the profile hash no longer matches", () => {
    const profile = saveRepairProfile({
      name: "default",
      ...IDENTITY,
      capabilities: ["push-source-branch"],
    });
    const grant = createRepairGrant(profile);
    const tampered = { ...profile, integrityHash: "0".repeat(64) };
    expect(verifyRepairGrant(grant, tampered, { now: new Date().toISOString() }).ok).toBe(false);
  });
});
