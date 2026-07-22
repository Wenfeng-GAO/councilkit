/**
 * Orchestrator unit tests (plan-a §10 AC1/AC4). Drives runCouncil with a fake
 * OrchestratorHost + a scripted TurnDriver so the sequencing + failure
 * semantics are tested without re-running the SSE/ACK mechanics (those are
 * covered by execute-turn.test). Covers:
 *  - 2 agents × 2 rounds ⇒ exactly 4 ordinary turns + 1 Reporter turn, exit 0,
 *    non-empty report naming both agents, transcript line count.
 *  - a mid-run ordinary-turn failure stops the Run, retains prior transcript,
 *    writes an INCOMPLETE partial report, exit 4.
 *  - Reporter failure → INCOMPLETE partial report, exit 4.
 *  - persist succeeded then ACK conflict → transcript retains the turn, exit 4.
 *  - closeScope failure overrides a completed Run to non-success, exit 4.
 *  - scope-create failure (Host gone) → exit 4, partial report, no turns.
 *  - SIGINT mid-run → interrupted, exit 130, partial report.
 *  - no duplicate execute (the driver is called once per scheduled turn).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CloseScopeResponse,
  CreateScopeResponse,
  ResolveProfileResponse,
  ScopeStatus,
} from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError, EXIT } from "../src/errors";
import type { TerminalEvidence, TurnResult } from "../src/host/execute-turn";
import { computeParticipantDigest } from "../src/run/context-snapshot";
import {
  type OrchestratorHost,
  type TurnDriver,
  type TurnRequest,
  buildProfile,
  runCouncil,
} from "../src/run/orchestrator";
import type { ResolvedAgent, RunInput } from "../src/run/types";
import { resolvePaths } from "../src/store/paths";
import type { AgentRecord, DriverSelection } from "../src/store/schemas";

const KIMI: DriverSelection = { driverId: "kimi-stream-json", options: {} };

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "councilkit-orch-"));
}

function agent(id: string, name: string, enabled = true): AgentRecord {
  return {
    id,
    name,
    personaPrompt: `${name} persona`,
    modelId: "kimi-code/k3",
    color: "#112233",
    enabled,
    driverSelection: KIMI,
  };
}

function resolved(a: AgentRecord, installationId = "inst-kimi-1"): ResolvedAgent {
  return {
    snapshot: a,
    profile: buildProfile(a.driverSelection, installationId),
    installationId,
    participantId: `p-${a.id}`,
    participantSnapshotDigest: computeParticipantDigest(a.personaPrompt),
  };
}

function council(agentIds: string[], reporterId: string, rounds = 2) {
  return {
    id: "c-test",
    name: "test-council",
    topic: "orchestrator test topic",
    background: "background text",
    targetOutput: "a recommendation",
    rounds,
    reporterAgentId: reporterId,
    agentIds,
  };
}

interface FakeHostOptions {
  createScopeThrows?: boolean;
  closeThrows?: boolean;
  scopeStateAfterClose?: ScopeStatus["state"];
  /** F3: closeScope hangs until the passed signal aborts, then rejects (simulates
   * a Host close that never settles on its own). */
  closeHangUntilSignal?: boolean;
}

