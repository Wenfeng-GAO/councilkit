import {
  isActiveRepairHolder,
  isRepairProfileName,
  parseWriterLease,
  writerLeaseKey,
} from "@shared/runtime/repair-lease";
import { describe, expect, it } from "vitest";

const LEASE = {
  version: 1 as const,
  key: "github.com/acme/repo#feat-x",
  holderKind: "repair" as const,
  holderRunId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
  pid: 4242,
  epoch: 1,
  grantedAt: "2026-09-20T00:00:00.000Z",
};

describe("writerLeaseKey", () => {
  it("joins normalized repo and source branch", () => {
    expect(writerLeaseKey({ repo: "github.com/Acme/Repo", sourceBranch: "feat/x" })).toBe(
      "github.com/acme/repo#feat/x",
    );
  });
});

describe("isRepairProfileName", () => {
  it("accepts a closed name and rejects path traversal", () => {
    expect(isRepairProfileName("default")).toBe(true);
    expect(isRepairProfileName("../etc/passwd")).toBe(false);
    expect(isRepairProfileName("/tmp/x")).toBe(false);
    expect(isRepairProfileName("")).toBe(false);
  });
});

describe("parseWriterLease", () => {
  it("reads a strict v1 lease object", () => {
    expect(parseWriterLease(`${JSON.stringify(LEASE)}\n`)).toEqual(LEASE);
  });

  it("rejects extra fields", () => {
    expect(parseWriterLease(JSON.stringify({ ...LEASE, authorized: true }))).toBeNull();
  });
});

describe("isActiveRepairHolder", () => {
  it("treats a running repair with a live pid and matching lease as active", () => {
    expect(
      isActiveRepairHolder({
        kind: "repair",
        status: "running",
        businessResult: null,
        lease: LEASE,
        pidAlive: true,
      }),
    ).toBe(true);
  });

  it("keeps an interrupted repair active while the lease is still held", () => {
    expect(
      isActiveRepairHolder({
        kind: "repair",
        status: "interrupted",
        businessResult: null,
        lease: LEASE,
        pidAlive: false,
      }),
    ).toBe(true);
  });

  it("is not active after a terminal business result", () => {
    expect(
      isActiveRepairHolder({
        kind: "repair",
        status: "completed",
        businessResult: "needs_attention",
        lease: LEASE,
        pidAlive: false,
      }),
    ).toBe(false);
  });

  it("is not active when running but the pid is dead and there is no lease", () => {
    expect(
      isActiveRepairHolder({
        kind: "repair",
        status: "running",
        businessResult: null,
        lease: null,
        pidAlive: false,
      }),
    ).toBe(false);
  });
});
