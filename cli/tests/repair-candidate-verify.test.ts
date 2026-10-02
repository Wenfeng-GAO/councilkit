import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerFinding } from "@shared/runtime/cli-ledger";
import { evaluateVerificationAsset } from "@shared/runtime/repair-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_EXTRA_PROBE_MANIFEST,
  bindCodeTraceAsset,
  codeTraceFromReview,
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

  it("binds a code trace to the full finding id when a shorter id is listed first", () => {
    const sha = "d".repeat(40);
    const traced = (id: string, location: string): LedgerFinding => ({
      id,
      severity: "major",
      status: "open",
      title: id,
      text: id,
      source: "consensus",
      reviewer: "review-correctness",
      files: [],
      verification: {
        outcome: "verified_closed",
        candidateSha: sha,
        runId: "ck-review-1",
        attemptId: "attempt-1",
        reviewer: "review-correctness",
        method: "code_trace",
        reason: "seen",
        evidence: "seen",
        locations: [location],
        runComplete: true,
      },
    });
    const findings = [
      traced("F-1", "src/short.ts:1"),
      traced("F-10", "src/long.ts:2"),
      traced("auth", "src/auth.ts:3"),
      traced("auth-2", "src/auth-2.ts:4"),
    ];
    expect(codeTraceFromReview(findings, "A-F-10-v1", sha)?.receipts[0]?.locations).toEqual([
      "src/long.ts:2",
    ]);
    expect(codeTraceFromReview(findings, "A-auth-2-v1", sha)?.receipts[0]?.locations).toEqual([
      "src/auth-2.ts:4",
    ]);
    expect(codeTraceFromReview(findings, "A-F-1-v1", sha)?.receipts[0]?.locations).toEqual([
      "src/short.ts:1",
    ]);
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

  it("accepts a silent exit-0 command whose log header is not command output", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-empty-"));
    homes.push(root);
    const sha = "d".repeat(40);
    const cacheKey = verificationCacheKey({
      snapshotSha: sha,
      assertionVersion: "A1",
      testAssetVersion: "tests-v1",
    });
    const logPath = join(root, "verify.log");
    writeCommandLog(logPath, {
      exitCode: 0,
      stdout: "",
      stderr: "",
      snapshotSha: sha,
      cwd: root,
      dirtyTree: false,
      cacheKey,
      command: "go test ./skip",
    });
    const receipt = receiptFromIsolatedLog({
      assertionId: "A1",
      command: "go test ./skip",
      cwd: root,
      snapshotSha: sha,
      dirtyTree: false,
      testAssetVersion: "tests-v1",
      logPath,
      cacheKey,
    });
    if (receipt === null) throw new Error("expected a receipt");
    expect(receipt.receipts[0]?.ranZeroTests).toBe(false);
    expect(receipt.receipts[0]?.skipped).toBe(false);
    expect(evaluateVerificationAsset(receipt, "A1")).toEqual({ ok: true, reason: "verified" });
  });

  it("reads skip and pass evidence from the command output, not the log header", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-body-"));
    homes.push(root);
    const sha = "e".repeat(40);
    const cacheKey = verificationCacheKey({
      snapshotSha: sha,
      assertionVersion: "A1",
      testAssetVersion: "tests-v1",
    });
    const logPath = join(root, "verify.log");
    writeCommandLog(logPath, {
      exitCode: 0,
      stdout: "ok  example.com/ready 0.02s\n",
      stderr: "",
      snapshotSha: sha,
      cwd: root,
      dirtyTree: false,
      cacheKey,
      command: "go test ./skip",
    });
    const passed = receiptFromIsolatedLog({
      assertionId: "A1",
      command: "go test ./skip",
      cwd: root,
      snapshotSha: sha,
      dirtyTree: false,
      testAssetVersion: "tests-v1",
      logPath,
      cacheKey,
    });
    if (passed === null) throw new Error("expected a receipt");
    expect(passed.receipts[0]?.ranZeroTests).toBe(false);
    expect(passed.receipts[0]?.skipped).toBe(false);
    expect(evaluateVerificationAsset(passed, "A1")).toEqual({ ok: true, reason: "verified" });

    const skippedPath = join(root, "skipped.log");
    writeCommandLog(skippedPath, {
      exitCode: 0,
      stdout: "--- SKIP: TestReady\nok  example.com/ready 0.02s\n",
      stderr: "",
      snapshotSha: sha,
      cwd: root,
      dirtyTree: false,
      cacheKey,
      command: "go test ./ready",
    });
    const skipped = receiptFromIsolatedLog({
      assertionId: "A1",
      command: "go test ./ready",
      cwd: root,
      snapshotSha: sha,
      dirtyTree: false,
      testAssetVersion: "tests-v1",
      logPath: skippedPath,
      cacheKey,
    });
    if (skipped === null) throw new Error("expected a receipt");
    expect(skipped.receipts[0]?.skipped).toBe(true);
    expect(evaluateVerificationAsset(skipped, "A1").ok).toBe(false);

    const zeroPath = join(root, "zero.log");
    writeCommandLog(zeroPath, {
      exitCode: 0,
      stdout: "0 tests\n",
      stderr: "",
      snapshotSha: sha,
      cwd: root,
      dirtyTree: false,
      cacheKey,
      command: "go test ./ready",
    });
    const zero = receiptFromIsolatedLog({
      assertionId: "A1",
      command: "go test ./ready",
      cwd: root,
      snapshotSha: sha,
      dirtyTree: false,
      testAssetVersion: "tests-v1",
      logPath: zeroPath,
      cacheKey,
    });
    if (zero === null) throw new Error("expected a receipt");
    expect(zero.receipts[0]?.ranZeroTests).toBe(true);
    expect(evaluateVerificationAsset(zero, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });
  });

  it("reads node:test summaries by skip count and test count", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-node-"));
    homes.push(root);
    const sha = "f".repeat(40);
    const cacheKey = verificationCacheKey({
      snapshotSha: sha,
      assertionVersion: "A1",
      testAssetVersion: "tests-v1",
    });
    const receiptFor = (name: string, stdout: string) => {
      const logPath = join(root, name);
      writeCommandLog(logPath, {
        exitCode: 0,
        stdout,
        stderr: "",
        snapshotSha: sha,
        cwd: root,
        dirtyTree: false,
        cacheKey,
        command: "node --test",
      });
      const receipt = receiptFromIsolatedLog({
        assertionId: "A1",
        command: "node --test",
        cwd: root,
        snapshotSha: sha,
        dirtyTree: false,
        testAssetVersion: "tests-v1",
        logPath,
        cacheKey,
      });
      if (receipt === null) throw new Error(`expected a receipt for ${name}`);
      return receipt;
    };

    const tapPass = receiptFor(
      "tap-pass.log",
      [
        "TAP version 13",
        "# Subtest: adds",
        "ok 1 - adds",
        "1..1",
        "# tests 1",
        "# suites 0",
        "# pass 1",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
        "# duration_ms 49.29192",
        "",
      ].join("\n"),
    );
    expect(tapPass.receipts[0]?.skipped).toBe(false);
    expect(tapPass.receipts[0]?.ranZeroTests).toBe(false);
    expect(evaluateVerificationAsset(tapPass, "A1")).toEqual({ ok: true, reason: "verified" });

    const specPass = receiptFor(
      "spec-pass.log",
      [
        "✔ adds (0.639193ms)",
        "ℹ tests 1",
        "ℹ suites 0",
        "ℹ pass 1",
        "ℹ fail 0",
        "ℹ cancelled 0",
        "ℹ skipped 0",
        "ℹ todo 0",
        "ℹ duration_ms 47.320316",
        "",
      ].join("\n"),
    );
    expect(specPass.receipts[0]?.skipped).toBe(false);
    expect(specPass.receipts[0]?.ranZeroTests).toBe(false);
    expect(evaluateVerificationAsset(specPass, "A1")).toEqual({ ok: true, reason: "verified" });

    const jestPass = receiptFor(
      "jest-pass.log",
      "Test Suites: 1 passed, 1 total\nTests:       5 passed, 0 skipped, 5 total\n",
    );
    expect(jestPass.receipts[0]?.skipped).toBe(false);
    expect(jestPass.receipts[0]?.ranZeroTests).toBe(false);
    expect(evaluateVerificationAsset(jestPass, "A1")).toEqual({ ok: true, reason: "verified" });

    const tapEmpty = receiptFor(
      "tap-empty.log",
      [
        "TAP version 13",
        "1..0",
        "# tests 0",
        "# suites 0",
        "# pass 0",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
        "# duration_ms 5.803368",
        "",
      ].join("\n"),
    );
    expect(tapEmpty.receipts[0]?.skipped).toBe(false);
    expect(tapEmpty.receipts[0]?.ranZeroTests).toBe(true);
    expect(evaluateVerificationAsset(tapEmpty, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });

    const specEmpty = receiptFor(
      "spec-empty.log",
      [
        "ℹ tests 0",
        "ℹ suites 0",
        "ℹ pass 0",
        "ℹ fail 0",
        "ℹ cancelled 0",
        "ℹ skipped 0",
        "ℹ todo 0",
        "ℹ duration_ms 7.728986",
        "",
      ].join("\n"),
    );
    expect(specEmpty.receipts[0]?.skipped).toBe(false);
    expect(specEmpty.receipts[0]?.ranZeroTests).toBe(true);
    expect(evaluateVerificationAsset(specEmpty, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });

    const specSkip = receiptFor(
      "spec-skip.log",
      [
        "﹣ adds (0.796238ms) # SKIP",
        "✔ ok (0.253092ms)",
        "ℹ tests 2",
        "ℹ suites 0",
        "ℹ pass 1",
        "ℹ fail 0",
        "ℹ cancelled 0",
        "ℹ skipped 1",
        "ℹ todo 0",
        "ℹ duration_ms 48.51019",
        "",
      ].join("\n"),
    );
    expect(specSkip.receipts[0]?.skipped).toBe(true);
    expect(specSkip.receipts[0]?.ranZeroTests).toBe(false);
    expect(evaluateVerificationAsset(specSkip, "A1").ok).toBe(false);

    const junitPass = receiptFor(
      "junit-pass.log",
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<testsuites>",
        '\t<testcase name="a" time="0.000540" classname="test"/>',
        "\t<!-- tests 1 -->",
        "\t<!-- skipped 0 -->",
        "</testsuites>",
        "",
      ].join("\n"),
    );
    expect(junitPass.receipts[0]?.skipped).toBe(false);
    expect(junitPass.receipts[0]?.ranZeroTests).toBe(false);
    expect(evaluateVerificationAsset(junitPass, "A1")).toEqual({ ok: true, reason: "verified" });

    const coloredPass = receiptFor(
      "spec-color-pass.log",
      "\u001b[34mℹ tests 1\u001b[39m\n\u001b[34mℹ skipped 0\u001b[39m\n",
    );
    expect(coloredPass.receipts[0]?.skipped).toBe(false);
    expect(coloredPass.receipts[0]?.ranZeroTests).toBe(false);
    expect(evaluateVerificationAsset(coloredPass, "A1")).toEqual({ ok: true, reason: "verified" });

    const junitEmpty = receiptFor(
      "junit-empty.log",
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<testsuites>",
        "\t<!-- tests 0 -->",
        "\t<!-- skipped 0 -->",
        "</testsuites>",
        "",
      ].join("\n"),
    );
    expect(junitEmpty.receipts[0]?.skipped).toBe(false);
    expect(junitEmpty.receipts[0]?.ranZeroTests).toBe(true);
    expect(evaluateVerificationAsset(junitEmpty, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });

    const coloredEmpty = receiptFor(
      "spec-color-empty.log",
      "\u001b[34mℹ tests 0\u001b[39m\n\u001b[34mℹ skipped 0\u001b[39m\n",
    );
    expect(coloredEmpty.receipts[0]?.skipped).toBe(false);
    expect(coloredEmpty.receipts[0]?.ranZeroTests).toBe(true);
    expect(evaluateVerificationAsset(coloredEmpty, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });
  });

  it("does not treat a todo-only node:test log as proof", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-todo-"));
    homes.push(root);
    const sha = "a".repeat(40);
    const cacheKey = verificationCacheKey({
      snapshotSha: sha,
      assertionVersion: "A1",
      testAssetVersion: "tests-v1",
    });
    const logPath = join(root, "todo.log");
    writeCommandLog(logPath, {
      exitCode: 0,
      stdout: [
        "TAP version 13",
        "# Subtest: later",
        "not ok 1 - later # TODO",
        "1..1",
        "# tests 1",
        "# pass 0",
        "# fail 0",
        "# skipped 0",
        "# todo 1",
        "",
      ].join("\n"),
      stderr: "",
      snapshotSha: sha,
      cwd: root,
      dirtyTree: false,
      cacheKey,
      command: "node --test",
    });
    const receipt = receiptFromIsolatedLog({
      assertionId: "A1",
      command: "node --test",
      cwd: root,
      snapshotSha: sha,
      dirtyTree: false,
      testAssetVersion: "tests-v1",
      logPath,
      cacheKey,
    });
    if (receipt === null) throw new Error("expected a receipt");
    expect(receipt.receipts[0]?.skipped).toBe(true);
    expect(receipt.receipts[0]?.ranZeroTests).toBe(false);
    expect(evaluateVerificationAsset(receipt, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });
  });

  it("does not treat a failing summary with exit 0 as proof", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-fail-"));
    homes.push(root);
    const sha = "b".repeat(40);
    const cacheKey = verificationCacheKey({
      snapshotSha: sha,
      assertionVersion: "A1",
      testAssetVersion: "tests-v1",
    });
    const receiptFor = (name: string, stdout: string) => {
      const logPath = join(root, name);
      writeCommandLog(logPath, {
        exitCode: 0,
        stdout,
        stderr: "",
        snapshotSha: sha,
        cwd: root,
        dirtyTree: false,
        cacheKey,
        command: "node --test",
      });
      const receipt = receiptFromIsolatedLog({
        assertionId: "A1",
        command: "node --test",
        cwd: root,
        snapshotSha: sha,
        dirtyTree: false,
        testAssetVersion: "tests-v1",
        logPath,
        cacheKey,
      });
      if (receipt === null) throw new Error(`expected a receipt for ${name}`);
      return receipt;
    };
    const failing = [
      [
        "node-fail.log",
        ["# tests 2", "# pass 1", "# fail 1", "# cancelled 0", "# skipped 0", "# todo 0", ""].join(
          "\n",
        ),
      ],
      [
        "spec-fail.log",
        ["ℹ tests 2", "ℹ pass 1", "ℹ fail 1", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0", ""].join(
          "\n",
        ),
      ],
      [
        "cancelled.log",
        ["ℹ tests 1", "ℹ pass 0", "ℹ fail 0", "ℹ cancelled 1", "ℹ skipped 0", "ℹ todo 0", ""].join(
          "\n",
        ),
      ],
      ["colored-fail.log", "\u001b[31mℹ fail \u001b[39m\u001b[31m1\u001b[39m\n"],
      ["go-fail.log", "--- FAIL: TestReady (0.00s)\n"],
      ["go-status.log", "FAIL\n"],
      ["go-package-fail.log", "FAIL\texample.com/ready\t0.01s\n"],
      ["jest-suites.log", "Test Suites: 1 failed, 1 total\n"],
      ["jest-tests.log", "Tests:       1 failed, 4 passed, 5 total\n"],
      ["vitest-files.log", " Test Files  1 failed (1)\n"],
      ["vitest-tests.log", "      Tests  1 failed | 4 passed (5)\n"],
    ] as const;
    for (const [name, stdout] of failing) {
      expect(evaluateVerificationAsset(receiptFor(name, stdout), "A1")).toEqual({
        ok: false,
        reason: "failing tests cannot prove pass",
      });
    }
    const named = receiptFor(
      "named-fail.log",
      [
        "ok 1 - fail 1 open",
        "# tests 1",
        "# pass 1",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
        "",
      ].join("\n"),
    );
    expect(evaluateVerificationAsset(named, "A1")).toEqual({ ok: true, reason: "verified" });
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
