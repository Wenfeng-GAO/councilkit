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

  it("accepts a passing log that only mentions the word skip", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-skip-word-"));
    homes.push(root);
    const sha = "1".repeat(40);
    const cacheKey = verificationCacheKey({
      snapshotSha: sha,
      assertionVersion: "A1",
      testAssetVersion: "tests-v1",
    });
    const receiptFor = (name: string, command: string, stdout: string) => {
      const logPath = join(root, name);
      writeCommandLog(logPath, {
        exitCode: 0,
        stdout,
        stderr: "",
        snapshotSha: sha,
        cwd: root,
        dirtyTree: false,
        cacheKey,
        command,
      });
      const receipt = receiptFromIsolatedLog({
        assertionId: "A1",
        command,
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

    const named = receiptFor(
      "node-skip-word.log",
      "node --test",
      [
        "TAP version 13",
        "# Subtest: do not skip a warm cache",
        "ok 1 - do not skip a warm cache",
        "1..1",
        "# tests 1",
        "# suites 0",
        "# pass 1",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
        "",
      ].join("\n"),
    );
    expect(named.receipts[0]?.skipped).toBe(false);
    expect(evaluateVerificationAsset(named, "A1")).toEqual({ ok: true, reason: "verified" });

    const logged = receiptFor(
      "go-skip-word.log",
      "go test ./ready",
      [
        "=== RUN   TestReady",
        "    ready_test.go:4: skip optional lookup",
        "--- PASS: TestReady (0.00s)",
        "PASS",
        "ok  \texample.com/ready\t0.01s",
        "",
      ].join("\n"),
    );
    expect(logged.receipts[0]?.skipped).toBe(false);
    expect(evaluateVerificationAsset(logged, "A1")).toEqual({ ok: true, reason: "verified" });
  });

  it("does not treat a cargo ignored test as proof", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-cargo-ignored-"));
    homes.push(root);
    const sha = "d".repeat(40);
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
        command: "cargo test",
      });
      const receipt = receiptFromIsolatedLog({
        assertionId: "A1",
        command: "cargo test",
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

    const prose = receiptFor(
      "cargo-ignored-word.log",
      [
        "running 1 test",
        "test tests::ok ... ok",
        "ignored the stale cache",
        "",
        "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
        "",
      ].join("\n"),
    );
    expect(prose.receipts[0]?.skipped).toBe(false);
    expect(evaluateVerificationAsset(prose, "A1")).toEqual({ ok: true, reason: "verified" });

    const mixed = receiptFor(
      "cargo-ignored.log",
      [
        "running 2 tests",
        "test tests::kept ... ok",
        "test tests::later ... ignored",
        "",
        "test result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s",
        "",
      ].join("\n"),
    );
    expect(mixed.receipts[0]?.failed).toBe(false);
    expect(mixed.receipts[0]?.skipped).toBe(true);
    expect(evaluateVerificationAsset(mixed, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });

    const only = receiptFor(
      "cargo-only-ignored.log",
      [
        "running 1 test",
        "test tests::later ... ignored, needs a fixture",
        "",
        "test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s",
        "",
      ].join("\n"),
    );
    expect(only.receipts[0]?.ranZeroTests).toBe(false);
    expect(only.receipts[0]?.skipped).toBe(true);
    expect(evaluateVerificationAsset(only, "A1")).toEqual({
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
        "\t<!-- pass 1 -->",
        "\t<!-- fail 0 -->",
        "\t<!-- cancelled 0 -->",
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

  it("accepts a passing node:test log whose title contains a todo count", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-todo-name-"));
    homes.push(root);
    const sha = "e".repeat(40);
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

    const tapName = receiptFor(
      "todo-name-tap.log",
      [
        "TAP version 13",
        "# Subtest: todo 1 stays open",
        "ok 1 - todo 1 stays open",
        "1..1",
        "# tests 1",
        "# pass 1",
        "# fail 0",
        "# skipped 0",
        "# todo 0",
        "",
      ].join("\n"),
    );
    expect(tapName.receipts[0]?.skipped).toBe(false);
    expect(tapName.receipts[0]?.ranZeroTests).toBe(false);
    expect(evaluateVerificationAsset(tapName, "A1")).toEqual({ ok: true, reason: "verified" });

    const reverseName = receiptFor(
      "todo-name-reverse.log",
      [
        "# Subtest: records 1 todo for later",
        "ok 1 - records 1 todo for later",
        "# tests 1",
        "# pass 1",
        "# fail 0",
        "# skipped 0",
        "# todo 0",
        "",
      ].join("\n"),
    );
    expect(reverseName.receipts[0]?.skipped).toBe(false);
    expect(evaluateVerificationAsset(reverseName, "A1")).toEqual({ ok: true, reason: "verified" });

    const coloredTodo = receiptFor(
      "todo-colored.log",
      "\u001b[34mℹ tests 1\u001b[39m\n\u001b[34mℹ todo 1\u001b[39m\n",
    );
    expect(coloredTodo.receipts[0]?.skipped).toBe(true);
    expect(evaluateVerificationAsset(coloredTodo, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });

    const junitTodo = receiptFor(
      "todo-junit.log",
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<testsuites>",
        '\t<testcase name="later" time="0.000111" classname="test"/>',
        "\t<!-- todo 1 -->",
        "</testsuites>",
        "",
      ].join("\n"),
    );
    expect(junitTodo.receipts[0]?.skipped).toBe(true);
    expect(evaluateVerificationAsset(junitTodo, "A1")).toEqual({
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
      [
        "go-json.log",
        [
          '{"Action":"output","Package":"example.com/ready","Test":"TestReady","Output":"--- FAIL: TestReady (0.00s)\\n"}',
          '{"Action":"fail","Package":"example.com/ready","Test":"TestReady","Elapsed":0}',
          '{"Action":"fail","Package":"example.com/ready","Elapsed":0}',
          "",
        ].join("\n"),
      ],
      ["jest-suites.log", "Test Suites: 1 failed, 1 total\n"],
      ["jest-tests.log", "Tests:       1 failed, 4 passed, 5 total\n"],
      ["vitest-files.log", " Test Files  1 failed (1)\n"],
      ["vitest-tests.log", "      Tests  1 failed | 4 passed (5)\n"],
      [
        "pytest-summary.log",
        [
          "=================================== FAILURES ===================================",
          "__________________________________ test_bar ___________________________________",
          "E   AssertionError: boom",
          "=========================== short test summary info ============================",
          "FAILED test_foo.py::test_bar - AssertionError: boom",
          "========================= 1 failed, 1 passed in 0.12s =========================",
          "",
        ].join("\n"),
      ],
      [
        "pytest-count.log",
        "========================= 1 failed, 1 passed in 0.12s =========================\n",
      ],
      ["pytest-failed-line.log", "FAILED test_foo.py::test_bar - AssertionError: boom\n"],
      [
        "pytest-color.log",
        "\u001b[31mFAILED\u001b[0m test_foo.py::test_bar - AssertionError: boom\n",
      ],
      [
        "pytest-error-summary.log",
        [
          "==================================== ERRORS ====================================",
          "_________________________ ERROR at setup of test_bar __________________________",
          "E   RuntimeError: boom",
          "=========================== short test summary info ============================",
          "ERROR test_foo.py::test_bar - RuntimeError: boom",
          "============================== 1 error in 0.03s ===============================",
          "",
        ].join("\n"),
      ],
      [
        "pytest-errors-count.log",
        "============================== 2 errors in 0.03s ==============================\n",
      ],
      ["pytest-error-line.log", "ERROR test_foo.py::test_bar - RuntimeError: boom\n"],
      [
        "pytest-quiet-error.log",
        [
          "ERROR test_syntax.py",
          "!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!",
          "1 error in 0.11s",
          "",
        ].join("\n"),
      ],
      [
        "junit-fail.log",
        [
          '<?xml version="1.0" encoding="utf-8"?>',
          "<testsuites>",
          '\t<testcase name="boom" time="0.000933" classname="test" failure="Expected values to be strictly equal:1 !== 2">',
          '\t\t<failure type="testCodeFailure" message="Expected values to be strictly equal:1 !== 2">',
          "\t\t</failure>",
          "\t</testcase>",
          "\t<!-- tests 1 -->",
          "\t<!-- suites 0 -->",
          "\t<!-- pass 0 -->",
          "\t<!-- fail 1 -->",
          "\t<!-- cancelled 0 -->",
          "\t<!-- skipped 0 -->",
          "\t<!-- todo 0 -->",
          "</testsuites>",
          "",
        ].join("\n"),
      ],
      [
        "junit-cancelled.log",
        ["\t<!-- tests 1 -->", "\t<!-- fail 0 -->", "\t<!-- cancelled 1 -->", ""].join("\n"),
      ],
      [
        "dot-fail.log",
        [
          "X",
          "",
          "Failed tests:",
          "",
          "✖ boom (0.916664ms)",
          "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
          "",
        ].join("\n"),
      ],
      [
        "playwright-fail.log",
        [
          "Running 2 tests using 1 worker",
          "",
          "  ✘  1 example.spec.ts:3:1 › example fails (5ms)",
          "  ✓  2 example.spec.ts:8:1 › example passes (2ms)",
          "",
          "  1) example.spec.ts:3:1 › example fails ────────────────────────────────────────────",
          "",
          "    Error: expect(received).toBe(expected)",
          "",
          "    Expected: 1",
          "    Received: 2",
          "",
          "  1 failed",
          "  1 passed (1.2s)",
          "",
        ].join("\n"),
      ],
      [
        "playwright-color-fail.log",
        [
          "\u001b[31m  1 failed\u001b[39m",
          "\u001b[31m    [chromium] › example.spec.ts:3:1 › example fails\u001b[39m",
          "\u001b[32m  1 passed\u001b[39m\u001b[2m (1.2s)\u001b[22m",
          "",
        ].join("\n"),
      ],
      [
        "cargo-fail.log",
        [
          "running 1 test",
          "test tests::boom ... FAILED",
          "",
          "failures:",
          "",
          "---- tests::boom stdout ----",
          "thread 'tests::boom' panicked at src/lib.rs:4:17:",
          "assertion `left == right` failed",
          "  left: 1",
          " right: 2",
          "",
          "failures:",
          "    tests::boom",
          "",
          "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
          "",
          "error: test failed, to rerun pass `--lib`",
          "",
        ].join("\n"),
      ],
    ] as const;
    for (const [name, stdout] of failing) {
      expect([name, evaluateVerificationAsset(receiptFor(name, stdout), "A1")]).toEqual([
        name,
        { ok: false, reason: "failing tests cannot prove pass" },
      ]);
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

    const goJsonPass = receiptFor(
      "go-json-pass.log",
      [
        '{"Action":"output","Package":"example.com/ready","Test":"TestReady","Output":"    ready_test.go:4: {\\"Action\\":\\"fail\\"}\\n"}',
        '{"Action":"pass","Package":"example.com/ready","Test":"TestReady","Elapsed":0}',
        '{"Action":"pass","Package":"example.com/ready","Elapsed":0}',
        "",
      ].join("\n"),
    );
    expect(evaluateVerificationAsset(goJsonPass, "A1")).toEqual({ ok: true, reason: "verified" });

    const pytestPass = receiptFor(
      "pytest-pass.log",
      [
        "============================= test session starts ==============================",
        "collected 1 item",
        "",
        "test_foo.py .                                                            [100%]",
        "",
        "============================== 1 passed in 0.01s ===============================",
        "",
      ].join("\n"),
    );
    expect(evaluateVerificationAsset(pytestPass, "A1")).toEqual({ ok: true, reason: "verified" });

    const pytestErrorWord = receiptFor(
      "pytest-error-word.log",
      [
        "ERROR ready",
        "============================== 1 xfailed, 1 passed in 0.01s ==============================",
        "",
      ].join("\n"),
    );
    expect(evaluateVerificationAsset(pytestErrorWord, "A1")).toEqual({
      ok: true,
      reason: "verified",
    });

    const junitZeroFail = receiptFor(
      "junit-zero-fail.log",
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<testsuites>",
        '\t<testcase name="ok" time="0.000423" classname="test"/>',
        "\t<!-- tests 1 -->",
        "\t<!-- pass 1 -->",
        "\t<!-- fail 0 -->",
        "\t<!-- cancelled 0 -->",
        "\t<!-- skipped 0 -->",
        "</testsuites>",
        "",
      ].join("\n"),
    );
    expect(evaluateVerificationAsset(junitZeroFail, "A1")).toEqual({
      ok: true,
      reason: "verified",
    });

    const dotPass = receiptFor("dot-pass.log", ".\n");
    expect(evaluateVerificationAsset(dotPass, "A1")).toEqual({ ok: true, reason: "verified" });

    const cargoPass = receiptFor(
      "cargo-pass.log",
      [
        "running 1 test",
        "test tests::ok ... ok",
        "",
        "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
        "",
      ].join("\n"),
    );
    expect(evaluateVerificationAsset(cargoPass, "A1")).toEqual({ ok: true, reason: "verified" });

    const playwrightPass = receiptFor(
      "playwright-pass.log",
      [
        "Running 1 test using 1 worker",
        "",
        "  ✓  1 example.spec.ts:8:1 › example passes (2ms)",
        "",
        "  1 passed (0.4s)",
        "",
      ].join("\n"),
    );
    expect(evaluateVerificationAsset(playwrightPass, "A1")).toEqual({
      ok: true,
      reason: "verified",
    });

    const recoveredSentence = receiptFor(
      "recovered-fail-sentence.log",
      [
        "# tests 1",
        "# pass 1",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
        "1 failed to open the cache, then recovered",
        "",
      ].join("\n"),
    );
    expect(evaluateVerificationAsset(recoveredSentence, "A1")).toEqual({
      ok: true,
      reason: "verified",
    });
  });

  it("accepts a go test log that also lists a package with no test files", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-go-"));
    homes.push(root);
    const sha = "c".repeat(40);
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
        command: "go test ./...",
      });
      const receipt = receiptFromIsolatedLog({
        assertionId: "A1",
        command: "go test ./...",
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

    const mixed = receiptFor(
      "go-mixed.log",
      ["ok  \texample.com/ready\t0.012s", "?   \texample.com/util\t[no test files]", ""].join("\n"),
    );
    expect(mixed.receipts[0]?.ranZeroTests).toBe(false);
    expect(mixed.receipts[0]?.skipped).toBe(false);
    expect(evaluateVerificationAsset(mixed, "A1")).toEqual({ ok: true, reason: "verified" });

    const only = receiptFor("go-no-files.log", "?   \texample.com/util\t[no test files]\n");
    expect(only.receipts[0]?.ranZeroTests).toBe(true);
    expect(evaluateVerificationAsset(only, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });
  });

  it("accepts a go test -json log that also skips a package with no test files", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-cand-go-json-"));
    homes.push(root);
    const sha = "d".repeat(40);
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
        command: "go test -json ./...",
      });
      const receipt = receiptFromIsolatedLog({
        assertionId: "A1",
        command: "go test -json ./...",
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

    const mixed = receiptFor(
      "go-json-mixed.log",
      [
        '{"Action":"output","Package":"example.com/util","Output":"?   \\texample.com/util\\t[no test files]\\n"}',
        '{"Action":"skip","Package":"example.com/util","Elapsed":0}',
        '{"Action":"run","Package":"example.com/ready","Test":"TestReady"}',
        '{"Action":"pass","Package":"example.com/ready","Test":"TestReady","Elapsed":0}',
        '{"Action":"pass","Package":"example.com/ready","Elapsed":0}',
        "",
      ].join("\n"),
    );
    expect(mixed.receipts[0]?.ranZeroTests).toBe(false);
    expect(mixed.receipts[0]?.skipped).toBe(false);
    expect(evaluateVerificationAsset(mixed, "A1")).toEqual({ ok: true, reason: "verified" });

    const only = receiptFor(
      "go-json-no-files.log",
      [
        '{"Action":"output","Package":"example.com/util","Output":"?   \\texample.com/util\\t[no test files]\\n"}',
        '{"Action":"skip","Package":"example.com/util","Elapsed":0}',
        "",
      ].join("\n"),
    );
    expect(evaluateVerificationAsset(only, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });

    const skippedTest = receiptFor(
      "go-json-skip-test.log",
      [
        '{"Action":"skip","Package":"example.com/ready","Test":"TestLater","Elapsed":0}',
        '{"Action":"pass","Package":"example.com/ready","Test":"TestReady","Elapsed":0}',
        '{"Action":"pass","Package":"example.com/ready","Elapsed":0}',
        "",
      ].join("\n"),
    );
    expect(evaluateVerificationAsset(skippedTest, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });

    const skippedBesideGap = receiptFor(
      "go-json-skip-beside-gap.log",
      [
        '{"Action":"output","Package":"example.com/util","Output":"?   \\texample.com/util\\t[no test files]\\n"}',
        '{"Action":"skip","Package":"example.com/util","Elapsed":0}',
        '{"Action":"skip","Package":"example.com/ready","Test":"TestLater","Elapsed":0}',
        '{"Action":"pass","Package":"example.com/ready","Test":"TestReady","Elapsed":0}',
        '{"Action":"pass","Package":"example.com/ready","Elapsed":0}',
        "",
      ].join("\n"),
    );
    expect(evaluateVerificationAsset(skippedBesideGap, "A1")).toEqual({
      ok: false,
      reason: "zero tests or skipped tests cannot prove pass",
    });
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
