import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerFinding } from "@shared/runtime/cli-ledger";
import { canonicalJson } from "@shared/runtime/digest";
import {
  type AcceptanceMethod,
  type GoalContract,
  type VerificationAsset,
  interpretTestLog,
} from "@shared/runtime/repair-contract";
import { atomicWriteFile, atomicWriteJson } from "../store/atomic-write";
import { type RunCommand, defaultRunCommand } from "./checkout-pr";
import { detectIsolationCapability, runIsolatedCommand } from "./repair-isolated-run";

export const EMPTY_EXTRA_PROBE_MANIFEST = "empty-extra-probes:none";

export type CandidateSnapshot =
  | { ok: true; cwd: string; head: string; dirtyTree: boolean }
  | { ok: false; reason: string };

export interface OfficialEvidenceRow {
  evidenceId?: string;
  command?: unknown;
  cwd?: unknown;
  exitCode?: unknown;
  exit_code?: unknown;
  candidateSha?: unknown;
  candidate_sha?: unknown;
  stdoutHash?: unknown;
  stdout_hash?: unknown;
  source?: unknown;
}

export function hashTestAssetContents(contents: readonly string[]): string {
  return createHash("sha256")
    .update(canonicalJson([...contents]))
    .digest("hex");
}

export function verificationCacheKey(input: {
  snapshotSha: string;
  assertionVersion: string;
  testAssetVersion: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        snapshotSha: input.snapshotSha.toLowerCase(),
        assertionVersion: input.assertionVersion,
        testAssetVersion: input.testAssetVersion,
      }),
    )
    .digest("hex");
}

export async function ensureCandidateSnapshot(input: {
  sourceCwd: string;
  candidateSha: string;
  snapshotRoot: string;
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
}): Promise<CandidateSnapshot> {
  if (!/^[0-9a-f]{40}$/i.test(input.candidateSha)) {
    return { ok: false, reason: "candidate SHA is unknown" };
  }
  const sha = input.candidateSha.toLowerCase();
  const direct = await inspectCandidateSnapshot({
    cwd: input.sourceCwd,
    expectedSha: sha,
    runCommand: input.runCommand,
    env: input.env,
  });
  if (direct.ok) return direct;
  const dest = join(input.snapshotRoot, sha);
  if (!existsSync(dest)) {
    mkdirSync(input.snapshotRoot, { recursive: true, mode: 0o700 });
    const run = input.runCommand ?? defaultRunCommand;
    const added = await run({
      executable: "git",
      argv: ["worktree", "add", "--detach", dest, sha],
      cwd: input.sourceCwd,
      env: input.env ?? process.env,
    });
    if (added.exitCode !== 0) {
      return {
        ok: false,
        reason: `candidate snapshot worktree failed: ${(added.stderr || added.stdout || "exit").trim() || direct.reason}`,
      };
    }
  }
  return inspectCandidateSnapshot({
    cwd: dest,
    expectedSha: sha,
    runCommand: input.runCommand,
    env: input.env,
  });
}

export async function inspectCandidateSnapshot(input: {
  cwd: string;
  expectedSha?: string | null;
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
}): Promise<CandidateSnapshot> {
  if (!input.cwd || !existsSync(input.cwd)) {
    return { ok: false, reason: "candidate worktree is missing" };
  }
  const run = input.runCommand ?? defaultRunCommand;
  const env = input.env ?? process.env;
  const head = await run({
    executable: "git",
    argv: ["rev-parse", "HEAD"],
    cwd: input.cwd,
    env,
  });
  if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) {
    return { ok: false, reason: "candidate HEAD is unknown" };
  }
  const porcelain = await run({
    executable: "git",
    argv: ["status", "--porcelain"],
    cwd: input.cwd,
    env,
  });
  if (porcelain.exitCode !== 0) {
    return { ok: false, reason: "candidate dirty-tree state is unknown" };
  }
  const sha = head.stdout.trim().toLowerCase();
  if (input.expectedSha && input.expectedSha.toLowerCase() !== sha) {
    return { ok: false, reason: `candidate HEAD ${sha} is not ${input.expectedSha}` };
  }
  return {
    ok: true,
    cwd: input.cwd,
    head: sha,
    dirtyTree: porcelain.stdout.trim().length > 0,
  };
}

