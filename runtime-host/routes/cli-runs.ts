/**
 * Session-authenticated read of the CLI run library, plus POST create-review
 * and POST actions that spawn the same-checkout `councilkit` CLI
 * (review / fix / re-review). The Host never writes agents/councils and never
 * runs review agents itself.
 */
import { randomUUID } from "node:crypto";
import {
  type Stats,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type AttemptLiveEvent,
  CLI_RUN_ATTEMPT_ID_RE,
  parseAttemptLiveEventLine,
} from "@shared/runtime/attempt-live-events";
import { resolveCliRunsRoot, resolveCouncilkitHome } from "@shared/runtime/cli-home";
import { CLI_RUN_STATUS_FILE, type CliRunProgressPhase } from "@shared/runtime/cli-run-progress";
import { isCliRunId, listCliRuns, readCliRun } from "@shared/runtime/cli-runs-index";
import { makeError } from "@shared/runtime/errors";
import { resolveAttemptExecution } from "@shared/runtime/execution-ref";
import { parseApplyPrUrl, projectKeyFromPr } from "@shared/runtime/pr-url";
import {
  type RepairProfileRecord,
  parseRepairGrantRecord,
  parseRepairProfileRecord,
  profileIntegrityHash,
  verifyRepairGrantRecord,
} from "@shared/runtime/repair-auth";
import {
  type WriterLease,
  isActiveRepairHolder,
  isRepairProfileName,
  parseWriterLease,
  writerLeaseKey,
  writerLeasePath,
  writerRepoFromPrUrl,
} from "@shared/runtime/repair-lease";
import { normalizeReviewPr } from "@shared/runtime/review-case";
import {
  type CliRunActionResponse,
  type CliRunAttemptLiveResponse,
  type CliRunAttemptResultResponse,
  type CliRunDetailResponse,
  type CliRunListRepairProfilesResponse,
  type CliRunRepairStopResponse,
  type CliRunSaveRepairProfileRequest,
  type CliRunSaveRepairProfileResponse,
  type CliRunStartIdeateRequest,
  type CliRunStartRepairRequest,
  type CliRunStartReviewRequest,
  type CliRunStartReviewResponse,
  type CliRunsListResponse,
  cliRunActionRequestSchema,
  cliRunActionResponseSchema,
  cliRunAttemptLiveResponseSchema,
  cliRunAttemptResultResponseSchema,
  cliRunDetailResponseSchema,
  cliRunListRepairProfilesResponseSchema,
  cliRunRepairControlRequestSchema,
  cliRunRepairStopResponseSchema,
  cliRunSaveRepairProfileRequestSchema,
  cliRunSaveRepairProfileResponseSchema,
  cliRunStartIdeateRequestSchema,
  cliRunStartRepairRequestSchema,
  cliRunStartReviewRequestSchema,
  cliRunStartReviewResponseSchema,
  cliRunsListResponseSchema,
} from "@shared/runtime/schemas";
import { type CliRunLauncher, defaultCliRunLauncher, isPidAlive } from "../cli-launcher";
import { resolveRepairBranchHints } from "../repair-branch-hints";
import { type HostServices, HttpError, type Route, httpError } from "../server";
import { probeSquadBridge } from "../squad-bridge-probe";

const PIPELINE_PID_FILE = "pipeline.pid";

