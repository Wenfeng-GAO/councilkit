import { mkdtempSync, rmSync } from "node:fs";
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