export function extraProbeManifestVersion(declaredPaths: readonly string[]): string {
  if (declaredPaths.length === 0) return EMPTY_EXTRA_PROBE_MANIFEST;
  return hashTestAssetContents(declaredPaths);
}

export function bindCodeTraceAsset(input: {
  assertionId: string;
  snapshotSha: string;
  locations: readonly string[];
  reviewer: string;
  runId: string;
  testAssetVersion: string;
}): VerificationAsset | null {
  if (!/^[0-9a-f]{40}$/i.test(input.snapshotSha) || input.locations.length === 0) return null;
  return {
    assertionId: input.assertionId,
    snapshotSha: input.snapshotSha.toLowerCase(),
    testAssetVersion: input.testAssetVersion,
    extraProbesDeclared: false,
    extraProbeManifestVersion: EMPTY_EXTRA_PROBE_MANIFEST,
    kind: "code_trace",
    receipts: [
      {
        cwd: input.runId,
        snapshotSha: input.snapshotSha.toLowerCase(),
        testAssetVersion: input.testAssetVersion,
        dirtyTree: false,
        skipped: false,
        ranZeroTests: false,
        role: "independent_adjudicator",
        executionSource: "independent-reviewer-trace",
        locations: [...input.locations],
      },
    ],
  };
}

export function officialEvidenceMatchesCandidate(
  row: OfficialEvidenceRow,
  input: { command: string; cwd: string; snapshotSha: string },
): boolean {
  const command = typeof row.command === "string" ? row.command : "";
  const cwd = typeof row.cwd === "string" ? row.cwd : "";
  const sha = readSha(row.candidateSha) ?? readSha(row.candidate_sha);
  const source = typeof row.source === "string" ? row.source : "";
  if (source === "evidence record" || source === "manual") return false;
  return (
    command === input.command &&
    cwd === input.cwd &&
    typeof sha === "string" &&
    sha.toLowerCase() === input.snapshotSha.toLowerCase() &&
    typeof (row.stdoutHash ?? row.stdout_hash) === "string"
  );
}

export function assetFromOfficialEvidence(input: {
  assertionId: string;
  command: string;
  cwd: string;
  snapshotSha: string;
  testAssetVersion: string;
  row: OfficialEvidenceRow;
  logPath: string;
}): VerificationAsset | null {
  const exitCode = Number(input.row.exitCode ?? input.row.exit_code);
  if (!Number.isInteger(exitCode)) return null;
  const sha = readSha(input.row.candidateSha) ?? readSha(input.row.candidate_sha);
  if (!sha) return null;
  const stdoutHash =
    typeof (input.row.stdoutHash ?? input.row.stdout_hash) === "string"
      ? String(input.row.stdoutHash ?? input.row.stdout_hash)
      : "";
  return {
    assertionId: input.assertionId,
    snapshotSha: sha.toLowerCase(),
    testAssetVersion: input.testAssetVersion,
    extraProbesDeclared: false,
    extraProbeManifestVersion: EMPTY_EXTRA_PROBE_MANIFEST,
    kind: "command_receipt",
    receipts: [
      {
        command: input.command,
        cwd: input.cwd,
        exitCode,
        logPath: input.logPath,
        snapshotSha: sha.toLowerCase(),
        testAssetVersion: input.testAssetVersion,
        dirtyTree: false,
        skipped: false,
        ranZeroTests: false,
        role: "independent_adjudicator",
        executionSource: "squadctl-host-run",
        stdoutHash,
      },
    ],
  };
}

export function writeCommandLog(
  logPath: string,
  receipt: {
    exitCode: number;
    stdout: string;
    stderr: string;
    snapshotSha: string;
    cwd: string;
    dirtyTree: boolean;
    cacheKey: string;
  },
): void {
  mkdirSync(join(logPath, ".."), { recursive: true });
  atomicWriteFile(
    logPath,
    `exit=${receipt.exitCode}\ncwd=${receipt.cwd}\nsha=${receipt.snapshotSha}\ndirty=${receipt.dirtyTree ? "1" : "0"}\ncache=${receipt.cacheKey}\n${receipt.stdout}${receipt.stderr}`,
  );
}