export function cliRunsRoutes(services?: HostServices): Route[] {
  const launcher = resolveLauncher(services);
  const bridgeProbe = resolveBridgeProbe(services);
  return [
    {
      method: "GET",
      pattern: "/api/v1/cli-runs",
      auth: "session",
      responseSchema: cliRunsListResponseSchema,
      handler: (): CliRunsListResponse => ({ runs: listCliRuns(process.env) }),
    },
    {
      method: "POST",
      pattern: "/api/v1/cli-runs",
      auth: "mutation",
      bodySchema: cliRunStartReviewRequestSchema,
      responseSchema: cliRunStartReviewResponseSchema,
      handler: async (ctx): Promise<CliRunStartReviewResponse> => {
        const body = ctx.body as CliRunStartReviewRequest;
        if (body.repo?.startsWith("-")) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "repo must be a filesystem path, not a flag.", {
              retryable: false,
            }),
          );
        }
        if (parseApplyPrUrl(body.pr) === null) {
          throw httpError(
            400,
            makeError(
              "BAD_REQUEST",
              "discovery",
              "PR URL must be a GitHub or AntCode pull request.",
              {
                retryable: false,
              },
            ),
          );
        }
        if (!body.reviewModels && !hasPrJuryCouncil()) {
          throw httpError(
            400,
            makeError(
              "BAD_REQUEST",
              "discovery",
              "default pr-jury is missing; run `councilkit init`",
              { retryable: false },
            ),
          );
        }
        const runId = `ck-review-${randomUUID()}`;
        const logPath = join(tmpdir(), `councilkit-host-review-${runId}.log`);
        let started: { pid: number };
        try {
          started = await Promise.resolve(
            launcher.start({
              action: "review",
              runId,
              pr: body.pr,
              repo: body.repo,
              against: body.against,
              reviewModels: body.reviewModels,
              logPath,
            }),
          );
        } catch (error) {
          throw mapReviewSpawnError(error, body.pr);
        }
        if (!isPidAlive(started.pid)) {
          throw mapReviewSpawnError(
            new Error("councilkit review exited before handshake completed"),
            body.pr,
          );
        }
        writeRunningStub(runId, "preflight");
        return { runId, started: true };
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/cli-runs/ideate",
      auth: "mutation",
      bodySchema: cliRunStartIdeateRequestSchema,
      responseSchema: cliRunStartReviewResponseSchema,
      handler: async (ctx): Promise<CliRunStartReviewResponse> => {
        const body = ctx.body as CliRunStartIdeateRequest;
        const idea = body.idea.trim();
        if (idea.length === 0) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "idea is required.", { retryable: false }),
          );
        }
        if (!body.models && !hasNamedCouncil("product-jury")) {
          throw httpError(
            400,
            makeError(
              "BAD_REQUEST",
              "discovery",
              "default product-jury is missing; run `councilkit init`",
              { retryable: false },
            ),
          );
        }
        const runId = `ck-ideate-${randomUUID()}`;
        const logPath = join(tmpdir(), `councilkit-host-ideate-${runId}.log`);
        let started: { pid: number };
        try {
          started = await Promise.resolve(
            launcher.start({
              action: "ideate",
              runId,
              idea,
              background: body.background,
              debateRounds: body.debateRounds,
              ideateModels: body.models,
              logPath,
            }),
          );
        } catch (error) {
          throw mapIdeateSpawnError(error);
        }
        if (!isPidAlive(started.pid)) {
          throw mapIdeateSpawnError(
            new Error("councilkit ideate exited before handshake completed"),
          );
        }
        writeRunningStub(runId, "proposing");
        return { runId, started: true };
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/cli-runs/repair",
      auth: "mutation",
      bodySchema: cliRunStartRepairRequestSchema,
      responseSchema: cliRunStartReviewResponseSchema,
      handler: async (ctx): Promise<CliRunStartReviewResponse> => {
        const body = ctx.body as CliRunStartRepairRequest;
        return startRepairRun(launcher, body, bridgeProbe);
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/cli-runs/repair/profiles",
      auth: "session",
      responseSchema: cliRunListRepairProfilesResponseSchema,
      handler: (ctx): Promise<CliRunListRepairProfilesResponse> =>
        listRepairProfiles(ctx.query.get("from"), bridgeProbe),
    },
    {
      method: "POST",
      pattern: "/api/v1/cli-runs/repair/profiles",
      auth: "mutation",
      bodySchema: cliRunSaveRepairProfileRequestSchema,
      responseSchema: cliRunSaveRepairProfileResponseSchema,
      handler: (ctx): CliRunSaveRepairProfileResponse => {
        const body = ctx.body as CliRunSaveRepairProfileRequest;
        return toProfileSummary(writeHostRepairProfile(body));
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/cli-runs/:runId/repair/stop",
      auth: "mutation",
      bodySchema: cliRunRepairControlRequestSchema,
      responseSchema: cliRunRepairStopResponseSchema,
      handler: async (ctx): Promise<CliRunRepairStopResponse> => {
        const runId = ctx.params.runId ?? "";
        assertRepairRunId(runId);
        const logPath = join(tmpdir(), `councilkit-host-repair-stop-${runId}.log`);
        try {
          await Promise.resolve(launcher.start({ action: "repair-stop", runId, logPath }));
        } catch (error) {
          throw mapRepairSpawnError(error);
        }
        return { runId, stopped: true };
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/cli-runs/:runId/repair/resume",
      auth: "mutation",
      bodySchema: cliRunRepairControlRequestSchema,
      responseSchema: cliRunStartReviewResponseSchema,
      handler: async (ctx): Promise<CliRunStartReviewResponse> => {
        const runId = ctx.params.runId ?? "";
        assertRepairRunId(runId);
        const profileName = readRepairJson(runId)?.profileName;
        if (!profileName) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "repair run is missing profile metadata.", {
              retryable: false,
            }),
          );
        }
        const profile = readHostRepairProfile(profileName);
        if (profile === null) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "repair profile not found.", {
              retryable: false,
            }),
          );
        }
        const grant = readHostRepairGrant(runId);
        const state = readRepairJson(runId);
        if (grant === null) {
          if ((state?.outerUsed ?? 0) > 0) {
            throw httpError(
              400,
              makeError("BAD_REQUEST", "discovery", "repair grant is missing.", {
                retryable: false,
              }),
            );
          }
        } else {
          const verified = verifyRepairGrantRecord(grant, profile, new Date().toISOString());
          if (!verified.ok) {
            throw httpError(
              400,
              makeError("BAD_REQUEST", "discovery", verified.reason, { retryable: false }),
            );
          }
        }
        const logPath = join(tmpdir(), `councilkit-host-repair-resume-${runId}.log`);
        let started: { pid: number };
        try {
          started = await Promise.resolve(
            launcher.start({ action: "repair-resume", runId, logPath }),
          );
        } catch (error) {
          throw mapRepairSpawnError(error);
        }
        if (!isPidAlive(started.pid)) {
          throw mapRepairSpawnError(new Error("councilkit repair resume exited before handshake"));
        }
        writeRunningStub(runId, "repair-preparing");
        return { runId, started: true };
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/cli-runs/:runId",
      auth: "session",
      responseSchema: cliRunDetailResponseSchema,
      handler: (ctx): CliRunDetailResponse => {
        const runId = ctx.params.runId ?? "";
        if (!isCliRunId(runId)) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "Invalid CLI run id.", { retryable: false }),
          );
        }
        const detail = readCliRun(runId, process.env);
        if (detail === null) {
          throw httpError(
            404,
            makeError("NOT_FOUND", "discovery", "CLI run not found.", { retryable: false }),
          );
        }
        return detail;
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/cli-runs/:runId/attempts/:attemptId/result",
      auth: "session",
      responseSchema: cliRunAttemptResultResponseSchema,
      handler: (ctx): CliRunAttemptResultResponse => {
        const runId = ctx.params.runId ?? "";
        if (!isCliRunId(runId)) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "Invalid CLI run id.", { retryable: false }),
          );
        }
        const attemptId = ctx.params.attemptId ?? "";
        if (!CLI_RUN_ATTEMPT_ID_RE.test(attemptId)) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "Invalid attempt id.", { retryable: false }),
          );
        }
        const detail = readCliRun(runId, process.env);
        if (detail === null) {
          throw httpError(
            404,
            makeError("NOT_FOUND", "discovery", "CLI run not found.", { retryable: false }),
          );
        }
        const transcript = readRunTranscript(runId);
        if (transcript.kind === "missing") {
          throw httpError(
            404,
            makeError("NOT_FOUND", "discovery", "CLI run transcript not found.", {
              retryable: false,
            }),
          );
        }
        const row = detail.progress?.attempts.find((item) => item.attemptId === attemptId) ?? null;
        const runActive = detail.status === "running" || detail.status === "awaiting_orchestrator";
        if (transcript.kind === "unreadable") {
          // Boundary violation or a corrupt line: finite semantics, never echo
          // the offending content (it can carry model output / secrets).
          return {
            runId,
            attemptId,
            executionRef: `${attemptId}#0.0`,
            executionStatus: runActive
              ? "pending"
              : row?.status === "success"
                ? "success"
                : "failure",
            availability: "unavailable",
            markdown: null,
            truncated: false,
            failure: null,
            reusedFrom: null,
          };
        }
        const resolution = resolveAttemptExecution({
          records: transcript.records,
          attemptId,
          liveStatus: row?.status ?? null,
          runActive,
        });
        if (resolution.kind === "unknown-attempt") {
          throw httpError(
            404,
            makeError("NOT_FOUND", "discovery", "CLI attempt not found in this run.", {
              retryable: false,
            }),
          );
        }
        if (resolution.kind === "unavailable") {
          return {
            runId,
            attemptId,
            executionRef: resolution.executionRef,
            executionStatus: runActive
              ? "pending"
              : row !== null && row.status !== "pending" && row.status !== "queued"
                ? row.status
                : "failure",
            availability: "unavailable",
            markdown: null,
            truncated: false,
            failure: null,
            reusedFrom: null,
          };
        }
        if (resolution.kind === "inflight") {
          return {
            runId,
            attemptId,
            executionRef: resolution.executionRef,
            executionStatus: resolution.executionStatus,
            availability: "pending",
            markdown: null,
            truncated: false,
            failure: null,
            reusedFrom: null,
          };
        }
        const output = resolution.executionStatus === "success" ? resolution.output : null;
        const available = output !== null && output.trim().length > 0;
        return {
          runId,
          attemptId,
          executionRef: resolution.executionRef,
          executionStatus: resolution.executionStatus,
          availability: available
            ? "available"
            : resolution.executionStatus === "success"
              ? "empty"
              : "unavailable",
          markdown: available ? output : null,
          truncated: false,
          failure: resolution.failure,
          reusedFrom:
            resolution.reusedExecutionRef !== null
              ? { runId, executionRef: resolution.reusedExecutionRef }
              : null,
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/cli-runs/:runId/attempts/:attemptId/live",
      auth: "session",
      responseSchema: cliRunAttemptLiveResponseSchema,
      handler: (ctx): CliRunAttemptLiveResponse => {
        const runId = ctx.params.runId ?? "";
        if (!isCliRunId(runId)) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "Invalid CLI run id.", { retryable: false }),
          );
        }
        const attemptId = ctx.params.attemptId ?? "";
        if (!CLI_RUN_ATTEMPT_ID_RE.test(attemptId)) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "Invalid attempt id.", { retryable: false }),
          );
        }
        const afterSeq = parseAfterSeq(ctx.query.get("afterSeq"));
        const detail = readCliRun(runId, process.env);
        if (detail === null) {
          throw httpError(
            404,
            makeError("NOT_FOUND", "discovery", "CLI run not found.", { retryable: false }),
          );
        }
        const all = readLiveSidecar(runId, attemptId);
        const events = all.filter((event) => event.seq > afterSeq);
        const nextSeq = all.length === 0 ? afterSeq : Math.max(...all.map((event) => event.seq));
        const attempt = detail.progress?.attempts.find((row) => row.attemptId === attemptId);
        const attemptEnded =
          attempt !== undefined &&
          (attempt.status === "success" ||
            attempt.status === "failure" ||
            attempt.status === "cancelled");
        return {
          events,
          nextSeq,
          done:
            attemptEnded ||
            (detail.status !== "running" && detail.status !== "awaiting_orchestrator"),
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/cli-runs/:runId/actions",
      auth: "mutation",
      bodySchema: cliRunActionRequestSchema,
      responseSchema: cliRunActionResponseSchema,
      handler: async (ctx): Promise<CliRunActionResponse> => {
        const runId = ctx.params.runId ?? "";
        if (!isCliRunId(runId) || !runId.startsWith("ck-review-")) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "Invalid CLI review run id.", {
              retryable: false,
            }),
          );
        }
        const detail = readCliRun(runId, process.env);
        if (detail === null) {
          throw httpError(
            404,
            makeError("NOT_FOUND", "discovery", "CLI run not found.", { retryable: false }),
          );
        }
        if (detail.status === "running") {
          throw httpError(
            409,
            makeError("EXECUTION_CONFLICT", "dispatch", "This run is already in progress.", {
              retryable: true,
            }),
          );
        }
        const body = ctx.body as { action: "fix" | "re-review" };
        const home = resolveCouncilkitHome(process.env);
        const runDir = join(home, "runs", runId);
        const pidPath = join(runDir, PIPELINE_PID_FILE);
        const existing = readPid(pidPath);
        if (existing !== null && isPidAlive(existing)) {
          throw httpError(
            409,
            makeError("EXECUTION_CONFLICT", "dispatch", "A fix pipeline is already running.", {
              retryable: true,
            }),
          );
        }
        const logPath = join(runDir, "pipeline.log");
        writeStartingStatus(runDir, body.action);
        let started: { pid: number };
        try {
          started = await Promise.resolve(launcher.start({ action: body.action, runId, logPath }));
        } catch (error) {
          throw httpError(
            500,
            makeError(
              "DRIVER_SPAWN_FAILED",
              "dispatch",
              error instanceof Error ? error.message : "failed to spawn councilkit",
              { retryable: false },
            ),
          );
        }
        try {
          writeFileSync(pidPath, `${String(started.pid)}\n`, { encoding: "utf8", mode: 0o600 });
        } catch {
          // best-effort lock; the child is already running
        }
        return { action: body.action, runId, started: true };
      },
    },
  ];
}

