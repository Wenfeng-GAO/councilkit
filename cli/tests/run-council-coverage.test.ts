/**
 * Run-path coverage for cli/src/run: runCouncil sequencing, failure exits,
 * resolveRunAgents, and buildProfile. Host and turn I/O are fakes. Digests,
 * reports, and transcript records are exact literals.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reportInterruptionLine } from "@shared/runtime/interruption-copy";
import type {
  CreateScopeRequest,
  CreateScopeResponse,
  InstallationsResponse,
  ResolveProfileResponse,
  ScopeStatus,
} from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError, EXIT } from "../src/errors";
import type { TerminalEvidence, TurnResult } from "../src/host/execute-turn";
import {
  type OrchestratorHost,
  type TurnDriver,
  type TurnRequest,
  buildProfile,
  clipFailureMessage,
  resolveRunAgents,
  runCouncil,
} from "../src/run/orchestrator";
import type {
  CouncilSnapshot,
  ResolvedAgent,
  RunInput,
  RunOutcome,
  RunProgressEvent,
} from "../src/run/types";
import * as atomicWriteModule from "../src/store/atomic-write";
import { type StorePaths, resolvePaths } from "../src/store/paths";
import type { AgentRecord } from "../src/store/schemas";

const NOW = "2026-03-04T05:06:07.000Z";
const ENDED = "2026-03-04T05:06:08.000Z";
const RUN_ID = "ck-run-cov-1";
const PERSONA_DIGEST = "f52ba562857c9c955ab230bdb4d85221e8d81d006340060e42f80309723f2209";
const EMPTY_PERSONA_DIGEST = "11e9789c29a6b00368a0a0ddaf0ea90b60b0430cc5099ba0c7ca1aeb0105decc";
const BETA_DIGEST = "3856ba3fa51c5b58e658f30d838e92373337d7bbf187783683fc01cd9577ea8c";
const MESSAGE_DIGEST = "93da24822f94040fb2bd2c35e6c2f5369bb3163953ababcee48dc4272d8dfebe";
const REPORTER_DIGEST = "bbcabcdd2b8ad698801af0434aab7a911657e391abd12322295bab7d2ecd9aaf";
const CONTEXT_DIGEST = "88b18ed849958ec8770580973dbd7a4dc93ee9b16e44f108edc075d5569b750d";
const AFTER_SPEECH_DIGEST = "a1da61b3a36228edf1e737097c96f42f368a9fc22a37e361cf622382c96ed886";
const BLANK_BG_DIGEST = "c289db6bea81026ea71670cbf83c1687287baeb65dbacd76eef8c2970378efa4";
const EMPTY_TOPIC_DIGEST = "552db4d71c3e60783d58023da16b113b698ebcf26e02ad7280fe627d09908182";

const MESSAGE_TEXT =
  'You are "Alpha" in a structured multi-agent council on the topic: pick a route. Your role/stance: Alpha persona This is round 1 of 1. Read the full shared context above (topic, background, target output, and every prior speech). Then give YOUR independent position for this round: challenge, supplement, or diverge from prior points where warranted — do not merely agree. Output only the body of your speech. Keep it concise to control cost.';

const REPORTER_TEXT = [
  'You are "Alpha", the Reporter of a structured multi-agent council on the topic: pick a route.',
  "All ordinary discussion rounds are complete. The shared context above contains every agent's speeches.",
  "Produce the final decision report as Markdown. It MUST strictly contain the following nine sections, each starting with a level-2 Markdown heading (## …), in this exact order:",
  [
    "## Background（背景）",
    "## Discussion goal（讨论目标）",
    "## Participating agents（参与角色）",
    "## Discussion summary（讨论摘要）",
    "## Key consensus（关键共识）",
    "## Remaining disagreements（未决分歧）",
    "## Recommendation（推荐）",
    "## Risks and objections（风险与异议）",
    "## Next actions（下一步行动）",
  ].join("\n"),
  'In "Participating agents" and throughout the report, explicitly reference the participating agents by name and cite their points:',
  "- Alpha",
  "Do not fabricate consensus that the discussion did not reach. Where agents disagreed, surface the disagreement. Output only the report body.",
  "Target output: one page",
].join("\n");

const CONTEXT_CONTENT =
  "Topic: pick a route\n\nBackground:\ncost pressure\n\nTarget output:\none page\n\nParticipating agents:\n- Alpha (participant p-alpha)";

const SUCCESS_REPORT = [
  "# Council Report",
  "",
  "- Run: ck-run-cov-1",
  "- Council: cov-council (c-1)",
  "- Topic: pick a route",
  "- Reporter: Alpha",
  "- Participants: Alpha",
  "- Status: complete",
  "- Started: 2026-03-04T05:06:07.000Z",
  "- Ended: 2026-03-04T05:06:08.000Z",
  "---",
  "",
  "## Recommendation",
  "ship it",
  "",
].join("\n");

const NO_SPEECHES = [
  "## Completed speeches",
  "",
  "_No ordinary turn completed before the run stopped._",
  "",
];

const ONE_SPEECH = [
  "## Completed speeches",
  "",
  "### Round 1 — Alpha (participant p-alpha)",
  "",
  "alpha speech",
  "",
];

const INSTALLATION = {
  installationId: "inst-kimi-1",
  driverId: "kimi-stream-json" as const,
  state: "trusted" as const,
  executablePath: null,
  fingerprint: null,
  components: [],
  detail: null,
};

function expectedPartial(
  failure: { phase: string; code: string; message: string },
  speeches: string[],
  endedAt = NOW,
  interruption: string | null = null,
): string {
  return [
    "# Council Report",
    "",
    `- Run: ${RUN_ID}`,
    "- Council: cov-council (c-1)",
    "- Topic: pick a route",
    "- Reporter: Alpha",
    "- Participants: Alpha",
    "- Status: incomplete",
    `- Started: ${NOW}`,
    `- Ended: ${endedAt}`,
    "",
    "> INCOMPLETE RUN — discussion stopped before the Reporter completed. What follows is a deterministic partial report built from the persisted transcript; no consensus is fabricated and the Reporter did not produce a final summary.",
    "",
    ...speeches,
    "## Failure",
    "",
    ...(interruption ? [`- ${interruption}`] : []),
    `- Phase: ${failure.phase}`,
    `- Code: ${failure.code}`,
    `- Message: ${failure.message}`,
    "",
    "## Next diagnostics",
    "",
    "- Inspect `transcript.jsonl` for the persisted turns and the `run.finished` record.",
    "- Re-run with a fresh Run id after resolving the failure (V1.1 has no `--resume`).",
    "",
  ].join("\n");
}

function fixedNow(): Date {
  return new Date(NOW);
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a-alpha",
    name: "Alpha",
    personaPrompt: "Alpha persona",
    modelId: "kimi-code/k3",
    color: "#112233",
    enabled: true,
    driverSelection: { driverId: "kimi-stream-json", options: {} },
    ...overrides,
  };
}

function resolved(snapshot: AgentRecord = agent(), participantId = "p-alpha"): ResolvedAgent {
  return {
    snapshot,
    profile: {
      driverId: "kimi-stream-json",
      installationId: "inst-kimi-1",
      credentialMode: "installation-managed",
      options: {},
    },
    installationId: "inst-kimi-1",
    participantId,
    participantSnapshotDigest:
      snapshot.personaPrompt.length > 0 ? PERSONA_DIGEST : EMPTY_PERSONA_DIGEST,
  };
}

function council(overrides: Partial<CouncilSnapshot> = {}): CouncilSnapshot {
  return {
    id: "c-1",
    name: "cov-council",
    topic: "pick a route",
    background: "cost pressure",
    targetOutput: "one page",
    rounds: 1,
    reporterAgentId: "a-alpha",
    agentIds: ["a-alpha"],
    ...overrides,
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

function completed(executionId: string, output: string): TurnResult {
  return {
    verdict: "completed",
    executionId,
    participantId: "p-alpha",
    dispatchState: "accepted",
    terminal: evidence(output),
    durationMs: 12,
    ack: "acknowledged",
    error: null,
  };
}

function failedTurn(
  executionId: string,
  verdict: TurnResult["verdict"] = "failed",
  error: TurnResult["error"] = {
    phase: "terminal",
    code: "DRIVER_CRASH",
    message: "DRIVER_CRASH boom",
    retryable: false,
  },
): TurnResult {
  return {
    verdict,
    executionId,
    participantId: "p-alpha",
    dispatchState: "accepted",
    terminal: null,
    durationMs: 4,
    ack: "skipped",
    error,
  };
}

const READY: ResolveProfileResponse = {
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
  cachedAt: NOW,
};

interface HostOpts {
  createErrors?: unknown[];
  hangFirstCreate?: boolean;
  activate?: "ok" | "hang" | "throw";
  close?: "ok" | "throw" | "hang";
  status?: "follow" | "throw" | "active";
  onActivate?: () => void;
  onClose?: () => void;
  signal?: AbortSignal;
}

interface HostBox {
  host: OrchestratorHost;
  create: CreateScopeRequest[];
  closeCalls: number;
  activateCalls: number;
  statusCalls: number;
}

function scopeStatus(state: ScopeStatus["state"]): ScopeStatus {
  return {
    scopeId: "scope-1",
    state,
    hostInstanceId: "h-1",
    leaseEpoch: 1,
    participants: [],
  };
}

function createdScope(): CreateScopeResponse {
  return {
    scopeId: "scope-1",
    controllerId: "ctrl-1",
    leaseEpoch: 1,
    scope: scopeStatus("creating"),
  };
}

function makeHost(opts: HostOpts = {}): HostBox {
  const box: HostBox = {
    host: undefined as unknown as OrchestratorHost,
    create: [],
    closeCalls: 0,
    activateCalls: 0,
    statusCalls: 0,
  };
  let createN = 0;
  let state: ScopeStatus["state"] = "active";
  const host: OrchestratorHost = {
    async rawClient() {
      return null;
    },
    async refreshAuthForStream() {
      return { cookie: "councilkit_session=z", csrfToken: "t", origin: "http://127.0.0.1:9" };
    },
    async listInstallations() {
      return { installations: [INSTALLATION] };
    },
    async profileReadiness() {
      return READY;
    },
    async createScope(request) {
      box.create.push(request);
      createN += 1;
      if (opts.hangFirstCreate && createN === 1) return new Promise(() => {});
      if (opts.createErrors && createN <= opts.createErrors.length) {
        throw opts.createErrors[createN - 1];
      }
      return createdScope();
    },
    async activateScope() {
      box.activateCalls += 1;
      if (opts.activate === "hang") return new Promise(() => {});
      if (opts.activate === "throw") throw new Error("activate down");
      opts.onActivate?.();
      state = "active";
      return scopeStatus("active");
    },
    async getScopeStatus() {
      box.statusCalls += 1;
      if (opts.status === "throw") throw new Error("status down");
      return scopeStatus(opts.status === "active" ? "active" : state);
    },
    async closeScope(_scopeId, _controller, options) {
      box.closeCalls += 1;
      opts.onClose?.();
      if (opts.close === "throw") throw new Error("close rejected");
      if (opts.close === "hang") {
        const sig = options?.signal;
        if (sig?.aborted) throw new Error("close aborted");
        await new Promise<void>((_resolve, reject) => {
          sig?.addEventListener("abort", () => reject(new Error("close aborted")), { once: true });
        });
        throw new Error("close aborted");
      }
      state = "closed";
      return { scopeId: "scope-1", state: "closed" as const };
    },
  };
  box.host = host;
  return box;
}

function defaultDriver(seen: TurnRequest[]): TurnDriver {
  return async (req) => {
    seen.push(req);
    const output = req.role === "report" ? "## Recommendation\nship it" : "alpha speech";
    await req.persist(evidence(output));
    return completed(req.executionId, output);
  };
}

interface RunOpts {
  agents?: ResolvedAgent[];
  reporter?: ResolvedAgent;
  council?: CouncilSnapshot;
  rounds?: number;
  outPath?: string;
  signal?: AbortSignal;
  now?: () => Date;
  ids?: string[];
  cleanupBudgetMs?: number;
  host?: HostOpts;
  driver?: TurnDriver | "real";
  paths?: StorePaths;
  onProgress?: (event: RunProgressEvent) => void;
  seen?: TurnRequest[];
}

function envFor(home: string): NodeJS.ProcessEnv {
  return { ...process.env, COUNCILKIT_HOME: home };
}

async function runAt(
  home: string,
  opts: RunOpts = {},
): Promise<{
  outcome: RunOutcome;
  paths: StorePaths;
  box: HostBox;
  seen: TurnRequest[];
  events: RunProgressEvent[];
}> {
  const env = envFor(home);
  const paths = opts.paths ?? resolvePaths(env);
  const agents = opts.agents ?? [resolved()];
  const input: RunInput = {
    runId: RUN_ID,
    council: opts.council ?? council(),
    agents,
    reporter: opts.reporter ?? (agents[0] as ResolvedAgent),
    rounds: opts.rounds ?? 1,
    ...(opts.outPath ? { outPath: opts.outPath } : {}),
  };
  const ids = [...(opts.ids ?? ["11111111-aaaa", "22222222-bbbb", "33333333-cccc"])];
  const box = makeHost({ ...opts.host, signal: opts.signal });
  const seen = opts.seen ?? [];
  const events: RunProgressEvent[] = [];
  const outcome = await runCouncil(input, {
    host: box.host,
    paths,
    env,
    now: opts.now ?? fixedNow,
    signal: opts.signal,
    cleanupBudgetMs: opts.cleanupBudgetMs,
    idFactory: () => {
      const id = ids.shift();
      if (id === undefined) throw new Error("id factory exhausted");
      return id;
    },
    onProgress: (event) => {
      events.push(event);
      opts.onProgress?.(event);
    },
    ...(opts.driver === "real" ? {} : { turnDriver: opts.driver ?? defaultDriver(seen) }),
  });
  return { outcome, paths, box, seen, events };
}

function startedRecord(): Record<string, unknown> {
  return {
    kind: "run.started",
    version: 1,
    runId: RUN_ID,
    startedAt: NOW,
    council: {
      id: "c-1",
      name: "cov-council",
      topic: "pick a route",
      background: "cost pressure",
      targetOutput: "one page",
      rounds: 1,
      reporterAgentId: "a-alpha",
      agentIds: ["a-alpha"],
    },
    agents: [agent()],
    installationId: "inst-kimi-1",
    installations: { "a-alpha": "inst-kimi-1" },
  };
}

function readJsonl(file: string): unknown[] {
  const text = readFileSync(file, "utf8");
  expect(text.endsWith("\n")).toBe(true);
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

function expectCli(
  error: unknown,
  message: string,
  exitCode: number,
  detail?: Record<string, unknown>,
): void {
  expect(error).toBeInstanceOf(CliError);
  const cli = error as CliError;
  expect(cli.message).toBe(message);
  expect(cli.exitCode).toBe(exitCode);
  if (detail === undefined) expect(cli.detail).toBeUndefined();
  else expect(cli.detail).toEqual(detail);
}

describe("run council coverage", () => {
  let home: string;

  beforeEach(() => {
    const parent = mkdtempSync(join(tmpdir(), "ck-run-cov-"));
    chmodSync(parent, 0o700);
    home = mkdtempSync(join(parent, "home-"));
    chmodSync(home, 0o700);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dirname(home), { recursive: true, force: true });
  });

  it("completes one ordinary turn and the reporter, then copies the report", async () => {
    let tick = 0;
    const stamps = [NOW, ENDED];
    const seen: TurnRequest[] = [];
    const outPath = join(home, "copy", "report.md");
    const { outcome, paths, box, events } = await runAt(home, {
      outPath,
      seen,
      now: () => new Date(tick++ === 0 ? stamps[0] : stamps[1]),
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      status: "completed",
      exitCode: EXIT.ok,
      runId: RUN_ID,
      reportPath: paths.report(RUN_ID),
      transcriptPath: paths.transcript(RUN_ID),
      startedAt: NOW,
      endedAt: ENDED,
      turns: [
        {
          role: "message",
          round: 1,
          turnIndex: 0,
          agentId: "a-alpha",
          agentName: "Alpha",
          verdict: "completed",
          effectiveModel: "kimi-code/k3",
          durationMs: 12,
        },
        {
          role: "report",
          round: 1,
          turnIndex: 1,
          agentId: "a-alpha",
          agentName: "Alpha",
          verdict: "completed",
          effectiveModel: "kimi-code/k3",
          durationMs: 12,
        },
      ],
      installations: { "a-alpha": "inst-kimi-1" },
      failure: null,
      artifactIoFailure: null,
      incomplete: false,
    });
    expect(events).toEqual([
      { type: "run.starting", runId: RUN_ID, council: "cov-council" },
      { type: "round.start", round: 1, totalRounds: 1 },
      { type: "turn.start", round: 1, turnIndex: 0, agent: "Alpha", role: "message" },
      {
        type: "turn.done",
        round: 1,
        turnIndex: 0,
        agent: "Alpha",
        verdict: "completed",
        durationMs: 12,
      },
      { type: "turn.start", round: 1, turnIndex: 1, agent: "Alpha", role: "report" },
      {
        type: "turn.done",
        round: 1,
        turnIndex: 1,
        agent: "Alpha",
        verdict: "completed",
        durationMs: 12,
      },
      { type: "report.writing", runId: RUN_ID },
      { type: "run.finishing", status: "completed" },
    ]);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(SUCCESS_REPORT);
    expect(readFileSync(outPath, "utf8")).toBe(SUCCESS_REPORT);
    expect(box.closeCalls).toBe(1);
    expect(box.activateCalls).toBe(1);
    expect(box.create).toEqual([
      {
        scopeRequestId: "ck-run-ck-run-cov-1-11111111",
        participants: [
          {
            participantId: "p-alpha",
            profile: {
              driverId: "kimi-stream-json",
              installationId: "inst-kimi-1",
              credentialMode: "installation-managed",
              options: {},
            },
            modelId: "kimi-code/k3",
            personaPrompt: "Alpha persona",
          },
        ],
      },
    ]);
    expect(seen.map((req) => req.snapshot)).toEqual([
      {
        digestVersion: 1,
        roomContext: {
          contextRevision: 0,
          contextDigest: CONTEXT_DIGEST,
          topic: "pick a route",
          items: [{ id: `${RUN_ID}:context`, role: "user", content: CONTEXT_CONTENT }],
        },
        participant: {
          participantId: "p-alpha",
          participantSnapshotDigest: PERSONA_DIGEST,
          personaPrompt: "Alpha persona",
        },
        instruction: { kind: "message", instructionDigest: MESSAGE_DIGEST, text: MESSAGE_TEXT },
      },
      {
        digestVersion: 1,
        roomContext: {
          contextRevision: 1,
          contextDigest: AFTER_SPEECH_DIGEST,
          topic: "pick a route",
          items: [
            { id: `${RUN_ID}:context`, role: "user", content: CONTEXT_CONTENT },
            {
              id: `${RUN_ID}:turn:1`,
              role: "participant",
              participantId: "p-alpha",
              content: "alpha speech",
              sourceExecutionId: "ck-exec-22222222-bbbb",
            },
          ],
        },
        participant: {
          participantId: "p-alpha",
          participantSnapshotDigest: PERSONA_DIGEST,
          personaPrompt: "Alpha persona",
        },
        instruction: { kind: "summary", instructionDigest: REPORTER_DIGEST, text: REPORTER_TEXT },
      },
    ]);
    expect(readJsonl(paths.transcript(RUN_ID))).toEqual([
      {
        kind: "run.started",
        version: 1,
        runId: RUN_ID,
        startedAt: NOW,
        council: {
          id: "c-1",
          name: "cov-council",
          topic: "pick a route",
          background: "cost pressure",
          targetOutput: "one page",
          rounds: 1,
          reporterAgentId: "a-alpha",
          agentIds: ["a-alpha"],
        },
        agents: [agent()],
        installationId: "inst-kimi-1",
        installations: { "a-alpha": "inst-kimi-1" },
      },
      {
        kind: "turn.completed",
        seq: 0,
        completedAt: NOW,
        round: 1,
        turnIndex: 0,
        role: "message",
        agentId: "a-alpha",
        agentName: "Alpha",
        participantId: "p-alpha",
        executionId: "ck-exec-22222222-bbbb",
        output: "alpha speech",
        requestedModel: "kimi-code/k3",
        effectiveModel: "kimi-code/k3",
        modelVerdict: "match",
        toolState: "none",
        durationMs: 12,
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      {
        kind: "turn.completed",
        seq: 1,
        completedAt: NOW,
        round: 1,
        turnIndex: 1,
        role: "report",
        agentId: "a-alpha",
        agentName: "Alpha",
        participantId: "p-alpha",
        executionId: "ck-exec-33333333-cccc",
        output: "## Recommendation\nship it",
        requestedModel: "kimi-code/k3",
        effectiveModel: "kimi-code/k3",
        modelVerdict: "match",
        toolState: "none",
        durationMs: 12,
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      {
        kind: "run.finished",
        status: "completed",
        endedAt: ENDED,
        reportPath: paths.report(RUN_ID),
        incomplete: false,
      },
    ]);
  });

  it("omits an empty persona from the scope request and the snapshot", async () => {
    const bare = resolved(agent({ personaPrompt: "" }));
    const seen: TurnRequest[] = [];
    const { box } = await runAt(home, {
      agents: [bare],
      reporter: bare,
      seen,
      driver: async (req) => {
        seen.push(req);
        return failedTurn(req.executionId);
      },
    });
    expect(box.create[0]?.participants).toEqual([
      {
        participantId: "p-alpha",
        profile: {
          driverId: "kimi-stream-json",
          installationId: "inst-kimi-1",
          credentialMode: "installation-managed",
          options: {},
        },
        modelId: "kimi-code/k3",
        personaPrompt: undefined,
      },
    ]);
    expect(seen[0]?.snapshot.participant).toEqual({
      participantId: "p-alpha",
      participantSnapshotDigest: EMPTY_PERSONA_DIGEST,
    });
    expect(seen[0]?.snapshot.instruction.text).toBe(
      'You are "Alpha" in a structured multi-agent council on the topic: pick a route. Your role/stance: (unspecified). This is round 1 of 1. Read the full shared context above (topic, background, target output, and every prior speech). Then give YOUR independent position for this round: challenge, supplement, or diverge from prior points where warranted — do not merely agree. Output only the body of your speech. Keep it concise to control cost.',
    );
  });

  it("drops whitespace-only background and target output from the context item", async () => {
    const seen: TurnRequest[] = [];
    await runAt(home, {
      council: council({ background: " \n", targetOutput: "\t" }),
      seen,
      driver: async (req) => {
        seen.push(req);
        return failedTurn(req.executionId);
      },
    });
    expect(seen[0]?.snapshot.roomContext).toEqual({
      contextRevision: 0,
      contextDigest: BLANK_BG_DIGEST,
      topic: "pick a route",
      items: [
        {
          id: `${RUN_ID}:context`,
          role: "user",
          content: "Topic: pick a route\n\nParticipating agents:\n- Alpha (participant p-alpha)",
        },
      ],
    });
  });

  it("omits an empty topic from the wire room context", async () => {
    const seen: TurnRequest[] = [];
    await runAt(home, {
      council: council({ topic: "" }),
      seen,
      driver: async (req) => {
        seen.push(req);
        return failedTurn(req.executionId);
      },
    });
    expect(seen[0]?.snapshot.roomContext).toEqual({
      contextRevision: 0,
      contextDigest: EMPTY_TOPIC_DIGEST,
      items: [
        {
          id: `${RUN_ID}:context`,
          role: "user",
          content:
            "Topic: \n\nBackground:\ncost pressure\n\nTarget output:\none page\n\nParticipating agents:\n- Alpha (participant p-alpha)",
        },
      ],
    });
  });

  it("stops on an ordinary-turn failure and writes the partial report", async () => {
    const { outcome, paths, events } = await runAt(home, {
      driver: async (req) => failedTurn(req.executionId),
    });
    const failure = { phase: "terminal", code: "DRIVER_CRASH", message: "DRIVER_CRASH boom" };
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject(failure);
    expect(outcome.artifactIoFailure).toBeNull();
    expect(outcome.incomplete).toBe(true);
    expect(outcome.turns).toEqual([
      {
        role: "message",
        round: 1,
        turnIndex: 0,
        agentId: "a-alpha",
        agentName: "Alpha",
        verdict: "failed",
        effectiveModel: null,
        durationMs: 4,
      },
    ]);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, NO_SPEECHES));
    expect(events).toEqual([
      { type: "run.starting", runId: RUN_ID, council: "cov-council" },
      { type: "round.start", round: 1, totalRounds: 1 },
      { type: "turn.start", round: 1, turnIndex: 0, agent: "Alpha", role: "message" },
      {
        type: "turn.done",
        round: 1,
        turnIndex: 0,
        agent: "Alpha",
        verdict: "failed",
        durationMs: 4,
      },
      { type: "report.writing", runId: RUN_ID },
      { type: "run.finishing", status: "failed" },
    ]);
    expect(readJsonl(paths.transcript(RUN_ID))).toEqual([
      startedRecord(),
      {
        kind: "run.finished",
        status: "failed",
        endedAt: NOW,
        failure,
        reportPath: paths.report(RUN_ID),
        incomplete: true,
      },
    ]);
  });

  it("records TURN_NOT_COMPLETED when a failed turn has no error", async () => {
    const { outcome, paths } = await runAt(home, {
      driver: async (req) => failedTurn(req.executionId, "failed", null),
    });
    const failure = { phase: "turn", code: "TURN_NOT_COMPLETED", message: "turn verdict failed" };
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject(failure);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, NO_SPEECHES));
  });

  it("maps an interrupted turn verdict without a signal to status interrupted and exit 4", async () => {
    const { outcome } = await runAt(home, {
      driver: async (req) =>
        failedTurn(req.executionId, "interrupted", {
          phase: "terminal",
          code: "CANCELLED",
          message: "cancelled by caller",
          retryable: false,
        }),
    });
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject({
      phase: "terminal",
      code: "CANCELLED",
      message: "cancelled by caller",
    });
  });

  it("maps a cancelled turn verdict without an error to exit 4", async () => {
    const { outcome, paths } = await runAt(home, {
      driver: async (req) => failedTurn(req.executionId, "cancelled", null),
    });
    const failure = {
      phase: "turn",
      code: "TURN_NOT_COMPLETED",
      message: "turn verdict cancelled",
    };
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject(failure);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, NO_SPEECHES));
  });

  it("maps a timeout verdict to a failed run", async () => {
    const { outcome } = await runAt(home, {
      driver: async (req) =>
        failedTurn(req.executionId, "timeout", {
          phase: "deadline",
          code: "TURN_TIMEOUT",
          message: "turn deadline exceeded",
          retryable: true,
        }),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject({
      phase: "deadline",
      code: "TURN_TIMEOUT",
      message: "turn deadline exceeded",
    });
  });

  it("exits 7 when the turn error code is RESOURCE_LIMIT or RATE_LIMITED", async () => {
    const limited = await runAt(home, {
      driver: async (req) =>
        failedTurn(req.executionId, "failed", {
          phase: "terminal",
          code: "RESOURCE_LIMIT",
          message: "over quota",
          retryable: true,
        }),
    });
    expect(limited.outcome.exitCode).toBe(EXIT.quota);
    expect(limited.outcome.failure).toMatchObject({
      phase: "terminal",
      code: "RESOURCE_LIMIT",
      message: "over quota",
    });
    const rated = await runAt(home, {
      driver: async (req) =>
        failedTurn(req.executionId, "failed", {
          phase: "dispatch",
          code: "RATE_LIMITED",
          message: "slow down",
          retryable: true,
        }),
    });
    expect(rated.outcome.exitCode).toBe(EXIT.quota);
    expect(rated.outcome.failure).toMatchObject({
      phase: "dispatch",
      code: "RATE_LIMITED",
      message: "slow down",
    });
  });

  it("prefers the external abort over a failed turn", async () => {
    const controller = new AbortController();
    const { outcome, paths } = await runAt(home, {
      signal: controller.signal,
      driver: async (req) => {
        controller.abort("SIGINT");
        return failedTurn(req.executionId, "failed", null);
      },
    });
    const failure = {
      phase: "signal",
      code: "INTERRUPTED",
      message: "interrupted by signal (SIGINT/SIGTERM)",
    };
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(EXIT.interrupted);
    expect(outcome.failure).toMatchObject(failure);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, NO_SPEECHES));
  });

  it("interrupts after the ordinary turn when the signal aborts before the reporter", async () => {
    const controller = new AbortController();
    const { outcome, paths } = await runAt(home, {
      signal: controller.signal,
      driver: async (req) => {
        await req.persist(evidence("alpha speech"));
        controller.abort("SIGINT");
        return completed(req.executionId, "alpha speech");
      },
    });
    const failure = {
      phase: "signal",
      code: "INTERRUPTED",
      message: "interrupted by signal (SIGINT/SIGTERM)",
    };
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(EXIT.interrupted);
    expect(outcome.turns.map((turn) => turn.role)).toEqual(["message"]);
    expect(outcome.failure).toMatchObject(failure);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, ONE_SPEECH));
  });

  it("stops when the reporter fails and does not invent a recommendation", async () => {
    const { outcome, paths } = await runAt(home, {
      driver: async (req) => {
        if (req.role === "message") {
          await req.persist(evidence("alpha speech"));
          return completed(req.executionId, "alpha speech");
        }
        return failedTurn(req.executionId);
      },
    });
    const failure = { phase: "terminal", code: "DRIVER_CRASH", message: "DRIVER_CRASH boom" };
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.turns.map((turn) => [turn.role, turn.verdict])).toEqual([
      ["message", "completed"],
      ["report", "failed"],
    ]);
    // B4 #339: the report turn's crash carries the shared interruption wording.
    expect(outcome.failure).toMatchObject({ ...failure, role: "report" });
    const interruption = reportInterruptionLine(outcome.failure ?? failure);
    expect(interruption).toMatch(/^报告生成被中断（模型进程意外退出）：.+在写完报告前退出了。$/);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(
      expectedPartial(failure, ONE_SPEECH, NOW, interruption),
    );
  });

  it("uses REPORTER_NOT_COMPLETED when the reporter returns no error", async () => {
    const { outcome } = await runAt(home, {
      driver: async (req) => {
        if (req.role === "message") {
          await req.persist(evidence("alpha speech"));
          return completed(req.executionId, "alpha speech");
        }
        return failedTurn(req.executionId, "failed", null);
      },
    });
    expect(outcome.failure).toMatchObject({
      phase: "reporter",
      code: "REPORTER_NOT_COMPLETED",
      message: "reporter verdict failed",
    });
    expect(outcome.exitCode).toBe(EXIT.runFailed);
  });

  it("keeps a persisted turn when the ack then conflicts", async () => {
    const { outcome, paths } = await runAt(home, {
      driver: async (req) => {
        await req.persist(evidence("alpha speech"));
        return {
          ...completed(req.executionId, "alpha speech"),
          verdict: "failed",
          ack: "conflict",
          error: { phase: "ack", code: "ACK_FAILED", message: "ack conflict", retryable: true },
        };
      },
    });
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject({
      phase: "ack",
      code: "ACK_FAILED",
      message: "ack conflict",
    });
    expect(readJsonl(paths.transcript(RUN_ID))).toEqual([
      startedRecord(),
      {
        kind: "turn.completed",
        seq: 0,
        completedAt: NOW,
        round: 1,
        turnIndex: 0,
        role: "message",
        agentId: "a-alpha",
        agentName: "Alpha",
        participantId: "p-alpha",
        executionId: "ck-exec-22222222-bbbb",
        output: "alpha speech",
        requestedModel: "kimi-code/k3",
        effectiveModel: "kimi-code/k3",
        modelVerdict: "match",
        toolState: "none",
        durationMs: 0,
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      {
        kind: "run.finished",
        status: "failed",
        endedAt: NOW,
        failure: { phase: "ack", code: "ACK_FAILED", message: "ack conflict" },
        reportPath: paths.report(RUN_ID),
        incomplete: true,
      },
    ]);
  });

  it("fails the run when closeScope rejects after a completed discussion", async () => {
    const { outcome, paths, box } = await runAt(home, { host: { close: "throw" } });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject({
      phase: "cleanup",
      code: "CLOSE_FAILED",
      message: "close rejected",
    });
    expect(box.closeCalls).toBe(1);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(
      expectedPartial(
        { phase: "cleanup", code: "CLOSE_FAILED", message: "close rejected" },
        ONE_SPEECH,
      ),
    );
  });

  it("still succeeds when close verification cannot read scope status", async () => {
    const { outcome, box } = await runAt(home, {
      host: { status: "throw" },
      now: () => new Date(tickEnded()),
    });
    expect(box.statusCalls).toBe(1);
    expect(outcome.status).toBe("completed");
    expect(outcome.exitCode).toBe(EXIT.ok);
    expect(outcome.failure).toBeNull();
  });

  it("fails when the scope never reaches closed", async () => {
    const { outcome } = await runAt(home, { host: { status: "active" } });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject({
      phase: "cleanup",
      code: "CLOSE_FAILED",
      message: "scope did not reach closed (state=active)",
    });
  });

  it("writes a partial report when scope create fails", async () => {
    const { outcome, paths, box } = await runAt(home, {
      host: { createErrors: [new Error("host gone")] },
    });
    const failure = { phase: "scope", code: "SCOPE_CREATE_FAILED", message: "host gone" };
    expect(outcome.turns).toEqual([]);
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject(failure);
    expect(box.closeCalls).toBe(0);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, NO_SPEECHES));
  });

  it("retries a TypeError create once and then completes", async () => {
    const { outcome, box } = await runAt(home, {
      host: { createErrors: [new TypeError("fetch failed")] },
      now: () => new Date(tickEnded()),
    });
    expect(box.create).toHaveLength(2);
    expect(outcome.status).toBe("completed");
    expect(outcome.exitCode).toBe(EXIT.ok);
  });

  it("recovers a scope when both create attempts throw TypeError", async () => {
    const { outcome, box } = await runAt(home, {
      host: { createErrors: [new TypeError("fetch failed"), new TypeError("fetch failed again")] },
    });
    expect(box.create).toHaveLength(3);
    expect(box.closeCalls).toBe(1);
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject({
      phase: "scope",
      code: "SCOPE_CREATE_FAILED",
      message: "fetch failed again",
    });
  });

  it("swallows a recovery close failure and still reports the create error", async () => {
    const { outcome, box } = await runAt(home, {
      host: {
        createErrors: [new TypeError("fetch failed"), new TypeError("fetch failed again")],
        close: "throw",
      },
    });
    expect(box.closeCalls).toBe(1);
    expect(outcome.failure).toMatchObject({
      phase: "scope",
      code: "SCOPE_CREATE_FAILED",
      message: "fetch failed again",
    });
  });

  it("swallows a recovery create failure", async () => {
    const { outcome, box } = await runAt(home, {
      host: {
        createErrors: [
          new TypeError("fetch failed"),
          new TypeError("fetch failed again"),
          new TypeError("recover failed"),
        ],
      },
    });
    expect(box.create).toHaveLength(3);
    expect(box.closeCalls).toBe(0);
    expect(outcome.failure).toMatchObject({
      phase: "scope",
      code: "SCOPE_CREATE_FAILED",
      message: "fetch failed again",
    });
  });

  it("maps a host RESOURCE_LIMIT on create to exit 7", async () => {
    const error = new Error("limited");
    (error as Error & { code: string }).code = "RESOURCE_LIMIT";
    const { outcome } = await runAt(home, { host: { createErrors: [error] } });
    expect(outcome.exitCode).toBe(EXIT.quota);
    expect(outcome.failure).toMatchObject({
      phase: "scope",
      code: "RESOURCE_LIMIT",
      message: "limited",
    });
  });

  it("maps UNAUTHENTICATED during create to exit 4", async () => {
    const error = new Error("sign in");
    (error as Error & { code: string }).code = "UNAUTHENTICATED";
    const { outcome } = await runAt(home, {
      host: { createErrors: [error] },
      signal: new AbortController().signal,
    });
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject({
      phase: "scope",
      code: "UNAUTHENTICATED",
      message: "sign in",
    });
  });

  it("interrupts when the signal is already aborted before create", async () => {
    const controller = new AbortController();
    controller.abort("SIGINT");
    const { outcome, box } = await runAt(home, { signal: controller.signal, cleanupBudgetMs: 200 });
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(EXIT.interrupted);
    expect(outcome.failure).toMatchObject({
      phase: "signal",
      code: "INTERRUPTED",
      message: "interrupted by signal (SIGINT/SIGTERM)",
    });
    expect(box.create.map((request) => request.scopeRequestId)).toEqual([
      "ck-run-ck-run-cov-1-11111111",
      "ck-run-ck-run-cov-1-11111111",
    ]);
    expect(box.closeCalls).toBe(1);
  });

  it("fails when activateScope throws after create", async () => {
    const { outcome, box } = await runAt(home, { host: { activate: "throw" } });
    expect(box.activateCalls).toBe(1);
    expect(box.closeCalls).toBe(1);
    expect(outcome.failure).toMatchObject({
      phase: "scope",
      code: "SCOPE_CREATE_FAILED",
      message: "activate down",
    });
    expect(outcome.exitCode).toBe(EXIT.runFailed);
  });

  it("aborts a hanging activate and still closes the scope", async () => {
    const controller = new AbortController();
    const pending = runAt(home, {
      signal: controller.signal,
      host: { activate: "hang" },
      cleanupBudgetMs: 200,
    });
    setTimeout(() => controller.abort("SIGINT"), 20);
    const { outcome, box } = await pending;
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(EXIT.interrupted);
    expect(box.activateCalls).toBe(1);
    expect(box.closeCalls).toBe(1);
    expect(outcome.failure?.code).toBe("INTERRUPTED");
  });

  it("interrupts when the signal aborts during activate", async () => {
    const controller = new AbortController();
    const { outcome, box, paths } = await runAt(home, {
      signal: controller.signal,
      host: { onActivate: () => controller.abort("SIGINT") },
    });
    const failure = {
      phase: "signal",
      code: "INTERRUPTED",
      message: "interrupted by signal (SIGINT/SIGTERM)",
    };
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(EXIT.interrupted);
    expect(outcome.failure).toMatchObject(failure);
    expect(outcome.turns).toEqual([]);
    expect(box.activateCalls).toBe(1);
    expect(box.closeCalls).toBe(1);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, NO_SPEECHES));
  });

  it("bounds a hanging close and exits 4 when no external signal is set", async () => {
    const { outcome } = await runAt(home, { host: { close: "hang" }, cleanupBudgetMs: 30 });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject({
      phase: "cleanup",
      code: "CLOSE_FAILED",
      message: "close aborted",
    });
  });

  it("exits 130 when a hanging close is aborted by the external signal", async () => {
    const controller = new AbortController();
    const { outcome, box } = await runAt(home, {
      signal: controller.signal,
      cleanupBudgetMs: 30,
      host: { close: "hang", onClose: () => controller.abort("SIGINT") },
    });
    expect(box.closeCalls).toBe(1);
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(EXIT.interrupted);
    expect(outcome.failure).toMatchObject({
      phase: "signal",
      code: "INTERRUPTED",
      message: "interrupted by signal (SIGINT/SIGTERM)",
    });
  });

  it("exits 5 when the initial transcript write throws a non-Error", async () => {
    const original = atomicWriteModule.atomicWriteFile;
    vi.spyOn(atomicWriteModule, "atomicWriteFile").mockImplementation(((
      filePath: string,
      data: string,
    ) => {
      if (filePath.endsWith("transcript.jsonl")) throw "disk";
      return original(filePath, data);
    }) as typeof original);
    const { outcome, paths } = await runAt(home, {});
    const failure = {
      phase: "io",
      code: "TRANSCRIPT_INIT",
      message: "failed to write transcript: IOFailure",
    };
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.io);
    expect(outcome.failure).toMatchObject(failure);
    expect(outcome.turns).toEqual([]);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, NO_SPEECHES));
  });

  it("exits 5 when the ordinary-turn duration patch cannot rewrite the transcript", async () => {
    const original = atomicWriteModule.atomicWriteFile;
    vi.spyOn(atomicWriteModule, "atomicWriteFile").mockImplementation(((
      filePath: string,
      data: string,
    ) => {
      if (
        filePath.endsWith("transcript.jsonl") &&
        data.includes('"durationMs":12') &&
        !data.includes('"kind":"run.finished"')
      ) {
        throw new Error("ENOSPC");
      }
      return original(filePath, data);
    }) as typeof original);
    const { outcome, events } = await runAt(home, {});
    expect(outcome.exitCode).toBe(EXIT.io);
    expect(outcome.failure).toMatchObject({
      phase: "io",
      code: "TRANSCRIPT_DURATION",
      message: "failed to write transcript: Error",
    });
    expect(outcome.turns).toEqual([
      {
        role: "message",
        round: 1,
        turnIndex: 0,
        agentId: "a-alpha",
        agentName: "Alpha",
        verdict: "completed",
        effectiveModel: "kimi-code/k3",
        durationMs: 12,
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "run.starting",
      "round.start",
      "turn.start",
      "report.writing",
      "run.finishing",
    ]);
  });

  it("exits 5 when the reporter duration patch fails", async () => {
    const original = atomicWriteModule.atomicWriteFile;
    vi.spyOn(atomicWriteModule, "atomicWriteFile").mockImplementation(((
      filePath: string,
      data: string,
    ) => {
      if (filePath.endsWith("transcript.jsonl") && !data.includes('"kind":"run.finished"')) {
        const records = data
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { kind?: string; role?: string; durationMs?: number });
        const report = records.find(
          (record) => record.kind === "turn.completed" && record.role === "report",
        );
        if (report?.durationMs === 12) throw new Error("ENOSPC");
      }
      return original(filePath, data);
    }) as typeof original);
    const { outcome } = await runAt(home, {});
    expect(outcome.exitCode).toBe(EXIT.io);
    expect(outcome.failure).toMatchObject({
      phase: "io",
      code: "TRANSCRIPT_DURATION",
      message: "failed to write transcript: Error",
    });
    expect(outcome.turns.map((turn) => turn.role)).toEqual(["message", "report"]);
  });

  it("exits 5 and reconciles an incomplete report when --out cannot be written", async () => {
    writeFileSync(join(home, "sub"), "not-a-directory");
    chmodSync(join(home, "sub"), 0o600);
    const { outcome, paths } = await runAt(home, { outPath: join(home, "sub", "report.md") });
    const failure = {
      phase: "report",
      code: "REPORT_OUT_COPY",
      message: "failed to write --out report copy: Error",
    };
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.io);
    expect(outcome.incomplete).toBe(true);
    expect(outcome.failure).toMatchObject(failure);
    expect(outcome.artifactIoFailure).toEqual(failure);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, ONE_SPEECH));
  });

  it("reconciles the canonical report after the final transcript write fails", async () => {
    const original = atomicWriteModule.atomicWriteFile;
    vi.spyOn(atomicWriteModule, "atomicWriteFile").mockImplementation(((
      filePath: string,
      data: string,
    ) => {
      if (filePath.endsWith("transcript.jsonl") && data.includes('"kind":"run.finished"')) {
        throw new Error("ENOSPC");
      }
      return original(filePath, data);
    }) as typeof original);
    const { outcome, paths } = await runAt(home, {});
    const failure = {
      phase: "io",
      code: "TRANSCRIPT_FINAL",
      message: "failed to write transcript: Error",
    };
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.io);
    expect(outcome.incomplete).toBe(true);
    expect(outcome.failure).toMatchObject(failure);
    expect(outcome.artifactIoFailure).toEqual(failure);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, ONE_SPEECH));
    const onDisk = readJsonl(paths.transcript(RUN_ID));
    expect(onDisk.map((line) => (line as { kind: string }).kind)).toEqual([
      "run.started",
      "turn.completed",
      "turn.completed",
    ]);
  });

  it("keeps the success report when the incomplete reconcile write also fails", async () => {
    const original = atomicWriteModule.atomicWriteFile;
    vi.spyOn(atomicWriteModule, "atomicWriteFile").mockImplementation(((
      filePath: string,
      data: string,
    ) => {
      if (filePath.endsWith("transcript.jsonl") && data.includes('"kind":"run.finished"')) {
        throw new Error("ENOSPC");
      }
      if (filePath.endsWith("report.md") && data.includes("INCOMPLETE RUN")) {
        throw new Error("ENOSPC");
      }
      return original(filePath, data);
    }) as typeof original);
    const { outcome, paths } = await runAt(home, { now: () => new Date(tickEnded()) });
    expect(outcome.exitCode).toBe(EXIT.io);
    expect(outcome.artifactIoFailure).toEqual({
      phase: "io",
      code: "TRANSCRIPT_FINAL",
      message: "failed to write transcript: Error",
    });
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(
      [
        "# Council Report",
        "",
        "- Run: ck-run-cov-1",
        "- Council: cov-council (c-1)",
        "- Topic: pick a route",
        "- Reporter: Alpha",
        "- Participants: Alpha",
        "- Status: complete",
        `- Started: ${NOW}`,
        `- Ended: ${NOW}`,
        "---",
        "",
        "## Recommendation",
        "ship it",
        "",
      ].join("\n"),
    );
  });

  it("maps an unexpected driver throw to RUN_ERROR", async () => {
    const { outcome, paths } = await runAt(home, {
      driver: async () => {
        throw new Error("driver exploded");
      },
    });
    const failure = { phase: "run", code: "RUN_ERROR", message: "driver exploded" };
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject(failure);
    expect(outcome.turns).toEqual([]);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, NO_SPEECHES));
  });

  it("maps a thrown string from the driver through clipFailureMessage", async () => {
    const { outcome } = await runAt(home, {
      driver: async () => {
        throw "driver-string";
      },
    });
    expect(outcome.failure).toMatchObject({
      phase: "run",
      code: "RUN_ERROR",
      message: "driver-string",
    });
    expect(clipFailureMessage(12)).toBe("12");
    expect(clipFailureMessage(new Error("boom"))).toBe("boom");
  });

  it("completes when a turn reports success without a matching transcript row to patch", async () => {
    const { outcome, paths } = await runAt(home, {
      driver: async (req) => {
        if (req.role === "report") {
          await req.persist(evidence("## Recommendation\nship it"));
        }
        const output = req.role === "report" ? "## Recommendation\nship it" : "alpha speech";
        return completed(req.executionId, output);
      },
      now: () => new Date(tickEnded()),
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.exitCode).toBe(EXIT.ok);
    expect(
      readJsonl(paths.transcript(RUN_ID)).map(
        (line) => (line as { kind: string; role?: string }).role ?? (line as { kind: string }).kind,
      ),
    ).toEqual(["run.started", "report", "run.finished"]);
  });

  it("uses the real turn driver when none is injected and records the dispatch failure", async () => {
    const { outcome } = await runAt(home, { driver: "real", cleanupBudgetMs: 200 });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(EXIT.runFailed);
    expect(outcome.failure).toMatchObject({
      phase: "dispatch",
      code: "DISPATCH_FAILED",
      message: "Cannot read properties of null (reading 'execute')",
    });
    expect(outcome.turns).toEqual([
      {
        role: "message",
        round: 1,
        turnIndex: 0,
        agentId: "a-alpha",
        agentName: "Alpha",
        verdict: "failed",
        effectiveModel: null,
        durationMs: 0,
      },
    ]);
  });

  it("interrupts at the next round when the signal aborts after a completed turn", async () => {
    const controller = new AbortController();
    const failure = {
      phase: "signal",
      code: "INTERRUPTED",
      message: "interrupted by signal (SIGINT/SIGTERM)",
    };
    const { outcome, paths } = await runAt(home, {
      rounds: 2,
      signal: controller.signal,
      driver: async (req) => {
        await req.persist(evidence("alpha speech"));
        controller.abort("SIGINT");
        return completed(req.executionId, "alpha speech");
      },
    });
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(EXIT.interrupted);
    expect(outcome.failure).toMatchObject(failure);
    expect(outcome.turns).toEqual([
      {
        role: "message",
        round: 1,
        turnIndex: 0,
        agentId: "a-alpha",
        agentName: "Alpha",
        verdict: "completed",
        effectiveModel: "kimi-code/k3",
        durationMs: 12,
      },
    ]);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, ONE_SPEECH));
  });

  it("lets an external abort replace a reporter failure", async () => {
    const controller = new AbortController();
    const failure = {
      phase: "signal",
      code: "INTERRUPTED",
      message: "interrupted by signal (SIGINT/SIGTERM)",
    };
    const { outcome, paths } = await runAt(home, {
      signal: controller.signal,
      driver: async (req) => {
        if (req.role === "message") {
          await req.persist(evidence("alpha speech"));
          return completed(req.executionId, "alpha speech");
        }
        controller.abort("SIGINT");
        return failedTurn(req.executionId, "failed", null);
      },
    });
    expect(outcome.status).toBe("interrupted");
    expect(outcome.exitCode).toBe(EXIT.interrupted);
    expect(outcome.failure).toMatchObject(failure);
    expect(outcome.turns.map((turn) => [turn.role, turn.verdict])).toEqual([
      ["message", "completed"],
      ["report", "failed"],
    ]);
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(expectedPartial(failure, ONE_SPEECH));
  });

  it("writes the success report from the reporter terminal when persist did not", async () => {
    const { outcome, paths } = await runAt(home, {
      driver: async (req) => {
        const output = req.role === "report" ? "## Recommendation\nship it" : "alpha speech";
        if (req.role === "message") await req.persist(evidence(output));
        return completed(req.executionId, output);
      },
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.exitCode).toBe(EXIT.ok);
    expect(outcome.failure).toBeNull();
    expect(readFileSync(paths.report(RUN_ID), "utf8")).toBe(
      [
        "# Council Report",
        "",
        "- Run: ck-run-cov-1",
        "- Council: cov-council (c-1)",
        "- Topic: pick a route",
        "- Reporter: Alpha",
        "- Participants: Alpha",
        "- Status: complete",
        `- Started: ${NOW}`,
        `- Ended: ${NOW}`,
        "---",
        "",
        "## Recommendation",
        "ship it",
        "",
      ].join("\n"),
    );
    expect(
      readJsonl(paths.transcript(RUN_ID)).map((line) => (line as { kind: string }).kind),
    ).toEqual(["run.started", "turn.completed", "run.finished"]);
  });

  it("rejects reference faults before creating a scope", async () => {
    const cases: Array<{ input: RunOpts; message: string }> = [
      { input: { agents: [] }, message: "run has no agents" },
      {
        input: {
          agents: Array.from({ length: 9 }, (_unused, index) =>
            resolved(agent({ id: `a-${index}`, name: `A${index}` }), `p-${index}`),
          ),
        },
        message: "run has 9 agents; max is 8 (incl. reporter)",
      },
      {
        input: { reporter: resolved(agent({ id: "a-other", name: "Other" }), "p-other") },
        message: "reporter must be among the participating agents",
      },
      { input: { rounds: 0 }, message: "rounds must be a positive integer" },
      {
        input: {
          agents: [resolved(), resolved(agent({ name: "Clone" }), "p-clone")],
        },
        message: "run agents contains duplicates",
      },
      {
        input: { agents: [resolved(agent({ enabled: false }))] },
        message: 'agent "Alpha" is disabled; cannot participate in a run',
      },
    ];
    for (const item of cases) {
      try {
        await runAt(home, item.input);
        throw new Error(`expected usage error: ${item.message}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("expected usage error")) throw error;
        expectCli(error, item.message, EXIT.usage);
      }
    }
  });

  it("exits 5 when a turn failure is followed by a canonical report write failure", async () => {
    writeFileSync(join(home, "blocked-report-dir"), "not-a-directory");
    const base = resolvePaths(envFor(home));
    const paths: StorePaths = {
      ...base,
      report: () => join(home, "blocked-report-dir", "report.md"),
    };
    const { outcome } = await runAt(home, {
      paths,
      driver: async (req) => failedTurn(req.executionId),
    });
    expect(outcome.exitCode).toBe(EXIT.io);
    expect(outcome.failure).toMatchObject({
      phase: "terminal",
      code: "DRIVER_CRASH",
      message: "DRIVER_CRASH boom",
    });
    expect(outcome.artifactIoFailure).toEqual({
      phase: "report",
      code: "REPORT_IO",
      message: "failed to write canonical report: Error",
    });
  });
});

function tickEnded(): string {
  return NOW;
}

describe("resolveRunAgents and buildProfile", () => {
  it("builds a profile with the installation-managed credential mode", () => {
    expect(buildProfile({ driverId: "grok-stream-json", options: {} }, "inst-grok")).toEqual({
      driverId: "grok-stream-json",
      installationId: "inst-grok",
      credentialMode: "installation-managed",
      options: {},
    });
    expect(buildProfile({ driverId: "kimi-stream-json", options: {} }, "inst-kimi-1")).toEqual({
      driverId: "kimi-stream-json",
      installationId: "inst-kimi-1",
      credentialMode: "installation-managed",
      options: {},
    });
  });

  it("resolves agents in council order and skips untrusted installations", async () => {
    const alpha = agent();
    const beta = agent({
      id: "a-beta",
      name: "Beta",
      personaPrompt: "Beta persona",
    });
    const installations: InstallationsResponse = {
      installations: [
        { ...INSTALLATION, state: "discovered", installationId: "inst-no" },
        { ...INSTALLATION, installationId: "inst-second" },
        INSTALLATION,
      ],
    };
    const ids = ["aaaaaaaaaaaa-extra", "bbbbbbbbbbbb-extra"];
    const resolvedAgents = await resolveRunAgents({
      council: { agentIds: ["a-alpha", "a-beta"], reporterAgentId: "a-beta" },
      agents: [{ snapshot: beta }, { snapshot: alpha }],
      installations,
      host: { profileReadiness: async () => READY },
      idFactory: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error("id factory exhausted");
        return id;
      },
    });
    expect(resolvedAgents).toEqual([
      {
        snapshot: alpha,
        profile: {
          driverId: "kimi-stream-json",
          installationId: "inst-second",
          credentialMode: "installation-managed",
          options: {},
        },
        installationId: "inst-second",
        participantId: "ck-p-aaaaaaaaaaaa",
        participantSnapshotDigest: PERSONA_DIGEST,
      },
      {
        snapshot: beta,
        profile: {
          driverId: "kimi-stream-json",
          installationId: "inst-second",
          credentialMode: "installation-managed",
          options: {},
        },
        installationId: "inst-second",
        participantId: "ck-p-bbbbbbbbbbbb",
        participantSnapshotDigest: BETA_DIGEST,
      },
    ]);
  });

  it("throws usage when an agent id is unknown", async () => {
    try {
      await resolveRunAgents({
        council: { agentIds: ["missing"], reporterAgentId: "missing" },
        agents: [{ snapshot: agent() }],
        installations: { installations: [INSTALLATION] },
        host: { profileReadiness: async () => READY },
        idFactory: () => "aaaaaaaaaaaa",
      });
      throw new Error("expected unknown agent");
    } catch (error) {
      if (error instanceof Error && error.message === "expected unknown agent") throw error;
      expectCli(error, 'run references unknown agent id "missing"', EXIT.usage);
    }
  });

  it("throws host-unavailable when no trusted installation exists", async () => {
    try {
      await resolveRunAgents({
        council: { agentIds: ["a-alpha"], reporterAgentId: "a-alpha" },
        agents: [{ snapshot: agent() }],
        installations: {
          installations: [{ ...INSTALLATION, state: "discovered" }],
        },
        host: { profileReadiness: async () => READY },
        idFactory: () => "aaaaaaaaaaaa",
      });
      throw new Error("expected no trusted");
    } catch (error) {
      if (error instanceof Error && error.message === "expected no trusted") throw error;
      expectCli(
        error,
        'no trusted installation for driver "kimi-stream-json" (install some software or run the browser once, then retry)',
        EXIT.hostUnavailable,
        { code: "NO_TRUSTED_INSTALLATION", driverId: "kimi-stream-json", trustedCandidates: 0 },
      );
    }
  });

  it("wraps a readiness throw, including a non-Error", async () => {
    try {
      await resolveRunAgents({
        council: { agentIds: ["a-alpha"], reporterAgentId: "a-alpha" },
        agents: [{ snapshot: agent() }],
        installations: { installations: [INSTALLATION] },
        host: {
          profileReadiness: async () => {
            throw new Error("socket hang up");
          },
        },
        idFactory: () => "aaaaaaaaaaaa",
      });
      throw new Error("expected readiness");
    } catch (error) {
      if (error instanceof Error && error.message === "expected readiness") throw error;
      expectCli(
        error,
        'profile readiness failed for agent "Alpha": socket hang up',
        EXIT.hostUnavailable,
        { code: "READINESS_FAILED", agentId: "a-alpha" },
      );
    }

    try {
      await resolveRunAgents({
        council: { agentIds: ["a-alpha"], reporterAgentId: "a-alpha" },
        agents: [{ snapshot: agent() }],
        installations: { installations: [INSTALLATION] },
        host: {
          profileReadiness: async () => {
            throw "nope";
          },
        },
        idFactory: () => "aaaaaaaaaaaa",
      });
      throw new Error("expected string readiness");
    } catch (error) {
      if (error instanceof Error && error.message === "expected string readiness") throw error;
      expectCli(error, 'profile readiness failed for agent "Alpha": nope', EXIT.hostUnavailable, {
        code: "READINESS_FAILED",
        agentId: "a-alpha",
      });
    }
  });

  it("rejects a profile that is not ready, with and without a detail", async () => {
    try {
      await resolveRunAgents({
        council: { agentIds: ["a-alpha"], reporterAgentId: "a-alpha" },
        agents: [{ snapshot: agent() }],
        installations: { installations: [INSTALLATION] },
        host: {
          profileReadiness: async () => ({
            ...READY,
            readiness: { state: "model_unavailable", detail: null },
          }),
        },
        idFactory: () => "aaaaaaaaaaaa",
      });
      throw new Error("expected not ready");
    } catch (error) {
      if (error instanceof Error && error.message === "expected not ready") throw error;
      expectCli(
        error,
        'agent "Alpha" is not ready (state=model_unavailable: no detail)',
        EXIT.hostUnavailable,
        { code: "PROFILE_NOT_READY", agentId: "a-alpha", readiness: "model_unavailable" },
      );
    }

    try {
      await resolveRunAgents({
        council: { agentIds: ["a-alpha"], reporterAgentId: "a-alpha" },
        agents: [{ snapshot: agent() }],
        installations: { installations: [INSTALLATION] },
        host: {
          profileReadiness: async () => ({
            ...READY,
            readiness: { state: "invalid_binding", detail: "model missing" },
          }),
        },
        idFactory: () => "aaaaaaaaaaaa",
      });
      throw new Error("expected detail");
    } catch (error) {
      if (error instanceof Error && error.message === "expected detail") throw error;
      expectCli(
        error,
        'agent "Alpha" is not ready (state=invalid_binding: model missing)',
        EXIT.hostUnavailable,
        { code: "PROFILE_NOT_READY", agentId: "a-alpha", readiness: "invalid_binding" },
      );
    }
  });
});