export function receiptFromIsolatedLog(input: {
  assertionId: string;
  command: string;
  cwd: string;
  snapshotSha: string;
  dirtyTree: boolean;
  testAssetVersion: string;
  logPath: string;
  cacheKey: string;
}): VerificationAsset | null {
  if (!existsSync(input.logPath)) return null;
  let log = "";
  try {
    log = readFileSync(input.logPath, "utf8");
  } catch {
    return null;
  }
  if (!log.includes(`sha=${input.snapshotSha.toLowerCase()}`) && !log.includes(input.cacheKey)) {
    return null;
  }
  const exitMatch = /^exit=(-?\d+)/m.exec(log);
  if (!exitMatch) return null;
  const exitCode = Number(exitMatch[1]);
  const dirtyMatch = /^dirty=([01])/m.exec(log);
  if (!dirtyMatch) return null;
  const interpreted = interpretTestLog(log, "", exitCode);
  return {
    assertionId: input.assertionId,
    snapshotSha: input.snapshotSha.toLowerCase(),
    testAssetVersion: input.testAssetVersion,
    extraProbesDeclared: false,
    extraProbeManifestVersion: EMPTY_EXTRA_PROBE_MANIFEST,
    kind: "command_receipt",
    receipts: [
      {
        command: input.command,
        cwd: input.cwd,
        exitCode,
        logPath: input.logPath,
        snapshotSha: input.snapshotSha.toLowerCase(),
        testAssetVersion: input.testAssetVersion,
        dirtyTree: dirtyMatch[1] === "1",
        skipped: interpreted.skipped,
        ranZeroTests: interpreted.ranZeroTests,
        role: "independent_adjudicator",
        executionSource: "ck-isolated-run",
        cacheKey: input.cacheKey,
      },
    ],
  };
}

export async function runCandidateCommand(input: {
  command: string;
  cwd: string;
  outputDir: string;
  tmpDir: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const isolation = detectIsolationCapability();
  const result = await runIsolatedCommand({
    mode: isolation.sandboxExec ? "strong" : "collaborative",
    capability: isolation,
    executable: "/bin/sh",
    argv: ["-c", input.command],
    cwd: input.cwd,
    outputDir: input.outputDir,
    tmpDir: input.tmpDir,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function commandMethods(contract: GoalContract | null): AcceptanceMethod[] {
  if (!contract) return [];
  return contract.acceptance.filter(
    (row) => row.evidenceKind === "regression_test" || row.evidenceKind === "command_receipt",
  );
}

export function codeTraceMethods(contract: GoalContract | null): AcceptanceMethod[] {
  if (!contract) return [];
  return contract.acceptance.filter((row) => row.evidenceKind === "code_trace");
}

export function codeTraceFromReview(
  findings: readonly LedgerFinding[],
  assertionId: string,
  snapshotSha: string,
): VerificationAsset | null {
  const findingId = assertionId.replace(/-v\d+$/, "").replace(/^A-/, "");
  const row = findings.find((item) => item.id === findingId || assertionId.includes(item.id));
  const locations = row?.verification?.locations ?? [];
  const sha = row?.verification?.candidateSha ?? snapshotSha;
  if (!row || locations.length === 0) return null;
  return bindCodeTraceAsset({
    assertionId,
    snapshotSha: sha,
    locations,
    reviewer: row.verification?.reviewer ?? row.reviewer ?? "independent",
    runId: row.verification?.runId ?? "unknown",
    testAssetVersion: hashTestAssetContents(locations),
  });
}

function readSha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value : null;
}

export function persistVerificationAssets(path: string, assets: VerificationAsset[]): void {
  atomicWriteJson(path, assets);
}

export function writeCacheMarker(path: string, cacheKey: string): void {
  writeFileSync(path, `${cacheKey}\n`, { encoding: "utf8", mode: 0o600 });
}