const repairLocks = new Map<string, Promise<void>>();

function withRepairLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = repairLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  repairLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function startRepairRun(
  launcher: CliRunLauncher,
  body: CliRunStartRepairRequest,
  bridgeProbe: () => { available: boolean; reason: string | null },
): Promise<CliRunStartReviewResponse> {
  const probe = bridgeProbe();
  if (!probe.available) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", probe.reason ?? "Squad 桥不可用，无法启动自动修复。", {
        retryable: false,
      }),
    );
  }
  const sourceDir = join(resolveCliRunsRoot(), body.from);
  if (!isRealDir(sourceDir)) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "review run not found.", { retryable: false }),
    );
  }
  const profile = readHostRepairProfile(body.profile);
  if (profile === null) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "repair profile not found.", { retryable: false }),
    );
  }
  const key = writerLeaseKey({ repo: profile.repo, sourceBranch: profile.sourceBranch });
  return withRepairLock(key, async () => {
    const existing = findActiveRepairRunId(body.from, key);
    if (existing !== null) {
      return { runId: existing, started: true };
    }
    const runId = `ck-repair-${randomUUID()}`;
    const claimed = claimRepairLease({
      key,
      holderRunId: runId,
      pid: process.pid,
    });
    if (claimed.holderKind !== "repair") {
      throw httpError(
        409,
        makeError(
          "EXECUTION_CONFLICT",
          "dispatch",
          `a writer already holds this branch (${claimed.holderKind} ${claimed.holderRunId})`,
          { retryable: true },
        ),
      );
    }
    if (claimed.holderRunId !== runId) {
      return { runId: claimed.holderRunId, started: true };
    }
    const logPath = join(tmpdir(), `councilkit-host-repair-${runId}.log`);
    let started: { pid: number };
    try {
      started = await Promise.resolve(
        launcher.start({
          action: "repair",
          runId,
          from: body.from,
          profile: body.profile,
          logPath,
        }),
      );
    } catch (error) {
      if (isHandshakeTimeout(error)) {
        const recovered = findActiveRepairRunId(body.from, key);
        if (recovered !== null && isRealDir(join(resolveCliRunsRoot(), recovered))) {
          return { runId: recovered, started: true };
        }
        if (isRealDir(join(resolveCliRunsRoot(), runId))) {
          return { runId, started: true };
        }
      }
      throw mapRepairSpawnError(error);
    }
    if (!isPidAlive(started.pid)) {
      const recovered = findActiveRepairRunId(body.from, key);
      if (recovered !== null) return { runId: recovered, started: true };
      throw mapRepairSpawnError(new Error("councilkit repair exited before handshake completed"));
    }
    refreshRepairLease({ key, holderRunId: runId, pid: started.pid });
    writeRepairBootstrap(runId, body.from, body.profile);
    return { runId, started: true };
  });
}

