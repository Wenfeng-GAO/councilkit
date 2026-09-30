import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writerLeaseKey, writerLeasePath } from "@shared/runtime/repair-lease";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireWriterLease, releaseWriterLease } from "../src/auto/repair-lease";
import { CliError } from "../src/errors";

describe("writer lease CAS", () => {
  let home: string;
  let previous: string | undefined;
  const key = writerLeaseKey({ repo: "github.com/acme/repo", sourceBranch: "feat-x" });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-repair-lease-"));
    previous = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
    else process.env.COUNCILKIT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it("lets the same holder re-enter and returns the existing run id", () => {
    const first = acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "repair",
      holderRunId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
      pid: process.pid,
    });
    const again = acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "repair",
      holderRunId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
      pid: process.pid,
    });
    expect(again.holderRunId).toBe(first.holderRunId);
    expect(again.epoch).toBe(first.epoch);
    expect(writerLeasePath(home, key)).toContain("locks/");
  });

  it("rejects a second live writer on the same branch", () => {
    acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "repair",
      holderRunId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
      pid: process.pid,
    });
    expect(() =>
      acquireWriterLease({
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        holderKind: "apply",
        holderRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        pid: process.pid,
      }),
    ).toThrow(CliError);
  });

  it("does not reclaim a dead pid without journal and remote checks", () => {
    acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "fix",
      holderRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      pid: 999_999_999,
    });
    expect(() =>
      acquireWriterLease({
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        holderKind: "apply",
        holderRunId: "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        pid: process.pid,
      }),
    ).toThrow(/journal|remote|stale/i);
  });

  it("reclaims a dead pid only after journal and remote checks", () => {
    acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "fix",
      holderRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      pid: 999_999_999,
    });
    const reclaimed = acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "apply",
      holderRunId: "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
      pid: process.pid,
      reclaim: { journalChecked: true, remoteChecked: true },
    });
    expect(reclaimed.epoch).toBeGreaterThan(1);
  });

  it("reclaims a dead pid only after journal and remote checks", () => {
    acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "fix",
      holderRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      pid: 999_999_999,
    });
    const reclaimed = acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "apply",
      holderRunId: "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
      pid: process.pid,
      reclaim: { journalChecked: true, remoteChecked: true },
    });
    expect(reclaimed.epoch).toBeGreaterThan(1);
  });

  it("takes over a dead lease whose repair holder reached a terminal business result", () => {
    const holderId = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";
    const runDir = join(home, "runs", holderId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "repair.json"),
      `${JSON.stringify({
        version: 1,
        casVersion: 0,
        sourceRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        profileName: "default",
        outerUsed: 1,
        outerMax: 10,
        timeoutMs: null,
        businessResult: "needs_attention",
        reasonCode: "findings_open",
      })}\n`,
    );
    acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "repair",
      holderRunId: holderId,
      pid: 999_999_999,
    });
    const taken = acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "fix",
      holderRunId: "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
      pid: process.pid,
    });
    expect(taken.holderRunId).toBe("ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2");
    expect(taken.epoch).toBeGreaterThan(1);
  });

  it("keeps refusing a dead lease whose repair holder has no terminal business result", () => {
    const holderId = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";
    const runDir = join(home, "runs", holderId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "repair.json"),
      `${JSON.stringify({
        version: 1,
        casVersion: 0,
        sourceRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        profileName: "default",
        outerUsed: 0,
        outerMax: 10,
        timeoutMs: null,
        businessResult: null,
        reasonCode: null,
      })}\n`,
    );
    acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "repair",
      holderRunId: holderId,
      pid: 999_999_999,
    });
    expect(() =>
      acquireWriterLease({
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        holderKind: "apply",
        holderRunId: "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        pid: process.pid,
      }),
    ).toThrow(/journal|remote|stale/i);
  });

  it("refuses to release while an extra writer pid is still alive", () => {
    const child = process.pid;
    acquireWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderKind: "apply",
      holderRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      pid: process.pid,
      writerPids: [child],
    });
    expect(() =>
      releaseWriterLease({
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        holderRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      }),
    ).toThrow(/writer|alive|pid/i);
    releaseWriterLease({
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      holderRunId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      isPidAlive: () => false,
    });
  });
});
