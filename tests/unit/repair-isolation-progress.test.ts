import {
  assertIsolationMode,
  assertSquadPipelineIsolation,
  isolationLabel,
  probeIsolationCapability,
  sandboxProfile,
} from "@shared/runtime/repair-isolation";
import {
  classifyFailure,
  countsAsRootCauseFailure,
  recordRootCauseFailure,
  recoveryActionFor,
  shouldEnterDiagnosis,
} from "@shared/runtime/repair-progress";
import { describe, expect, it } from "vitest";

describe("isolation capability", () => {
  it("refuses strong mode when sandbox-exec is missing", () => {
    const capability = probeIsolationCapability("darwin", false);
    expect(capability.canDenyPublish).toBe(false);
    const result = assertIsolationMode("strong", capability);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/collaborative mode must be chosen explicitly/i);
  });

  it("accepts collaborative mode only as an explicit choice", () => {
    const capability = probeIsolationCapability("linux", false);
    expect(assertIsolationMode("collaborative", capability)).toEqual({ ok: true });
    expect(isolationLabel("collaborative")).toMatch(/协作约定/);
  });

  it("refuses full Squad pipeline strong even when Darwin sandbox-exec exists", () => {
    const capability = probeIsolationCapability("darwin", true);
    expect(capability.canDenyPublish).toBe(false);
    expect(assertIsolationMode("strong", capability).ok).toBe(true);
    expect(assertSquadPipelineIsolation("strong").ok).toBe(false);
    expect(assertSquadPipelineIsolation("collaborative").ok).toBe(true);
  });

  it("emits a sandbox profile that denies credentials, control-plane writes, and network", () => {
    const profile = sandboxProfile({
      worktree: "/tmp/candidate",
      outputDir: "/tmp/out",
      tmpDir: "/tmp/tmp",
      credentialHome: "/tmp/secrets",
    });
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(regex #"/.ssh/")');
    expect(profile).toContain('(regex #"/.config/gh/")');
    expect(profile).not.toContain("string-append");
    expect(profile).toContain('(allow file-write* (subpath "/tmp/candidate"))');
    expect(profile).not.toContain('(allow file-write* (regex #"^/tmp/"))');
  });

  it("can allow network for the builder while still denying credential reads", () => {
    const profile = sandboxProfile({
      worktree: "/tmp/candidate",
      outputDir: "/tmp/out",
      tmpDir: "/tmp/tmp",
      allowNetwork: true,
      credentialHome: "/tmp/secrets",
    });
    expect(profile).toContain("(allow network*)");
    expect(profile).toContain('(regex #"/.config/gh/")');
    expect(profile).not.toContain('(allow file-write* (regex #"^/tmp/"))');
  });
});

describe("failure routing", () => {
  it("does not count format or environment faults as the same root-cause failure", () => {
    expect(countsAsRootCauseFailure(classifyFailure({ formatFault: true }))).toBe(false);
    expect(countsAsRootCauseFailure(classifyFailure({ environmentFault: true }))).toBe(false);
    expect(countsAsRootCauseFailure(classifyFailure({ sourceFixFailed: true }))).toBe(true);
  });

  it("enters diagnosis only after two valid source-fix failures of the same root cause", () => {
    const once = recordRootCauseFailure([], "ready-recovery", "still open");
    expect(shouldEnterDiagnosis(once, "ready-recovery")).toBe(false);
    const twice = recordRootCauseFailure(once, "ready-recovery", "still open again");
    expect(shouldEnterDiagnosis(twice, "ready-recovery")).toBe(true);
    expect(shouldEnterDiagnosis(twice, "other-cause")).toBe(false);
  });

  it("maps reason codes to matching recovery actions", () => {
    expect(recoveryActionFor("coverage_gap")).toMatch(/补证/);
    expect(recoveryActionFor("same_root_cause")).toMatch(/只读诊断/);
    expect(recoveryActionFor("pr_drift")).toMatch(/不盲目重发/);
  });
});