function findActiveRepairRunId(fromId: string, leaseKey: string): string | null {
  const home = resolveCouncilkitHome(process.env);
  const lease = readLeaseFile(writerLeasePath(home, leaseKey));
  if (lease?.holderKind === "repair") {
    const detail = readCliRun(lease.holderRunId, process.env);
    const state = readRepairJson(lease.holderRunId);
    if (
      isActiveRepairHolder({
        kind: "repair",
        status: detail?.status ?? "running",
        businessResult: state?.businessResult ?? null,
        lease,
        pidAlive: isPidAlive(lease.pid),
      })
    ) {
      return lease.holderRunId;
    }
    if (isPidAlive(lease.pid) && (state?.businessResult ?? null) === null) {
      return lease.holderRunId;
    }
  }
  for (const run of listCliRuns(process.env)) {
    if (run.kind !== "repair") continue;
    const state = readRepairJson(run.runId);
    if (state?.sourceRunId !== fromId) continue;
    if (state.businessResult !== null && state.businessResult !== undefined) continue;
    if (run.status === "running" || run.status === "interrupted") return run.runId;
  }
  return null;
}

function claimRepairLease(input: {
  key: string;
  holderRunId: string;
  pid: number;
}): WriterLease {
  const home = resolveCouncilkitHome(process.env);
  const path = writerLeasePath(home, input.key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const next: WriterLease = {
    version: 1,
    key: input.key,
    holderKind: "repair",
    holderRunId: input.holderRunId,
    pid: input.pid,
    epoch: 1,
    grantedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return next;
  } catch {
    const existing = readLeaseFile(path);
    if (existing === null) {
      throw httpError(
        500,
        makeError("INTERNAL", "dispatch", "cannot create writer lease", { retryable: true }),
      );
    }
    return existing;
  }
}

function refreshRepairLease(input: { key: string; holderRunId: string; pid: number }): void {
  const home = resolveCouncilkitHome(process.env);
  const path = writerLeasePath(home, input.key);
  const existing = readLeaseFile(path);
  if (existing === null || existing.holderRunId !== input.holderRunId) return;
  try {
    writeFileSync(path, `${JSON.stringify({ ...existing, pid: input.pid }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // lease is advisory for Host lookup
  }
}

function readLeaseFile(path: string): WriterLease | null {
  try {
    return parseWriterLease(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readHostRepairProfile(name: string): ReturnType<typeof parseRepairProfileRecord> {
  const path = join(resolveCouncilkitHome(process.env), "profiles", `${name}.json`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return parseRepairProfileRecord(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function listRepairProfiles(
  from: string | null,
  bridgeProbe: () => { available: boolean },
): Promise<CliRunListRepairProfilesResponse> {
  const bridgeAvailable = bridgeProbe().available;
  if (!from || !isCliRunId(from)) {
    return {
      profiles: listHostRepairProfiles().map(toProfileSummary),
      sourceBranchHint: null,
      baseHint: null,
      hintSource: null,
      bridgeAvailable,
    };
  }
  const wantedPr = readCliRun(from, process.env)?.reviewEvidence?.prUrl ?? null;
  const hints = await resolveRepairBranchHints({ runId: from, prUrl: wantedPr });
  const profiles = listHostRepairProfiles()
    .filter((row) => wantedPr !== null && row.prUrl === wantedPr)
    .map(toProfileSummary);
  return {
    profiles,
    sourceBranchHint: hints.sourceBranch,
    baseHint: hints.base,
    hintSource: hints.hintSource,
    bridgeAvailable,
  };
}

function listHostRepairProfiles(): RepairProfileRecord[] {
  const dir = join(resolveCouncilkitHome(process.env), "profiles");
  if (!isRealDir(dir)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const rows: RepairProfileRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    if (!isRepairProfileName(name)) continue;
    const rec = readHostRepairProfile(name);
    if (rec === null || rec.name !== name || rec.revokedAt) continue;
    rows.push(rec);
  }
  return rows.sort((a, b) => {
    if (a.name === "default") return -1;
    if (b.name === "default") return 1;
    return a.name.localeCompare(b.name);
  });
}

function writeHostRepairProfile(input: CliRunSaveRepairProfileRequest): RepairProfileRecord {
  const prUrl = normalizeReviewPr(input.prUrl);
  if (prUrl === null) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "repair profile requires a GitHub or AntCode PR URL", {
        retryable: false,
      }),
    );
  }
  const repo = writerRepoFromPrUrl(prUrl);
  if (repo === null || repo !== input.repo.trim().toLowerCase()) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "repair profile repo does not match the PR URL.", {
        retryable: false,
      }),
    );
  }
  const sourceBranch = input.sourceBranch.trim();
  const base = input.base.trim();
  if (!sourceBranch || !base) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "repair profile requires source and base branches.", {
        retryable: false,
      }),
    );
  }
  const capabilities = [...new Set(input.capabilities)];
  const createdAt = new Date().toISOString();
  const record: RepairProfileRecord = {
    version: 1,
    name: input.name,
    prUrl,
    repo,
    sourceBranch,
    base,
    capabilities,
    integrityHash: "",
    expiresAt: null,
    revokedAt: null,
    createdAt,
  };
  record.integrityHash = profileIntegrityHash(record);
  const dir = join(resolveCouncilkitHome(process.env), "profiles");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${record.name}.json`);
  try {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || existing.isDirectory()) {
      throw httpError(
        400,
        makeError("BAD_REQUEST", "discovery", "repair profile path is not a regular file.", {
          retryable: false,
        }),
      );
    }
  } catch (error) {
    if (!isEnoent(error)) {
      if (error instanceof HttpError) throw error;
      throw httpError(
        500,
        makeError("INTERNAL", "dispatch", "cannot inspect repair profile path", {
          retryable: true,
        }),
      );
    }
  }
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return record;
}

function toProfileSummary(row: RepairProfileRecord): CliRunSaveRepairProfileResponse {
  return {
    name: row.name,
    prUrl: row.prUrl,
    sourceBranch: row.sourceBranch,
    base: row.base,
  };
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readHostRepairGrant(runId: string): ReturnType<typeof parseRepairGrantRecord> {
  const path = join(resolveCliRunsRoot(), runId, "repair-grant.json");
  try {
    return parseRepairGrantRecord(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readRepairJson(runId: string): {
  sourceRunId?: string;
  profileName?: string;
  businessResult?: "approved" | "needs_attention" | "stopped" | null;
  outerUsed?: number;
} | null {
  try {
    const rec = JSON.parse(
      readFileSync(join(resolveCliRunsRoot(), runId, "repair.json"), "utf8"),
    ) as {
      sourceRunId?: unknown;
      profileName?: unknown;
      businessResult?: unknown;
      outerUsed?: unknown;
    };
    return {
      sourceRunId: typeof rec.sourceRunId === "string" ? rec.sourceRunId : undefined,
      profileName: typeof rec.profileName === "string" ? rec.profileName : undefined,
      outerUsed: typeof rec.outerUsed === "number" ? rec.outerUsed : undefined,
      businessResult:
        rec.businessResult === "approved" ||
        rec.businessResult === "needs_attention" ||
        rec.businessResult === "stopped"
          ? rec.businessResult
          : rec.businessResult === null
            ? null
            : undefined,
    };
  } catch {
    return null;
  }
}

function writeRepairBootstrap(runId: string, sourceRunId: string, profileName: string): void {
  const runDir = join(resolveCliRunsRoot(), runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const statePath = join(runDir, "repair.json");
  if (!existsSync(statePath)) {
    try {
      writeFileSync(
        statePath,
        `${JSON.stringify({
          version: 1,
          casVersion: 0,
          sourceRunId,
          profileName,
          outerUsed: 0,
          outerMax: 10,
          timeoutMs: null,
          businessResult: null,
          reasonCode: null,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // CLI persist is authoritative
    }
  }
  writeRunningStub(runId, "repair-preparing");
}

function assertRepairRunId(runId: string): void {
  if (!isCliRunId(runId) || !runId.startsWith("ck-repair-")) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "Invalid CLI repair run id.", { retryable: false }),
    );
  }
  if (readCliRun(runId, process.env) === null && readRepairJson(runId) === null) {
    throw httpError(
      404,
      makeError("NOT_FOUND", "discovery", "CLI run not found.", { retryable: false }),
    );
  }
}

function isHandshakeTimeout(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "HANDSHAKE_TIMEOUT" ||
    message.includes("HANDSHAKE_TIMEOUT") ||
    /handshake timed out/i.test(message)
  );
}

function mapRepairSpawnError(error: unknown): never {
  const message = error instanceof Error ? error.message : "failed to spawn councilkit";
  if (isHandshakeTimeout(error)) {
    throw httpError(
      500,
      makeError("HANDSHAKE_TIMEOUT", "dispatch", message.slice(0, 1024), { retryable: true }),
    );
  }
  throw httpError(
    500,
    makeError("DRIVER_SPAWN_FAILED", "dispatch", message.slice(0, 1024), { retryable: false }),
  );
}

function isRealDir(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function hasPrJuryCouncil(): boolean {
  return hasNamedCouncil("pr-jury");
}

function hasNamedCouncil(name: string): boolean {
  try {
    const home = resolveCouncilkitHome(process.env);
    const raw = readFileSync(join(home, "councils.json"), "utf8");
    const parsed = JSON.parse(raw) as { councils?: Array<{ id?: unknown; name?: unknown }> };
    if (!Array.isArray(parsed.councils)) return false;
    return parsed.councils.some((council) => council.name === name || council.id === name);
  } catch {
    return false;
  }
}

function mapIdeateSpawnError(error: unknown): never {
  const message = error instanceof Error ? error.message : "failed to spawn councilkit";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "HANDSHAKE_TIMEOUT" || message.includes("HANDSHAKE_TIMEOUT")) {
    throw httpError(
      500,
      makeError("HANDSHAKE_TIMEOUT", "dispatch", message.slice(0, 1024), { retryable: true }),
    );
  }
  if (message.includes("product-jury")) {
    throw httpError(
      400,
      makeError(
        "BAD_REQUEST",
        "discovery",
        "default product-jury is missing; run `councilkit init`",
        {
          retryable: false,
        },
      ),
    );
  }
  throw httpError(
    500,
    makeError("DRIVER_SPAWN_FAILED", "dispatch", message.slice(0, 1024), { retryable: false }),
  );
}

function mapReviewSpawnError(error: unknown, pr: string): never {
  const message = error instanceof Error ? error.message : "failed to spawn councilkit";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "HANDSHAKE_TIMEOUT" || message.includes("HANDSHAKE_TIMEOUT")) {
    throw httpError(
      500,
      makeError("HANDSHAKE_TIMEOUT", "dispatch", message.slice(0, 1024), { retryable: true }),
    );
  }
  if (/no local clone/i.test(message)) {
    const project = projectKeyFromPr(pr) ?? "unknown";
    throw httpError(
      400,
      makeError(
        "BAD_REQUEST",
        "discovery",
        `no local clone for ${project}. Run: councilkit review ${pr} --repo <path>`,
        { retryable: false },
      ),
    );
  }
  if (message.includes("pr-jury")) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "default pr-jury is missing; run `councilkit init`", {
        retryable: false,
      }),
    );
  }
  throw httpError(
    500,
    makeError("DRIVER_SPAWN_FAILED", "dispatch", message.slice(0, 1024), { retryable: false }),
  );
}

function writeRunningStub(runId: string, phase: CliRunProgressPhase = "preflight"): void {
  const statusPath = join(resolveCliRunsRoot(), runId, CLI_RUN_STATUS_FILE);
  if (existsSync(statusPath)) return;
  mkdirSync(dirname(statusPath), { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const live = {
    version: 1 as const,
    status: "running" as const,
    progress: { phase, attempts: [] as const, updatedAt: now },
    pipeline: null,
  };
  try {
    writeFileSync(statusPath, `${JSON.stringify(live)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // CLI will write status.json as soon as it boots
  }
}

function resolveLauncher(services?: HostServices): CliRunLauncher {
  const extra = services?.cliRunLauncher;
  if (extra && typeof extra === "object" && "start" in extra) {
    return extra as CliRunLauncher;
  }
  return defaultCliRunLauncher();
}

function resolveBridgeProbe(
  services?: HostServices,
): () => { available: boolean; version: string | null; reason: string | null } {
  const extra = services?.squadBridgeProbe;
  if (typeof extra === "function") {
    return extra as () => { available: boolean; version: string | null; reason: string | null };
  }
  return probeSquadBridge;
}

function writeStartingStatus(runDir: string, action: "fix" | "re-review"): void {
  const now = new Date().toISOString();
  const phase = action === "re-review" ? "re-reviewing" : "planning";
  const live = {
    version: 1 as const,
    status: "running" as const,
    progress: { phase, attempts: [] as const, updatedAt: now },
    pipeline: {
      phase,
      round: 0,
      maxRounds: 2,
      planVerdict: null,
      applyStatus: action === "fix" ? "pending" : null,
      followUpRunId: null,
      summary:
        action === "fix"
          ? "正在启动修复：先探测模型（约 1 分钟），请留在此页查看进度。"
          : "正在启动复审：不再改代码，只重新审查当前 PR。",
      updatedAt: now,
    },
  };
  try {
    writeFileSync(join(runDir, "status.json"), `${JSON.stringify(live)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // CLI will write status.json as soon as it boots
  }
}

function readPid(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim().split("\n")[0];
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function parseAfterSeq(raw: string | null): number {
  if (raw === null || raw.length === 0) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "Invalid afterSeq.", { retryable: false }),
    );
  }
  return Number.parseInt(raw, 10);
}

function readRunTranscript(
  runId: string,
): { kind: "records"; records: unknown[] } | { kind: "missing" } | { kind: "unreadable" } {
  const root = resolveCliRunsRoot(process.env);
  const runDir = join(root, runId);
  if (resolve(runDir) !== resolve(root, runId)) return { kind: "unreadable" };
  const dirStat = safeLstat(runDir);
  if (dirStat === null || !dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    return { kind: "unreadable" };
  }
  const filePath = join(runDir, "transcript.jsonl");
  const fileStat = safeLstat(filePath);
  if (fileStat === null) return { kind: "missing" };
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) return { kind: "unreadable" };
  // Full read, uncapped: the B1 contract requires the whole durable output of
  // the matching execution — the detail API's 256KB+64KB truncation and the
  // index scan cap do not apply here.
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return { kind: "unreadable" };
  }
  const records: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // One corrupt line poisons ordering-based identity: refuse the whole
      // read (finite unavailable semantics) without echoing the line.
      return { kind: "unreadable" };
    }
  }
  return { kind: "records", records };
}

function readLiveSidecar(runId: string, attemptId: string): AttemptLiveEvent[] {
  const root = resolveCliRunsRoot(process.env);
  const liveDir = join(root, runId, "live");
  const filePath = join(liveDir, `${attemptId}.jsonl`);
  if (resolve(filePath) !== resolve(root, runId, "live", `${attemptId}.jsonl`)) return [];
  const dirStat = safeLstat(liveDir);
  if (dirStat === null || !dirStat.isDirectory() || dirStat.isSymbolicLink()) return [];
  const fileStat = safeLstat(filePath);
  if (fileStat === null || !fileStat.isFile() || fileStat.isSymbolicLink()) return [];
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const events: AttemptLiveEvent[] = [];
  const parts = text.split("\n");
  if (text.length > 0 && !text.endsWith("\n") && parts.length > 0) {
    parts.pop();
  }
  for (const line of parts) {
    const parsed = parseAttemptLiveEventLine(line);
    if (parsed !== null) events.push(parsed);
  }
  return events;
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