function makeFakeHost(
  opts: FakeHostOptions = {},
): OrchestratorHost & { closeCalls: number; createCalls: number; activateCalls: number } {
  let state: ScopeStatus["state"] = "active";
  const self = {
    closeCalls: 0,
    createCalls: 0,
    activateCalls: 0,
    async rawClient() {
      return null;
    },
    async refreshAuthForStream() {
      return { cookie: "councilkit_session=z", csrfToken: "c", origin: "http://127.0.0.1:43127" };
    },
    async listInstallations() {
      return {
        installations: [
          {
            installationId: "inst-kimi-1",
            driverId: "kimi-stream-json",
            state: "trusted",
            executablePath: null,
            fingerprint: null,
            components: [],
            detail: null,
          },
        ],
      };
    },
    async profileReadiness(): Promise<ResolveProfileResponse> {
      return {
        readiness: { state: "ready", detail: null },
        binding: {
          bindingDigest: "d",
          driverId: "kimi-stream-json",
          installationId: "inst-kimi-1",
          installationFingerprint: "f",
          capabilityDigest: "cd",
          requestedModel: "kimi-code/k3",
          canonicalModelId: "kimi-code/k3",
          modelAliases: [],
        },
        cachedAt: "2026-07-22T00:00:00.000Z",
      };
    },
    async createScope(): Promise<CreateScopeResponse> {
      self.createCalls += 1;
      if (opts.createScopeThrows) throw new Error("host gone");
      return {
        scopeId: "scope-1",
        controllerId: "ctrl-1",
        leaseEpoch: 1,
        scope: {
          scopeId: "scope-1",
          state: "creating",
          hostInstanceId: "h-1",
          leaseEpoch: 1,
          participants: [],
        },
      };
    },
    async activateScope(): Promise<ScopeStatus> {
      self.activateCalls += 1;
      state = "active";
      return {
        scopeId: "scope-1",
        state: "active",
        hostInstanceId: "h-1",
        leaseEpoch: 1,
        participants: [],
      };
    },
    async getScopeStatus(
      _scopeId: string,
      _options?: { signal?: AbortSignal },
    ): Promise<ScopeStatus> {
      return {
        scopeId: "scope-1",
        state,
        hostInstanceId: "h-1",
        leaseEpoch: 1,
        participants: [],
      };
    },
    async closeScope(
      _scopeId: string,
      _controller: { controllerId: string; leaseEpoch: number },
      options?: { signal?: AbortSignal },
    ): Promise<CloseScopeResponse> {
      self.closeCalls += 1;
      if (opts.closeThrows) throw new Error("close rejected");
      if (opts.closeHangUntilSignal) {
        const sig = options?.signal;
        if (sig?.aborted) throw new Error("close aborted");
        await new Promise<void>((_resolve, reject) => {
          sig?.addEventListener("abort", () => reject(new Error("close aborted")), {
            once: true,
          });
        });
        // Unreachable in practice: the listener rejects.
        throw new Error("close aborted");
      }
      state = opts.scopeStateAfterClose ?? "closed";
      return { scopeId: "scope-1", state };
    },
  };
  return self as unknown as OrchestratorHost & {
    closeCalls: number;
    createCalls: number;
    activateCalls: number;
  };
}

function evidence(output: string): TerminalEvidence {
  return {
    output,
    requestedModel: "kimi-code/k3",
    effectiveModel: "kimi-code/k3",
    modelVerdict: "match",
    toolState: "none",
    usage: { inputTokens: 5, outputTokens: 3 },
    finalSeq: 1,
  };
}

function completedResult(executionId: string, output: string): TurnResult {
  return {
    verdict: "completed",
    executionId,
    participantId: "p",
    dispatchState: "accepted",
    terminal: evidence(output),
    durationMs: 12,
    ack: "acknowledged",
    error: null,
  };
}

function failedResult(executionId: string, code: string): TurnResult {
  return {
    verdict: "failed",
    executionId,
    participantId: "p",
    dispatchState: "accepted",
    terminal: null,
    durationMs: 4,
    ack: "skipped",
    error: { phase: "terminal", code, message: `${code} boom`, retryable: false },
  };
}

interface Script {
  /** Return "completed" | "failed" | "ack-conflict" for a turn. */
  decide: (
    round: number,
    turnIndex: number,
    role: "message" | "report",
  ) => "completed" | "failed" | "ack-conflict";
  /** Optional hook to abort the run signal (SIGINT simulation). */
  onTurnDone?: (round: number, turnIndex: number, role: "message" | "report") => void;
}

function makeDriver(script: Script, calls: { count: number }): TurnDriver {
  return async (req: TurnRequest) => {
    calls.count += 1;
    const verdict = script.decide(req.round, req.turnIndex, req.role);
    if (verdict === "completed") {
      await req.persist(
        evidence(`output r${req.round}-t${req.turnIndex}-${req.agent.snapshot.name}`),
      );
      const r = completedResult(
        req.executionId,
        `output r${req.round}-t${req.turnIndex}-${req.agent.snapshot.name}`,
      );
      script.onTurnDone?.(req.round, req.turnIndex, req.role);
      return r;
    }
    if (verdict === "ack-conflict") {
      // persist landed, then the ACK failed → turn failed but output is durable.
      await req.persist(
        evidence(`output r${req.round}-t${req.turnIndex}-${req.agent.snapshot.name}`),
      );
      const r = completedResult(
        req.executionId,
        `output r${req.round}-t${req.turnIndex}-${req.agent.snapshot.name}`,
      );
      r.verdict = "failed";
      r.ack = "conflict";
      r.terminal = evidence(`output r${req.round}-t${req.turnIndex}-${req.agent.snapshot.name}`);
      r.error = { phase: "ack", code: "ACK_FAILED", message: "ack conflict", retryable: true };
      script.onTurnDone?.(req.round, req.turnIndex, req.role);
      return r;
    }
    // failed: no persist.
    script.onTurnDone?.(req.round, req.turnIndex, req.role);
    return failedResult(req.executionId, "DRIVER_CRASH");
  };
}

