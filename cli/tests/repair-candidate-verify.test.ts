import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateVerificationAsset } from "@shared/runtime/repair-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_EXTRA_PROBE_MANIFEST,
  bindCodeTraceAsset,
  ensureCandidateSnapshot,
  extraProbeManifestVersion,
  hashTestAssetContents,
  inspectCandidateSnapshot,
  receiptFromIsolatedLog,
  verificationCacheKey,
  writeCommandLog,
} from "../src/auto/repair-candidate-verify";

let homes: string[] = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("candidate snapshot and verification cache", () => {
  it("measures HEAD and dirtyTree instead of filling them in", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-"));
    homes.push(root);
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "cand@example.com"]);
    git(root, ["config", "user.name", "cand"]);
    writeFileSync(join(root, "ok.txt"), "a\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "a"]);
    const sha = git(root, ["rev-parse", "HEAD"]);
    const clean = await inspectCandidateSnapshot({ cwd: root, expectedSha: sha });
    expect(clean).toMatchObject({ ok: true, head: sha.toLowerCase(), dirtyTree: false });
    writeFileSync(join(root, "ok.txt"), "dirty\n");
    const dirty = await inspectCandidateSnapshot({ cwd: root, expectedSha: sha });
    expect(dirty).toMatchObject({ ok: true, dirtyTree: true });
    const missing = await inspectCandidateSnapshot({
      cwd: join(root, "nope"),
      expectedSha: sha,
    });
    expect(missing.ok).toBe(false);
  });

  it("does not reuse a cache key across SHA or test asset versions", () => {
    const sha = "a".repeat(40);
    const other = "b".repeat(40);
    const v1 = hashTestAssetContents(["go test ./..."]);
    const v2 = hashTestAssetContents(["go test ./ready"]);
    expect(
      verificationCacheKey({ snapshotSha: sha, assertionVersion: "A-1-v1", testAssetVersion: v1 }),
    ).not.toBe(
      verificationCacheKey({
        snapshotSha: other,
        assertionVersion: "A-1-v1",
        testAssetVersion: v1,
      }),
    );
    expect(
      verificationCacheKey({ snapshotSha: sha, assertionVersion: "A-1-v1", testAssetVersion: v1 }),
    ).not.toBe(
      verificationCacheKey({ snapshotSha: sha, assertionVersion: "A-1-v1", testAssetVersion: v2 }),
    );
    expect(extraProbeManifestVersion([])).toBe(EMPTY_EXTRA_PROBE_MANIFEST);
  });

  it("keeps code_trace on the required acceptance path without forging a command", () => {
    const sha = "c".repeat(40);
    const asset = bindCodeTraceAsset({
      assertionId: "A-F-1-v1",
      snapshotSha: sha,
      locations: ["src/a.ts:1"],
      reviewer: "review-correctness",
      runId: "ck-review-1",
      testAssetVersion: hashTestAssetContents(["src/a.ts:1"]),
    });
    expect(asset?.kind).toBe("code_trace");
    expect(asset?.receipts[0]?.command).toBeUndefined();
    expect(asset?.receipts[0]?.executionSource).toBe("independent-reviewer-trace");
    expect(asset ? evaluateVerificationAsset(asset, "A-F-1-v1").ok : false).toBe(true);
  });

  it("checks out a detached candidate snapshot when source HEAD differs", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-wt-"));
    homes.push(root);
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "cand@example.com"]);
    git(root, ["config", "user.name", "cand"]);
    writeFileSync(join(root, "ok.txt"), "source\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "source"]);
    const sourceSha = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(join(root, "ready.txt"), "ok\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "candidate"]);
    const candidateSha = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", sourceSha]);
    expect(candidateSha).not.toBe(sourceSha);
    const snapshot = await ensureCandidateSnapshot({
      sourceCwd: root,
      candidateSha,
      snapshotRoot: join(root, "snaps"),
    });
    expect(snapshot).toMatchObject({
      ok: true,
      head: candidateSha.toLowerCase(),
      dirtyTree: false,
    });
    if (!snapshot.ok) throw new Error(snapshot.reason);
    expect(snapshot.cwd).not.toBe(root);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(sourceSha);
  });

  it("does not relabel an old command log as a new cache key or asset version", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-cache-"));
    homes.push(root);
    const sha = "c".repeat(40);
    const oldKey = verificationCacheKey({
      snapshotSha: sha,
      assertionVersion: "A1",
      testAssetVersion: "old-version",
    });
    const newKey = verificationCacheKey({
      snapshotSha: sha,
      assertionVersion: "A1",
      testAssetVersion: "new-version",
    });
    const logPath = join(root, "verify.log");
    writeCommandLog(logPath, {
      exitCode: 0,
      stdout: "1 tests passed\n",
      stderr: "",
      snapshotSha: sha,
      cwd: root,
      dirtyTree: false,
      cacheKey: oldKey,
      command: "go test ./ready",
    });
    const receipt = receiptFromIsolatedLog({
      assertionId: "A1",
      command: "different command",
      cwd: root,
      snapshotSha: sha,
      dirtyTree: false,
      testAssetVersion: "new-version",
      logPath,
      cacheKey: newKey,
    });
    expect(receipt).toBeNull();
  });

  it("measures dirtyTree after a command mutates tracked source", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-mut-"));
    homes.push(root);
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "cand@example.com"]);
    git(root, ["config", "user.name", "cand"]);
    writeFileSync(join(root, "ok.txt"), "a\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "a"]);
    const sha = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(join(root, "ok.txt"), "mutated\n");
    const after = await inspectCandidateSnapshot({ cwd: root, expectedSha: sha });
    expect(after).toMatchObject({ ok: true, dirtyTree: true, head: sha.toLowerCase() });
  });
});