function buildInput(
  home: string,
  overrides: { rounds?: number; signal?: AbortSignal } = {},
): { input: RunInput; paths: ReturnType<typeof resolvePaths> } {
  const env = { ...process.env, COUNCILKIT_HOME: home };
  const paths = resolvePaths(env);
  const a = resolved(agent("a-alpha", "Alpha"));
  const b = resolved(agent("a-beta", "Beta"));
  const councilRec = council(["a-alpha", "a-beta"], "a-beta", overrides.rounds ?? 2);
  const input: RunInput = {
    runId: "ck-run-test",
    council: councilRec,
    agents: [a, b],
    reporter: b,
    rounds: overrides.rounds ?? 2,
  };
  return { input, paths };
}

function readTranscriptLines(home: string, runId: string): string[] {
  const paths = resolvePaths({ ...process.env, COUNCILKIT_HOME: home });
  const text = readFileSync(paths.transcript(runId), "utf8");
  return text.split("\n").filter((l) => l.length > 0);
}

function readReport(home: string, runId: string): string {
  const paths = resolvePaths({ ...process.env, COUNCILKIT_HOME: home });
  return readFileSync(paths.report(runId), "utf8");
}

describe("cli orchestrator", () => {
  let home: string;
  beforeEach(() => {
    home = newHome();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("2 agents × 2 rounds ⇒ 4 ordinary turns + 1 Reporter turn, exit 0", async () => {
    const host = makeFakeHost();
    const { input, paths } = buildInput(home);
    const calls = { count: 0 };
    const outcome = await runCouncil(input, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      turnDriver: makeDriver({ decide: () => "completed" }, calls),
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.exitCode).toBe(EXIT.ok);
    expect(outcome.turns).toHaveLength(5);
    expect(outcome.turns.filter((t) => t.role === "message")).toHaveLength(4);
    expect(outcome.turns.filter((t) => t.role === "report")).toHaveLength(1);
    expect(calls.count).toBe(5); // no duplicate execute
    expect(host.closeCalls).toBe(1); // closed exactly once
    const report = readReport(home, input.runId);
    expect(report).toContain("Alpha");
    expect(report).toContain("Beta");
    expect(report).toContain("- Status: complete");
    const lines = readTranscriptLines(home, input.runId);
    // run.started + 5 turn.completed + run.finished = 7
    expect(lines).toHaveLength(7);
    // transcript never carries canary/cookie footprints
    expect(lines.join("\n")).not.toContain("councilkit_session");
  });

  it("a mid-run ordinary-turn failure stops the Run, retains transcript, partial report, exit 4", async () => {
    const host = makeFakeHost();
    const { input, paths } = buildInput(home);
    const calls = { count: 0 };
    const outcome = await runCouncil(input, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      turnDriver: makeDriver(
        {
          decide: (round, turnIndex) => (round === 2 && turnIndex === 0 ? "failed" : "completed"),
        },
        calls,
      ),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    // 2 completed (round 1) + 1 failed (round 2 turn 0) = 3 turns scheduled
    expect(outcome.turns).toHaveLength(3);
    expect(calls.count).toBe(3);
    const report = readReport(home, input.runId);
    expect(report).toContain("INCOMPLETE RUN");
    const lines = readTranscriptLines(home, input.runId);
    // run.started + 2 turn.completed + run.finished = 4
    expect(lines.filter((l) => l.includes('"kind":"turn.completed"'))).toHaveLength(2);
    expect(lines.some((l) => l.includes('"kind":"run.finished"'))).toBe(true);
  });

  it("Reporter failure → INCOMPLETE partial report, exit 4", async () => {
    const host = makeFakeHost();
    const { input, paths } = buildInput(home);
    const outcome = await runCouncil(input, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      turnDriver: makeDriver(
        {
          decide: (_r, _t, role) => (role === "report" ? "failed" : "completed"),
        },
        { count: 0 },
      ),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.turns).toHaveLength(5);
    const report = readReport(home, input.runId);
    expect(report).toContain("INCOMPLETE RUN");
    // Reporter body is NOT fabricated into a partial report.
    expect(report).not.toContain("## Recommendation");
  });

  it("persist succeeded then ACK conflict → transcript retains the turn, exit 4", async () => {
    const host = makeFakeHost();
    const { input, paths } = buildInput(home);
    const outcome = await runCouncil(input, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      turnDriver: makeDriver(
        {
          decide: (round, turnIndex) =>
            round === 1 && turnIndex === 1 ? "ack-conflict" : "completed",
        },
        { count: 0 },
      ),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    // The ack-conflict turn WAS persisted (persist ran before the fail).
    const lines = readTranscriptLines(home, input.runId);
    expect(lines.filter((l) => l.includes('"kind":"turn.completed"'))).toHaveLength(2);
  });

  it("closeScope failure overrides a completed Run to non-success, exit 4", async () => {
    const host = makeFakeHost({ closeThrows: true });
    const { input, paths } = buildInput(home);
    const outcome = await runCouncil(input, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      turnDriver: makeDriver({ decide: () => "completed" }, { count: 0 }),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(host.closeCalls).toBe(1);
    // transcript + report artifacts preserved
    const lines = readTranscriptLines(home, input.runId);
    expect(lines.filter((l) => l.includes('"kind":"turn.completed"'))).toHaveLength(5);
    expect(existsSync(paths.report(input.runId))).toBe(true);
  });

  it("scope-create failure (Host gone) → exit 4, partial report, no turns", async () => {
    const host = makeFakeHost({ createScopeThrows: true });
    const { input, paths } = buildInput(home);
    const outcome = await runCouncil(input, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      turnDriver: makeDriver({ decide: () => "completed" }, { count: 0 }),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.turns).toHaveLength(0);
    expect(existsSync(paths.report(input.runId))).toBe(true);
    const report = readReport(home, input.runId);
    expect(report).toContain("INCOMPLETE RUN");
  });

  it("SIGINT mid-run → interrupted, exit 130, partial report", async () => {
    const host = makeFakeHost();
    const controller = new AbortController();
    const { input, paths } = buildInput(home, { signal: controller.signal });
    let abortedOnce = false;
    const outcome = await runCouncil(input, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      signal: controller.signal,
      turnDriver: makeDriver(
        {
          decide: () => "completed",
          onTurnDone: () => {
            if (!abortedOnce) {
              abortedOnce = true;
              controller.abort("SIGINT");
            }
          },
        },
        { count: 0 },
      ),
    });
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(EXIT.interrupted);
    expect(existsSync(paths.report(input.runId))).toBe(true);
    const report = readReport(home, input.runId);
    expect(report).toContain("INCOMPLETE RUN");
  });

  it("rejects a run with more than maxParticipantsPerScope agents (usage error)", async () => {
    const host = makeFakeHost();
    const tooMany: ResolvedAgent[] = [];
    for (let i = 0; i < 9; i += 1) tooMany.push(resolved(agent(`a-${i}`, `A${i}`)));
    const { paths } = buildInput(home);
    const input: RunInput = {
      runId: "ck-run-too-many",
      council: council(
        tooMany.map((a) => a.snapshot.id),
        tooMany[0].snapshot.id,
        1,
      ),
      agents: tooMany,
      reporter: tooMany[0],
      rounds: 1,
    };
    await expect(
      runCouncil(input, {
        host,
        paths,
        env: { ...process.env, COUNCILKIT_HOME: home },
        turnDriver: makeDriver({ decide: () => "completed" }, { count: 0 }),
      }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("exits 7 on a RESOURCE_LIMIT failure code", async () => {
    const host = makeFakeHost();
    const { input, paths } = buildInput(home);
    const driver: TurnDriver = async (req) => {
      if (req.round === 1 && req.turnIndex === 0) {
        return {
          verdict: "failed",
          executionId: req.executionId,
          participantId: "p",
          dispatchState: "accepted",
          terminal: null,
          durationMs: 1,
          ack: "skipped",
          error: { phase: "terminal", code: "RESOURCE_LIMIT", message: "quota", retryable: false },
        };
      }
      await req.persist(evidence("ok"));
      return completedResult(req.executionId, "ok");
    };
    const outcome = await runCouncil(input, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      turnDriver: driver,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.quota);
  });

  it("bounds a hanging closeScope by the shared cleanup budget and still exits (F3)", async () => {
    const host = makeFakeHost({ closeHangUntilSignal: true });
    const controller = new AbortController();
    const { input, paths } = buildInput(home, { signal: controller.signal });
    let abortedOnce = false;
    const outcome = await runCouncil(input, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      signal: controller.signal,
      cleanupBudgetMs: 50,
      turnDriver: makeDriver(
        {
          decide: () => "completed",
          onTurnDone: () => {
            if (!abortedOnce) {
              abortedOnce = true;
              controller.abort("SIGINT");
            }
          },
        },
        { count: 0 },
      ),
    });
    // The run terminates despite a closeScope that never settles on its own —
    // the shared ≤50ms cleanup budget aborts it. Never a hang.
    expect([EXIT.interrupted, EXIT.runFailed]).toContain(outcome.exitCode);
    expect(host.closeCalls).toBe(1);
    expect(existsSync(paths.report(input.runId))).toBe(true);
  });

  it("writes the canonical report BEFORE the Reporter committed ACK (F2)", async () => {
    const host = makeFakeHost();
    const { input, paths } = buildInput(home);
    let reportOnDiskAtAck = "<not-captured>";
    const driver: TurnDriver = async (req) => {
      await req.persist(evidence("reporter body"));
      // By the time the (fake) committed ACK would happen — i.e. right after
      // persist returned — the canonical report must already be on disk.
      if (req.role === "report") {
        reportOnDiskAtAck = existsSync(paths.report(input.runId))
          ? readFileSync(paths.report(input.runId), "utf8")
          : "<missing>";
      }
      return completedResult(req.executionId, `out ${req.role}`);
    };
    await runCouncil(input, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      turnDriver: driver,
    });
    expect(reportOnDiskAtAck).not.toBe("<missing>");
    expect(reportOnDiskAtAck).toContain("- Status: complete");
  });

  it("maps a transcript IO turn failure (phase=io) to exit 5 (F5)", async () => {
    const host = makeFakeHost();
    const { input, paths } = buildInput(home);
    // Simulate what executeTurn now produces when the transcript write fails
    // mid-persist: a turn failure classified phase=io. The run boundary must map
    // that to exit 5, not exit 4.
    const driver: TurnDriver = async (req) => {
      if (req.role === "message" && req.round === 1 && req.turnIndex === 0) {
        return {
          verdict: "failed",
          executionId: req.executionId,
          participantId: "p",
          dispatchState: "accepted",
          terminal: null,
          durationMs: 1,
          ack: "skipped",
          error: { phase: "io", code: "TRANSCRIPT_IO", message: "ENOSPC", retryable: false },
        };
      }
      await req.persist(evidence("ok"));
      return completedResult(req.executionId, "ok");
    };
    const outcome = await runCouncil(input, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      turnDriver: driver,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.io);
    expect(outcome.failure?.phase).toBe("io");
  });

  it("recomputes incomplete after a --out copy failure flips status to failed (F6)", async () => {
    const host = makeFakeHost();
    const { input, paths } = buildInput(home);
    // `sub` is a regular FILE, so writing `${home}/sub/report.md` cannot create
    // the parent dir → the --out copy fails (atomicWriteFile throws).
    writeFileSync(join(home, "sub"), "i am a file, not a directory");
    const runInput: RunInput = { ...input, outPath: join(home, "sub", "report.md") };
    const outcome = await runCouncil(runInput, {
      host,
      paths,
      env: { ...process.env, COUNCILKIT_HOME: home },
      turnDriver: makeDriver({ decide: () => "completed" }, { count: 0 }),
    });
    // All turns succeeded, but the --out copy failed → failed / exit 5, and the
    // outcome + canonical report reflect the FINAL failed status (not complete).
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.io);
    expect(outcome.incomplete).toBe(true);
    const report = readReport(home, input.runId);
    expect(report).toContain("INCOMPLETE RUN");
    expect(report).not.toContain("- Status: complete");
  });
});
