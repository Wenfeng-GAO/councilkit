import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Emit,
  ExecuteInput,
  ParticipantDriver,
  PrewarmInput,
  PrewarmResult,
} from "../../runtime-host/drivers/types";
import {
  type ExecutionRecord,
  type ExecutionRegistry,
  createExecutionRegistry,
} from "../../runtime-host/executions/execution-registry";
import type {
  InstallationRecord,
  InstallationRegistry,
} from "../../runtime-host/installations/registry";
import type { Logger } from "../../runtime-host/logging";
import {
  DEFAULT_IDLE_SCOPE_TTL_MS,
  type ScopeManager,
  createScopeManager,
  createSessionReconciler as reexportedReconciler,
} from "../../runtime-host/scopes/scope-manager";
import {
  type SessionReconciler,
  createSessionReconciler,
} from "../../runtime-host/scopes/session-reconciler";
import { HttpError } from "../../runtime-host/server";
import type { RuntimeEvent } from "../../shared/runtime/events";
import type {
  ContextSnapshot,
  CreateScopeRequest,
  CreateScopeResponse,
  ExecutionProfileDto,
  InstallationDto,
  ParticipantSpec,
  SnapshotItem,
} from "../../shared/runtime/schemas";

/**
 * Direct scope-manager coverage: quotas, prewarm outcomes, fencing, TTL
 * reapers, execute/cancel/ack, and reconciler wiring. Fake timers keep every
 * deadline and event `at` on a pinned clock. No sockets or child processes.
 */

const AT = "2026-10-14T00:00:00.000Z";
const HOST = "host-unit-scopes";
const INSTALLATION_FINGERPRINT = "f4ef377cdeecb40949cc9ec1d49bfed50c88bfcd01cfb9e17cf4eb78e61e93f6";
const CAPABILITY_DIGEST = "bbf2068f4b0d0dc33fdf2d02e0c7f4d1cd8b6a3f05719a51e821c68cc2248f30";
const BINDING_DIGEST = "ba16c08c9753c4539e3629ecdfa2783de71dfbb6349d3329ee93f9dd46c05cce";
const ALIAS_CAPABILITY_DIGEST = "acea811b453a36b6f97771bedccde710756a021c3696a36517ce9998645f9fe5";
const ALIAS_BINDING_DIGEST = "25b09a08c9710d9f26d51b1b4dda2c893b68dc5e14693bb12272cba7492a14fa";
const HELLO_DIGEST = "8e3dd51bda936d0bb250d2d7b5f963af56a4828880d505ca01a40bca6f294e8c";
const OTHER_DIGEST = "7dbbdd2d388e24b28d16a64eb0ac491d42e8dc93ba5bb317e583905e480d9a4a";

const FULL_PROMPT = [
  "# Discussion context (revision 1)",
  "Topic: T",
  "Background:",
  "B",
  "",
  "[user]",
  "Hello",
  "",
  "# Instruction (message)",
  "Reply.",
].join("\n");

const INCREMENTAL_PROMPT = [
  "[participant p-2]",
  "Other",
  "",
  "# Instruction (message)",
  "Reply.",
].join("\n");

const CODEX_COMPONENTS = [
  { role: "wrapper" as const, path: "/opt/codex", fingerprint: "fp-codex" },
];

const CODEX_DTO: InstallationDto = {
  installationId: "inst-codex",
  driverId: "codex-app-server",
  state: "trusted",
  executablePath: "/opt/codex",
  fingerprint: "fp-codex",
  components: CODEX_COMPONENTS,
  detail: null,
};

const CODEX_RECORD: InstallationRecord = {
  installationId: "inst-codex",
  driverId: "codex-app-server",
  name: "codex",
  discoveredPath: "/opt/codex",
  realpath: "/opt/codex",
  fingerprint: "fp-codex",
  state: "trusted",
  components: CODEX_COMPONENTS,
  detail: null,
};

const HAPPY_BINDING = {
  bindingDigest: BINDING_DIGEST,
  driverId: "codex-app-server" as const,
  installationId: "inst-codex",
  installationFingerprint: INSTALLATION_FINGERPRINT,
  capabilityDigest: CAPABILITY_DIGEST,
  requestedModel: "gpt-test",
  canonicalModelId: "gpt-test",
  modelAliases: [] as string[],
  reasoningEffort: "medium",
};

const ALIAS_BINDING = {
  bindingDigest: ALIAS_BINDING_DIGEST,
  driverId: "codex-app-server" as const,
  installationId: "inst-codex",
  installationFingerprint: INSTALLATION_FINGERPRINT,
  capabilityDigest: ALIAS_CAPABILITY_DIGEST,
  requestedModel: "gpt-test",
  canonicalModelId: "gpt-canonical",
  modelAliases: ["gpt-test"],
  reasoningEffort: "medium",
};

const STANDARD_PREWARM: PrewarmResult = {
  canonicalModelId: "gpt-test",
  modelAliases: [],
  capability: { protocol: "fake", tools: false },
  catalog: ["gpt-test"],
};

const STALE = {
  code: "STALE_CONTROLLER",
  phase: "security",
  message: "controllerId/leaseEpoch is not current.",
  retryable: false,
};

const SCOPE_CLOSED = {
  code: "SCOPE_CLOSED",
  phase: "close",
  message: "Scope is closing or closed.",
  retryable: false,
};

const NOT_FOUND = {
  code: "SCOPE_NOT_FOUND",
  phase: "dispatch",
  message: "Unknown scope.",
  retryable: false,
};

interface LogLine {
  level: "info" | "warn" | "error";
  event: string;
  context?: Record<string, unknown>;
}

interface Script {
  sessionEpoch: number;
  contextWindow: number | null;
  prewarmInputs: PrewarmInput[];
  executeInputs: ExecuteInput[];
  cancelIds: string[];
  closeCount: number;
  prewarmImpl?: (input: PrewarmInput) => Promise<PrewarmResult>;
  executeImpl?: (input: ExecuteInput, emit: Emit) => Promise<void>;
  cancelImpl?: (executionId: string) => Promise<void>;
  closeImpl?: () => Promise<void>;
}

interface Rig {
  manager: ScopeManager;
  executions: ExecutionRegistry;
  reconciler: SessionReconciler;
  logs: LogLine[];
  factoryCalls: string[];
  scriptFor(participantId: string): Script;
  dtos: Map<string, InstallationDto>;
  records: Map<string, InstallationRecord>;
  assertThrow: Map<string, Error>;
  getThrow: Set<string>;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function coded(message: string, runtimeCode: string): Error {
  const error = new Error(message);
  (error as Error & { runtimeCode: string }).runtimeCode = runtimeCode;
  return error;
}

async function httpErrorFrom(run: () => Promise<unknown> | unknown): Promise<HttpError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    if (!(error instanceof HttpError)) throw new Error("expected HttpError");
    return error;
  }
  throw new Error("expected HttpError");
}

async function expectHttp(
  run: () => Promise<unknown> | unknown,
  status: number,
  runtimeError: Record<string, unknown>,
): Promise<void> {
  const error = await httpErrorFrom(run);
  expect(error.status).toBe(status);
  expect(error.runtimeError).toEqual(runtimeError);
}

function codexProfile(installationId = "inst-codex"): ExecutionProfileDto {
  return {
    driverId: "codex-app-server",
    installationId,
    credentialMode: "installation-managed",
    options: { reasoningEffort: "medium" },
  };
}

function participant(
  participantId: string,
  profile: ExecutionProfileDto = codexProfile(),
  modelId = "gpt-test",
): ParticipantSpec {
  return { participantId, profile, modelId };
}

function scopeRequest(participants: ParticipantSpec[], scopeRequestId: string): CreateScopeRequest {
  return { scopeRequestId, participants };
}

function many(prefix: string, count: number): ParticipantSpec[] {
  return Array.from({ length: count }, (_unused, index) => participant(`${prefix}-${index + 1}`));
}

function helloItem(): SnapshotItem {
  return { id: "i-1", role: "user", content: "Hello" };
}

function otherItem(): SnapshotItem {
  return {
    id: "i-2",
    role: "participant",
    participantId: "p-2",
    content: "Other",
    sourceExecutionId: "exec-0",
  };
}

function snap(options: {
  revision: number;
  items: SnapshotItem[];
  topic?: string;
  background?: string;
}): ContextSnapshot {
  return {
    digestVersion: 1,
    roomContext: {
      contextRevision: options.revision,
      contextDigest: `digest-r${options.revision}`,
      ...(options.topic === undefined ? {} : { topic: options.topic }),
      ...(options.background === undefined ? {} : { background: options.background }),
      items: options.items,
    },
    participant: {
      participantId: "p-1",
      participantSnapshotDigest: "participant-digest-1",
    },
    instruction: { kind: "message", instructionDigest: "instr-1", text: "Reply." },
  };
}

function baseSnap(): ContextSnapshot {
  return snap({ revision: 1, topic: "T", background: "B", items: [helloItem()] });
}

function ctrlOf(created: CreateScopeResponse): { controllerId: string; leaseEpoch: number } {
  return { controllerId: created.controllerId, leaseEpoch: created.leaseEpoch };
}

function readyStatus(participantId: string, binding: typeof HAPPY_BINDING = HAPPY_BINDING) {
  return {
    participantId,
    runtime: "ready" as const,
    binding,
    readiness: { state: "ready" as const, detail: null },
  };
}

function defaultEvents(executionId: string, modelId = "gpt-test"): RuntimeEvent[] {
  return [
    { executionId, seq: 1, at: AT, type: "started", requestedModel: modelId },
    {
      executionId,
      seq: 2,
      at: AT,
      type: "completed",
      output: "ok",
      requestedModel: modelId,
      effectiveModel: modelId,
      modelVerdict: "match",
      toolState: "none",
      dispatchState: "accepted",
      usage: { inputTokens: 12, outputTokens: 4 },
      finalSeq: 2,
    },
  ];
}

function completedProto(modelId: string, output: string, inputTokens: number) {
  return {
    type: "completed" as const,
    output,
    requestedModel: modelId,
    effectiveModel: modelId,
    modelVerdict: "match" as const,
    toolState: "none" as const,
    dispatchState: "accepted" as const,
    usage: { inputTokens, outputTokens: 1 },
    finalSeq: 0,
  };
}

function nullLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    diagnostic: () => ({ diagnosticId: "d", at: AT, kind: "k", message: "m" }),
    diagnostics: () => [],
    recentProblems: () => [],
  };
}

function soleScope(manager: ScopeManager) {
  const values = [...manager._scopes.values()];
  if (values.length !== 1) throw new Error(`expected 1 scope, found ${values.length}`);
  const scope = values[0];
  if (!scope) throw new Error("missing scope");
  return scope;
}

function createRig(options?: {
  executions?: ExecutionRegistry;
  creatingScopeTtlMs?: number;
  idleScopeTtlMs?: number;
  now?: () => number;
}): Rig {
  const logs: LogLine[] = [];
  const logger: Logger = {
    info: (event, context) => logs.push({ level: "info", event, context }),
    warn: (event, context) => logs.push({ level: "warn", event, context }),
    error: (event, context) => logs.push({ level: "error", event, context }),
    diagnostic: () => ({ diagnosticId: "d", at: AT, kind: "k", message: "m" }),
    diagnostics: () => [],
    recentProblems: () => [],
  };
  const scripts = new Map<string, Script>();
  const factoryCalls: string[] = [];
  function scriptFor(participantId: string): Script {
    let script = scripts.get(participantId);
    if (!script) {
      script = {
        sessionEpoch: 0,
        contextWindow: null,
        prewarmInputs: [],
        executeInputs: [],
        cancelIds: [],
        closeCount: 0,
      };
      scripts.set(participantId, script);
    }
    return script;
  }
  function createDriver(
    participantId: string,
    driverId: ParticipantDriver["driverId"],
  ): ParticipantDriver {
    const script = scriptFor(participantId);
    return {
      participantId,
      driverId,
      get sessionEpoch() {
        return script.sessionEpoch;
      },
      async prewarm(input: PrewarmInput): Promise<PrewarmResult> {
        script.prewarmInputs.push(input);
        if (script.prewarmImpl) return script.prewarmImpl(input);
        return {
          canonicalModelId: input.spec.modelId,
          modelAliases: [],
          capability: { protocol: "fake", tools: false },
          catalog: [input.spec.modelId],
        };
      },
      async execute(input: ExecuteInput, emit: Emit): Promise<void> {
        script.executeInputs.push(input);
        if (script.executeImpl) {
          await script.executeImpl(input, emit);
          return;
        }
        emit({ type: "started", requestedModel: input.modelId });
        emit({
          type: "completed",
          output: "ok",
          requestedModel: input.modelId,
          effectiveModel: input.modelId,
          modelVerdict: "match",
          toolState: "none",
          dispatchState: "accepted",
          usage: { inputTokens: 12, outputTokens: 4 },
          finalSeq: 0,
        });
      },
      async cancel(executionId: string): Promise<void> {
        script.cancelIds.push(executionId);
        if (script.cancelImpl) await script.cancelImpl(executionId);
      },
      async close(): Promise<void> {
        script.closeCount += 1;
        if (script.closeImpl) await script.closeImpl();
      },
      capabilityState: () => "ready",
      contextWindowTokens: () => script.contextWindow,
    };
  }
  const dtos = new Map<string, InstallationDto>([["inst-codex", CODEX_DTO]]);
  const records = new Map<string, InstallationRecord>([["inst-codex", CODEX_RECORD]]);
  const assertThrow = new Map<string, Error>();
  const getThrow = new Set<string>();
  const installations: InstallationRegistry = {
    refresh: () => [...dtos.values()],
    list: () => [...dtos.values()],
    get: (installationId: string) => {
      if (getThrow.has(installationId)) throw new Error("registry down");
      return dtos.get(installationId);
    },
    revalidate: (installationId: string) => {
      const dto = dtos.get(installationId);
      if (!dto) throw new Error("missing installation");
      return dto;
    },
    assertExecutable: (installationId: string) => {
      const thrown = assertThrow.get(installationId);
      if (thrown) throw thrown;
      const record = records.get(installationId);
      if (!record) throw new Error(`missing record ${installationId}`);
      return record;
    },
  };
  const executions = options?.executions ?? createExecutionRegistry({ logger: nullLogger() });
  const reconciler = createSessionReconciler();
  const manager = createScopeManager({
    installations,
    executions,
    reconciler,
    driverFactories: {
      "codex-app-server": (participantId) => {
        factoryCalls.push(`codex-app-server:${participantId}`);
        return createDriver(participantId, "codex-app-server");
      },
      "claude-stream-json": (participantId) => {
        factoryCalls.push(`claude-stream-json:${participantId}`);
        return createDriver(participantId, "claude-stream-json");
      },
    },
    logger,
    hostInstanceId: HOST,
    creatingScopeTtlMs: options?.creatingScopeTtlMs,
    idleScopeTtlMs: options?.idleScopeTtlMs,
    now: options?.now,
  });
  return {
    manager,
    executions,
    reconciler,
    logs,
    factoryCalls,
    scriptFor,
    dtos,
    records,
    assertThrow,
    getThrow,
  };
}

async function openedScope(
  rig: Rig,
  participants: ParticipantSpec[] = [participant("p-1")],
  scopeRequestId = "req-open-0001",
): Promise<CreateScopeResponse> {
  const created = await rig.manager.createScope(scopeRequest(participants, scopeRequestId));
  rig.manager.activateScope(created.scopeId, created.controllerId, created.leaseEpoch);
  return created;
}

let rig: Rig;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(AT));
  rig = createRig({ creatingScopeTtlMs: 60_000, idleScopeTtlMs: 60_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scope manager constants and empty counts", () => {
  it("re-exports the reconciler and the 30 minute idle default", () => {
    expect(DEFAULT_IDLE_SCOPE_TTL_MS).toBe(1_800_000);
    expect(reexportedReconciler).toBe(createSessionReconciler);
  });

  it("reports zero counts before any scope exists", () => {
    expect(rig.manager.counts()).toEqual({
      activeScopes: 0,
      liveDriverProcesses: 0,
      runningExecutions: 0,
      eventConnections: 0,
    });
  });
});

describe("scope manager create, quotas, and idempotency", () => {
  it("returns a ready participant with the handshaken binding", async () => {
    const created = await rig.manager.createScope(
      scopeRequest([participant("p-1")], "req-happy-0001"),
    );
    expect(created.leaseEpoch).toBe(1);
    expect(created.scopeId).toMatch(
      /^scope-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.controllerId).toMatch(
      /^ctrl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.scope).toEqual({
      scopeId: created.scopeId,
      state: "creating",
      hostInstanceId: HOST,
      leaseEpoch: 1,
      participants: [readyStatus("p-1")],
    });
    expect(rig.scriptFor("p-1").prewarmInputs).toEqual([
      { participantId: "p-1", spec: participant("p-1"), installation: CODEX_RECORD },
    ]);
    expect(rig.manager.counts()).toEqual({
      activeScopes: 1,
      liveDriverProcesses: 1,
      runningExecutions: 0,
      eventConnections: 0,
    });
    expect(rig.logs).toEqual([]);
    const again = await rig.manager.createScope(
      scopeRequest([participant("p-1")], "req-happy-0001"),
    );
    expect(again).toEqual(created);
    expect(rig.factoryCalls).toEqual(["codex-app-server:p-1"]);
  });

  it("returns the taken-over controller for an in-flight scope request", async () => {
    const created = await rig.manager.createScope(
      scopeRequest([participant("p-1")], "req-take-idem"),
    );
    expect(rig.manager.takeover(created.scopeId, "ctrl-next")).toEqual({
      scopeId: created.scopeId,
      controllerId: "ctrl-next",
      leaseEpoch: 2,
    });
    const again = await rig.manager.createScope(
      scopeRequest([participant("p-1")], "req-take-idem"),
    );
    expect(again.controllerId).toBe("ctrl-next");
    expect(again.leaseEpoch).toBe(2);
    expect(again.scopeId).toBe(created.scopeId);
    expect(rig.logs).toEqual([
      {
        level: "info",
        event: "scope.controller_takeover",
        context: { scopeId: created.scopeId, leaseEpoch: 2 },
      },
    ]);
  });

  it("mints a new scope after the previous request id is closed", async () => {
    const first = await rig.manager.createScope(
      scopeRequest([participant("p-1")], "req-reopen-01"),
    );
    await rig.manager.closeScope(first.scopeId, ctrlOf(first));
    const second = await rig.manager.createScope(
      scopeRequest([participant("p-2")], "req-reopen-01"),
    );
    expect([...rig.manager._scopes.keys()]).toEqual([first.scopeId, second.scopeId]);
    expect(rig.manager.getScopeStatus(first.scopeId).state).toBe("closed");
    expect(rig.manager.getScopeStatus(second.scopeId)).toEqual({
      scopeId: second.scopeId,
      state: "creating",
      hostInstanceId: HOST,
      leaseEpoch: 1,
      participants: [readyStatus("p-2")],
    });
    expect(rig.manager.counts()).toEqual({
      activeScopes: 1,
      liveDriverProcesses: 1,
      runningExecutions: 0,
      eventConnections: 0,
    });
  });

  it("creates a replacement when the indexed scope was removed from the map", async () => {
    const first = await rig.manager.createScope(
      scopeRequest([participant("p-1")], "req-stale-idx"),
    );
    rig.manager._scopes.delete(first.scopeId);
    const second = await rig.manager.createScope(
      scopeRequest([participant("p-2")], "req-stale-idx"),
    );
    expect([...rig.manager._scopes.keys()]).toEqual([second.scopeId]);
    expect(second.leaseEpoch).toBe(1);
    expect(second.scope.participants).toEqual([readyStatus("p-2")]);
    await expectHttp(() => rig.manager.getScopeStatus(first.scopeId), 404, NOT_FOUND);
  });

  it("replays a scope request that is still closing", async () => {
    const gate = deferred<void>();
    rig.scriptFor("p-1").closeImpl = () => gate.promise;
    const created = await rig.manager.createScope(
      scopeRequest([participant("p-1")], "req-closing-1"),
    );
    const closing = rig.manager.closeScope(created.scopeId, ctrlOf(created));
    await flushMicrotasks();
    const again = await rig.manager.createScope(
      scopeRequest([participant("p-1")], "req-closing-1"),
    );
    expect(again).toEqual({
      scopeId: created.scopeId,
      controllerId: created.controllerId,
      leaseEpoch: 1,
      scope: {
        scopeId: created.scopeId,
        state: "closing",
        hostInstanceId: HOST,
        leaseEpoch: 1,
        participants: [readyStatus("p-1")],
      },
    });
    gate.resolve();
    await closing;
    expect(rig.manager.getScopeStatus(created.scopeId).participants).toEqual([
      {
        participantId: "p-1",
        runtime: "cold",
        binding: HAPPY_BINDING,
        readiness: { state: "ready", detail: null },
      },
    ]);
  });

  it("rate-limits the 11th create until the oldest timestamp is strictly older than 60s", async () => {
    for (let index = 0; index < 10; index += 1) {
      const created = await rig.manager.createScope(
        scopeRequest([participant(`p-${index}`)], `req-rate-${index}`),
      );
      await rig.manager.closeScope(created.scopeId, ctrlOf(created));
    }
    await expectHttp(
      () => rig.manager.createScope(scopeRequest([participant("p-over")], "req-rate-over")),
      429,
      {
        code: "RATE_LIMITED",
        phase: "quota",
        message: "Scope create rate exceeded (10/min).",
        retryable: true,
        retryAfterMs: 60_000,
      },
    );
    vi.setSystemTime(new Date(Date.parse(AT) + 60_000));
    await expectHttp(
      () => rig.manager.createScope(scopeRequest([participant("p-edge")], "req-rate-edge")),
      429,
      {
        code: "RATE_LIMITED",
        phase: "quota",
        message: "Scope create rate exceeded (10/min).",
        retryable: true,
        retryAfterMs: 60_000,
      },
    );
    vi.setSystemTime(new Date(Date.parse(AT) + 60_001));
    const allowed = await rig.manager.createScope(
      scopeRequest([participant("p-next")], "req-rate-next"),
    );
    expect(allowed.scope.state).toBe("creating");
    expect(rig.manager.counts().activeScopes).toBe(1);
  });

  it("does not count an idempotent replay toward the create rate", async () => {
    let kept: CreateScopeResponse | null = null;
    for (let index = 0; index < 10; index += 1) {
      const created = await rig.manager.createScope(
        scopeRequest([participant(`p-${index}`)], `req-idem-rate-${index}`),
      );
      if (index === 9) kept = created;
      else await rig.manager.closeScope(created.scopeId, ctrlOf(created));
    }
    if (!kept) throw new Error("missing kept scope");
    const replay = await rig.manager.createScope(
      scopeRequest([participant("p-9")], "req-idem-rate-9"),
    );
    expect(replay).toEqual(kept);
    await expectHttp(
      () => rig.manager.createScope(scopeRequest([participant("p-new")], "req-idem-rate-x")),
      429,
      {
        code: "RATE_LIMITED",
        phase: "quota",
        message: "Scope create rate exceeded (10/min).",
        retryable: true,
        retryAfterMs: 60_000,
      },
    );
  });

  it("rejects a fifth active scope and allows another after one closes", async () => {
    const created = [];
    for (let index = 0; index < 4; index += 1) {
      created.push(
        await rig.manager.createScope(
          scopeRequest([participant(`p-${index}`)], `req-active-${index}`),
        ),
      );
    }
    await expectHttp(
      () => rig.manager.createScope(scopeRequest([participant("p-extra")], "req-active-x")),
      429,
      {
        code: "RESOURCE_LIMIT",
        phase: "quota",
        message: "Maximum active scopes reached.",
        retryable: false,
      },
    );
    expect(rig.manager.counts().activeScopes).toBe(4);
    const first = created[0];
    if (!first) throw new Error("missing scope");
    await rig.manager.closeScope(first.scopeId, ctrlOf(first));
    const fifth = await rig.manager.createScope(
      scopeRequest([participant("p-fifth")], "req-active-5"),
    );
    expect(fifth.scope.state).toBe("creating");
    expect(rig.manager.counts().activeScopes).toBe(4);
  });

  it("does not count a closing scope toward active scopes or live drivers", async () => {
    const gate = deferred<void>();
    const created = [];
    for (let index = 0; index < 4; index += 1) {
      created.push(
        await rig.manager.createScope(
          scopeRequest([participant(`p-${index}`)], `req-close-${index}`),
        ),
      );
    }
    const closingScope = created[0];
    if (!closingScope) throw new Error("missing scope");
    rig.scriptFor("p-0").closeImpl = () => gate.promise;
    const closing = rig.manager.closeScope(closingScope.scopeId, ctrlOf(closingScope));
    await flushMicrotasks();
    expect(rig.manager.getScopeStatus(closingScope.scopeId).state).toBe("closing");
    expect(rig.manager.getScopeStatus(closingScope.scopeId).participants[0]?.runtime).toBe("ready");
    expect(rig.manager.counts()).toEqual({
      activeScopes: 3,
      liveDriverProcesses: 3,
      runningExecutions: 0,
      eventConnections: 0,
    });
    const fifth = await rig.manager.createScope(
      scopeRequest([participant("p-fifth")], "req-close-fifth"),
    );
    expect(fifth.scope.state).toBe("creating");
    expect(rig.manager.counts().activeScopes).toBe(4);
    expect(rig.manager.counts().liveDriverProcesses).toBe(4);
    gate.resolve();
    await closing;
    expect(rig.manager.getScopeStatus(closingScope.scopeId).state).toBe("closed");
    expect(rig.manager.counts().liveDriverProcesses).toBe(4);
  });

  it("rejects more than eight participants before registering a scope", async () => {
    await expectHttp(
      () => rig.manager.createScope(scopeRequest(many("p", 9), "req-too-many-1")),
      429,
      {
        code: "RESOURCE_LIMIT",
        phase: "quota",
        message: "Too many participants in one scope.",
        retryable: false,
      },
    );
    expect([...rig.manager._scopes.keys()]).toEqual([]);
    expect(rig.factoryCalls).toEqual([]);
    expect(rig.manager.counts().activeScopes).toBe(0);
  });

  it("counts ready drivers toward the global process quota", async () => {
    await rig.manager.createScope(scopeRequest(many("a", 8), "req-drivers-aaa"));
    await rig.manager.createScope(scopeRequest(many("b", 8), "req-drivers-bbb"));
    expect(rig.manager.counts()).toEqual({
      activeScopes: 2,
      liveDriverProcesses: 16,
      runningExecutions: 0,
      eventConnections: 0,
    });
    await expectHttp(
      () => rig.manager.createScope(scopeRequest([participant("c-1")], "req-drivers-ccc")),
      429,
      {
        code: "RESOURCE_LIMIT",
        phase: "quota",
        message: "Global driver process quota reached.",
        retryable: false,
      },
    );
    expect(rig.manager.counts().activeScopes).toBe(2);
  });

  it("counts in-flight prewarms toward the driver quota", async () => {
    const gate = deferred<PrewarmResult>();
    for (const spec of [...many("a", 8), ...many("b", 8)]) {
      rig.scriptFor(spec.participantId).prewarmImpl = () => gate.promise;
    }
    const first = rig.manager.createScope(scopeRequest(many("a", 8), "req-warm-aaaa"));
    expect(rig.manager.counts().liveDriverProcesses).toBe(8);
    const second = rig.manager.createScope(scopeRequest(many("b", 8), "req-warm-bbbb"));
    expect(rig.manager.counts().liveDriverProcesses).toBe(16);
    await expectHttp(
      () => rig.manager.createScope(scopeRequest([participant("c-1")], "req-warm-cccc")),
      429,
      {
        code: "RESOURCE_LIMIT",
        phase: "quota",
        message: "Global driver process quota reached.",
        retryable: false,
      },
    );
    gate.resolve(STANDARD_PREWARM);
    const created = await Promise.all([first, second]);
    expect(created[0]?.scope.participants.map((entry) => entry.runtime)).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
    ]);
    expect(created[1]?.scope.participants.map((entry) => entry.runtime)).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
      "ready",
    ]);
  });

  it("rejects an unknown driver before the scope is stored", async () => {
    const grok: ExecutionProfileDto = {
      driverId: "grok-stream-json",
      installationId: "inst-codex",
      credentialMode: "installation-managed",
      options: {},
    };
    await expectHttp(
      () =>
        rig.manager.createScope(
          scopeRequest(
            [participant("p-ok"), { participantId: "p-bad", profile: grok, modelId: "gpt-test" }],
            "req-unknown-drv",
          ),
        ),
      400,
      {
        code: "PROFILE_INVALID",
        phase: "prewarm",
        message: "unknown driverId in profile",
        retryable: false,
      },
    );
    expect(rig.factoryCalls).toEqual(["codex-app-server:p-ok"]);
    expect([...rig.manager._scopes.keys()]).toEqual([]);
    expect(rig.scriptFor("p-ok").prewarmInputs).toEqual([]);
  });
});

describe("scope manager prewarm outcomes", () => {
  it("keeps a static installation failure off the live-driver count and out of the log", async () => {
    const created = await rig.manager.createScope(
      scopeRequest(
        [participant("p-ok"), participant("p-missing", codexProfile("inst-missing"))],
        "req-static-miss",
      ),
    );
    expect(created.scope.participants).toEqual([
      readyStatus("p-ok"),
      {
        participantId: "p-missing",
        runtime: "failed",
        binding: null,
        readiness: { state: "invalid_binding", detail: "unknown installationId" },
      },
    ]);
    expect(rig.scriptFor("p-missing").prewarmInputs).toEqual([]);
    expect(rig.logs).toEqual([]);
    expect(rig.manager.counts()).toEqual({
      activeScopes: 1,
      liveDriverProcesses: 1,
      runningExecutions: 0,
      eventConnections: 0,
    });
  });

  it("treats a throwing installation lookup as an unknown installation", async () => {
    rig.getThrow.add("inst-throw");
    const created = await rig.manager.createScope(
      scopeRequest([participant("p-1", codexProfile("inst-throw"))], "req-get-throws"),
    );
    expect(created.scope.participants).toEqual([
      {
        participantId: "p-1",
        runtime: "failed",
        binding: null,
        readiness: { state: "invalid_binding", detail: "unknown installationId" },
      },
    ]);
  });

  it("records a driver mismatch and an untrusted installation as failed readiness", async () => {
    rig.dtos.set("inst-claude", {
      installationId: "inst-claude",
      driverId: "claude-stream-json",
      state: "trusted",
      executablePath: "/opt/claude",
      fingerprint: "fp-claude",
      components: [],
      detail: null,
    });
    rig.dtos.set("inst-changed", {
      installationId: "inst-changed",
      driverId: "codex-app-server",
      state: "changed",
      executablePath: "/opt/codex",
      fingerprint: "fp-codex",
      components: [],
      detail: null,
    });
    const mismatch = await rig.manager.createScope(
      scopeRequest([participant("p-mis", codexProfile("inst-claude"))], "req-mismatch-1"),
    );
    expect(mismatch.scope.participants[0]?.readiness).toEqual({
      state: "invalid_binding",
      detail: "profile driver does not match installation",
    });
    const untrusted = await rig.manager.createScope(
      scopeRequest([participant("p-un", codexProfile("inst-changed"))], "req-untrusted-1"),
    );
    expect(untrusted.scope.participants[0]).toEqual({
      participantId: "p-un",
      runtime: "failed",
      binding: null,
      readiness: {
        state: "runtime_unavailable",
        detail: "installation is changed; revalidation required",
      },
    });
    expect(rig.manager.counts().liveDriverProcesses).toBe(0);
  });

  it("rejects an unsupported claude route during static resolution", async () => {
    rig.dtos.set("inst-claude", {
      installationId: "inst-claude",
      driverId: "claude-stream-json",
      state: "trusted",
      executablePath: "/opt/claude",
      fingerprint: "fp-claude",
      components: [],
      detail: null,
    });
    const profile = {
      driverId: "claude-stream-json",
      installationId: "inst-claude",
      credentialMode: "installation-managed",
      options: { route: "not-a-route" },
    } as unknown as ExecutionProfileDto;
    const created = await rig.manager.createScope(
      scopeRequest([participant("p-1", profile)], "req-bad-route-1"),
    );
    expect(created.scope.participants[0]?.readiness).toEqual({
      state: "invalid_binding",
      detail: "unsupported route not-a-route",
    });
    expect(rig.factoryCalls).toEqual(["claude-stream-json:p-1"]);
    expect(rig.scriptFor("p-1").prewarmInputs).toEqual([]);
  });

  it("maps prewarm and assertExecutable failures onto readiness and logs", async () => {
    const cases: {
      code: string;
      message: string;
      state: "runtime_unavailable" | "model_unavailable";
    }[] = [
      { code: "AUTH_REQUIRED", message: "login required", state: "runtime_unavailable" },
      { code: "INCOMPATIBLE_DRIVER", message: "driver skew", state: "runtime_unavailable" },
      { code: "MODEL_UNAVAILABLE", message: "model missing", state: "model_unavailable" },
      { code: "DRIVER_SPAWN_FAILED", message: "spawn failed", state: "runtime_unavailable" },
    ];
    for (const [index, item] of cases.entries()) {
      const local = createRig({ creatingScopeTtlMs: 60_000, idleScopeTtlMs: 60_000 });
      local.scriptFor("p-1").prewarmImpl = () => Promise.reject(coded(item.message, item.code));
      const created = await local.manager.createScope(
        scopeRequest([participant("p-1")], `req-code-${index}`),
      );
      expect(created.scope.participants).toEqual([
        {
          participantId: "p-1",
          runtime: "failed",
          binding: null,
          readiness: { state: item.state, detail: item.message },
        },
      ]);
      expect(local.logs).toEqual([
        {
          level: "warn",
          event: "scope.prewarm_failed",
          context: { scopeId: created.scopeId, participantId: "p-1", code: item.code },
        },
      ]);
    }

    const asserted = createRig({ creatingScopeTtlMs: 60_000, idleScopeTtlMs: 60_000 });
    asserted.assertThrow.set("inst-codex", coded("auth at spawn", "AUTH_REQUIRED"));
    const created = await asserted.manager.createScope(
      scopeRequest([participant("p-1")], "req-assert-auth"),
    );
    expect(created.scope.participants[0]?.readiness).toEqual({
      state: "runtime_unavailable",
      detail: "auth at spawn",
    });
    expect(asserted.scriptFor("p-1").prewarmInputs).toEqual([]);
    expect(asserted.logs).toEqual([
      {
        level: "warn",
        event: "scope.prewarm_failed",
        context: { scopeId: created.scopeId, participantId: "p-1", code: "AUTH_REQUIRED" },
      },
    ]);
  });

  it("clips a long prewarm error and uses a fixed detail for a non-Error throw", async () => {
    rig.scriptFor("p-long").prewarmImpl = () => Promise.reject(new Error("m".repeat(300)));
    rig.scriptFor("p-str").prewarmImpl = () => Promise.reject("bad");
    const created = await rig.manager.createScope(
      scopeRequest([participant("p-long"), participant("p-str")], "req-clip-prewarm"),
    );
    expect(created.scope.participants).toEqual([
      {
        participantId: "p-long",
        runtime: "failed",
        binding: null,
        readiness: { state: "runtime_unavailable", detail: "m".repeat(256) },
      },
      {
        participantId: "p-str",
        runtime: "failed",
        binding: null,
        readiness: { state: "runtime_unavailable", detail: "prewarm failed" },
      },
    ]);
    expect(rig.logs).toEqual([
      {
        level: "warn",
        event: "scope.prewarm_failed",
        context: { scopeId: created.scopeId, participantId: "p-long", code: "UNKNOWN" },
      },
      {
        level: "warn",
        event: "scope.prewarm_failed",
        context: { scopeId: created.scopeId, participantId: "p-str", code: "UNKNOWN" },
      },
    ]);
  });

  it("leaves a CANCELLED prewarm cold and does not close the driver again", async () => {
    const gate = deferred<PrewarmResult>();
    rig.scriptFor("p-1").prewarmImpl = () => gate.promise;
    const pending = rig.manager.createScope(scopeRequest([participant("p-1")], "req-cancelled-1"));
    await flushMicrotasks();
    const scope = soleScope(rig.manager);
    rig.manager.activateScope(scope.scopeId, scope.controllerId, scope.leaseEpoch);
    await expectHttp(
      () =>
        rig.manager.execute(scope.scopeId, {
          controllerId: scope.controllerId,
          leaseEpoch: scope.leaseEpoch,
          executionId: "exec-prewarm",
          participantId: "p-1",
          snapshot: baseSnap(),
        }),
      409,
      {
        code: "PARTICIPANT_BUSY",
        phase: "dispatch",
        message: "participant is prewarming, not ready.",
        retryable: false,
      },
    );
    gate.reject(coded("probe shut down", "CANCELLED"));
    const created = await pending;
    expect(created.scope).toEqual({
      scopeId: scope.scopeId,
      state: "active",
      hostInstanceId: HOST,
      leaseEpoch: 1,
      participants: [{ participantId: "p-1", runtime: "cold", binding: null, readiness: null }],
    });
    expect(rig.scriptFor("p-1").closeCount).toBe(0);
    expect(rig.logs).toEqual([
      {
        level: "info",
        event: "scope.prewarm_cancelled",
        context: { scopeId: scope.scopeId, participantId: "p-1", scopeState: "active" },
      },
    ]);
    await expectHttp(
      () =>
        rig.manager.execute(scope.scopeId, {
          controllerId: scope.controllerId,
          leaseEpoch: scope.leaseEpoch,
          executionId: "exec-cold",
          participantId: "p-1",
          snapshot: baseSnap(),
        }),
      409,
      {
        code: "PARTICIPANT_BUSY",
        phase: "dispatch",
        message: "participant is cold, not ready.",
        retryable: false,
      },
    );
    expect(rig.manager.counts().liveDriverProcesses).toBe(0);
  });

  it("fails the participant when the handshaken model does not match", async () => {
    rig.scriptFor("p-1").prewarmImpl = async () => ({
      canonicalModelId: "gpt-other",
      modelAliases: ["gpt-else"],
      capability: { protocol: "fake", tools: false },
      catalog: ["gpt-other"],
    });
    const created = await openedScope(rig);
    expect(created.scope.participants).toEqual([
      {
        participantId: "p-1",
        runtime: "failed",
        binding: null,
        readiness: {
          state: "model_unavailable",
          detail: "requested model is not the handshaken canonical model",
        },
      },
    ]);
    await expectHttp(
      () =>
        rig.manager.execute(created.scopeId, {
          ...ctrlOf(created),
          executionId: "exec-model",
          participantId: "p-1",
          snapshot: baseSnap(),
        }),
      409,
      {
        code: "PARTICIPANT_BUSY",
        phase: "dispatch",
        message: "participant is failed, not ready.",
        retryable: false,
      },
    );
    expect(rig.logs).toEqual([]);
  });

  it("accepts a driver-declared model alias and executes the canonical id", async () => {
    rig.scriptFor("p-1").prewarmImpl = async () => ({
      canonicalModelId: "gpt-canonical",
      modelAliases: ["gpt-test"],
      capability: { protocol: "fake", tools: false },
      catalog: ["gpt-canonical", "gpt-test"],
    });
    const created = await openedScope(rig, [participant("p-1")], "req-alias-0001");
    expect(created.scope.participants).toEqual([readyStatus("p-1", ALIAS_BINDING)]);
    const outcome = await rig.manager.execute(created.scopeId, {
      ...ctrlOf(created),
      executionId: "exec-alias",
      participantId: "p-1",
      snapshot: baseSnap(),
    });
    expect(outcome).toEqual({ executionId: "exec-alias", state: "running", lastSeq: 0 });
    expect(rig.scriptFor("p-1").executeInputs).toEqual([
      {
        executionId: "exec-alias",
        prompt: FULL_PROMPT,
        modelId: "gpt-canonical",
        coldStart: true,
      },
    ]);
    expect(rig.executions.get("exec-alias")?.events).toEqual(
      defaultEvents("exec-alias", "gpt-canonical"),
    );
  });

  it("drops a late prewarm after close and ignores a follow-up close error", async () => {
    const gate = deferred<PrewarmResult>();
    let closes = 0;
    rig.scriptFor("p-1").prewarmImpl = () => gate.promise;
    rig.scriptFor("p-1").closeImpl = () => {
      closes += 1;
      if (closes >= 2) return Promise.reject(new Error("race close"));
      return Promise.resolve();
    };
    const pending = rig.manager.createScope(scopeRequest([participant("p-1")], "req-race-close"));
    await flushMicrotasks();
    await rig.manager.closeAll("race");
    const closedId = soleScope(rig.manager).scopeId;
    expect(rig.manager.getScopeStatus(closedId).state).toBe("closed");
    gate.resolve(STANDARD_PREWARM);
    const created = await pending;
    expect(created.scope).toEqual({
      scopeId: closedId,
      state: "closed",
      hostInstanceId: HOST,
      leaseEpoch: 1,
      participants: [{ participantId: "p-1", runtime: "cold", binding: null, readiness: null }],
    });
    expect(rig.scriptFor("p-1").closeCount).toBe(2);
    expect(rig.logs).toEqual([
      {
        level: "info",
        event: "scope.closing",
        context: { scopeId: closedId, reason: "race" },
      },
      {
        level: "warn",
        event: "scope.prewarm_race_closed",
        context: { scopeId: closedId, participantId: "p-1", scopeState: "closed" },
      },
    ]);
    expect(rig.manager.counts()).toEqual({
      activeScopes: 0,
      liveDriverProcesses: 0,
      runningExecutions: 0,
      eventConnections: 0,
    });
  });

  it("tears down a participant that became ready before an in-flight close finished", async () => {
    const firstClose = deferred<void>();
    const bPrewarm = deferred<PrewarmResult>();
    let aCloses = 0;
    rig.scriptFor("p-a").closeImpl = () => {
      aCloses += 1;
      if (aCloses === 1) return firstClose.promise;
      return Promise.reject(new Error("belt close"));
    };
    rig.scriptFor("p-b").prewarmImpl = () => bPrewarm.promise;
    const pending = rig.manager.createScope(
      scopeRequest([participant("p-a"), participant("p-b")], "req-belt-0001"),
    );
    await flushMicrotasks();
    const scope = soleScope(rig.manager);
    expect(
      rig.manager.getScopeStatus(scope.scopeId).participants.map((entry) => entry.runtime),
    ).toEqual(["ready", "prewarming"]);
    const closing = rig.manager.closeAll("belt");
    await flushMicrotasks();
    expect(rig.manager.getScopeStatus(scope.scopeId).state).toBe("closing");
    bPrewarm.resolve(STANDARD_PREWARM);
    const created = await pending;
    expect(created.scope.state).toBe("closing");
    expect(created.scope.participants).toEqual([
      { participantId: "p-a", runtime: "cold", binding: null, readiness: null },
      { participantId: "p-b", runtime: "cold", binding: null, readiness: null },
    ]);
    expect(rig.scriptFor("p-a").closeCount).toBe(2);
    expect(rig.scriptFor("p-b").closeCount).toBe(2);
    expect(rig.logs).toEqual([
      {
        level: "info",
        event: "scope.closing",
        context: { scopeId: scope.scopeId, reason: "belt" },
      },
      {
        level: "warn",
        event: "scope.prewarm_race_closed",
        context: { scopeId: scope.scopeId, participantId: "p-b", scopeState: "closing" },
      },
    ]);
    firstClose.resolve();
    await closing;
    expect(rig.manager.getScopeStatus(scope.scopeId).state).toBe("closed");
    expect(rig.logs).toEqual([
      {
        level: "info",
        event: "scope.closing",
        context: { scopeId: scope.scopeId, reason: "belt" },
      },
      {
        level: "warn",
        event: "scope.prewarm_race_closed",
        context: { scopeId: scope.scopeId, participantId: "p-b", scopeState: "closing" },
      },
    ]);
  });
});

describe("scope manager activate, takeover, close, and ttl", () => {
  it("activates once, ignores a second activate, and clears the creating timer", async () => {
    const local = createRig({ creatingScopeTtlMs: 1_000, idleScopeTtlMs: 5_000 });
    const created = await local.manager.createScope(
      scopeRequest([participant("p-1")], "req-activate-1"),
    );
    const status = local.manager.activateScope(
      created.scopeId,
      created.controllerId,
      created.leaseEpoch,
    );
    expect(status).toEqual({
      scopeId: created.scopeId,
      state: "active",
      hostInstanceId: HOST,
      leaseEpoch: 1,
      participants: [readyStatus("p-1")],
    });
    expect(soleScope(local.manager).creatingTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(local.manager.getScopeStatus(created.scopeId).state).toBe("active");
    const second = local.manager.activateScope(
      created.scopeId,
      created.controllerId,
      created.leaseEpoch,
    );
    expect(second).toEqual(status);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(local.manager.getScopeStatus(created.scopeId).state).toBe("active");
    await vi.advanceTimersByTimeAsync(1);
    expect(local.manager.getScopeStatus(created.scopeId).state).toBe("closed");
    expect(local.logs).toEqual([
      {
        level: "info",
        event: "scope.idle_ttl_expired",
        context: { scopeId: created.scopeId },
      },
      {
        level: "info",
        event: "scope.closing",
        context: { scopeId: created.scopeId, reason: "idle-ttl" },
      },
    ]);
  });

  it("uses the 30s creating default and the 30min idle default", async () => {
    const creating = createRig();
    const created = await creating.manager.createScope(
      scopeRequest([participant("p-1")], "req-default-ttl"),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(creating.manager.getScopeStatus(created.scopeId).state).toBe("creating");
    await vi.advanceTimersByTimeAsync(1);
    expect(creating.manager.getScopeStatus(created.scopeId).state).toBe("closed");
    expect(creating.logs[0]).toEqual({
      level: "warn",
      event: "scope.creating_ttl_expired",
      context: { scopeId: created.scopeId },
    });

    const idle = createRig({ creatingScopeTtlMs: 60_000 });
    const active = await idle.manager.createScope(
      scopeRequest([participant("p-1")], "req-default-idle"),
    );
    idle.manager.activateScope(active.scopeId, active.controllerId, active.leaseEpoch);
    await vi.advanceTimersByTimeAsync(1_799_999);
    expect(idle.manager.getScopeStatus(active.scopeId).state).toBe("active");
    await vi.advanceTimersByTimeAsync(1);
    expect(idle.manager.getScopeStatus(active.scopeId).state).toBe("closed");
    expect(idle.logs[0]).toEqual({
      level: "info",
      event: "scope.idle_ttl_expired",
      context: { scopeId: active.scopeId },
    });
  });

  it("closes a creating scope when its ttl fires and does not close twice", async () => {
    const local = createRig({ creatingScopeTtlMs: 1_000, idleScopeTtlMs: 60_000 });
    const created = await local.manager.createScope(
      scopeRequest([participant("p-1")], "req-create-ttl"),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(local.manager.getScopeStatus(created.scopeId).state).toBe("creating");
    await vi.advanceTimersByTimeAsync(1);
    expect(local.manager.getScopeStatus(created.scopeId).state).toBe("closed");
    expect(local.scriptFor("p-1").closeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(local.scriptFor("p-1").closeCount).toBe(1);
    expect(local.logs).toEqual([
      {
        level: "warn",
        event: "scope.creating_ttl_expired",
        context: { scopeId: created.scopeId },
      },
      {
        level: "info",
        event: "scope.closing",
        context: { scopeId: created.scopeId, reason: "creating-ttl" },
      },
    ]);
  });

  it("re-arms the idle timer on a terminal event and while an execution is busy", async () => {
    const local = createRig({ creatingScopeTtlMs: 60_000, idleScopeTtlMs: 1_000 });
    const gate = deferred<void>();
    let emit: Emit | null = null;
    local.scriptFor("p-1").executeImpl = (_input, saved) => {
      emit = saved;
      saved({ type: "started", requestedModel: "gpt-test" });
      saved({ type: "output.delta", text: "partial" });
      return gate.promise;
    };
    const created = await local.manager.createScope(
      scopeRequest([participant("p-1")], "req-idle-busy"),
    );
    local.manager.activateScope(created.scopeId, created.controllerId, created.leaseEpoch);
    const outcome = await local.manager.execute(created.scopeId, {
      ...ctrlOf(created),
      executionId: "exec-busy",
      participantId: "p-1",
      snapshot: baseSnap(),
    });
    expect(outcome).toEqual({ executionId: "exec-busy", state: "running", lastSeq: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(local.manager.getScopeStatus(created.scopeId).state).toBe("active");
    expect(local.logs).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(local.manager.getScopeStatus(created.scopeId).state).toBe("active");
    const fire = emit as Emit | null;
    if (fire === null) throw new Error("missing emit");
    fire(completedProto("gpt-test", "done", 3));
    gate.resolve();
    await flushMicrotasks();
    expect(local.manager.getScopeStatus(created.scopeId).participants[0]?.runtime).toBe("ready");
    expect(local.executions.get("exec-busy")?.state).toBe("completed");
    await vi.advanceTimersByTimeAsync(500);
    expect(local.manager.getScopeStatus(created.scopeId).state).toBe("active");
    await vi.advanceTimersByTimeAsync(499);
    expect(local.manager.getScopeStatus(created.scopeId).state).toBe("active");
    await vi.advanceTimersByTimeAsync(1);
    expect(local.manager.getScopeStatus(created.scopeId).state).toBe("closed");
    expect(local.logs).toEqual([
      { level: "info", event: "scope.idle_ttl_expired", context: { scopeId: created.scopeId } },
      {
        level: "info",
        event: "scope.closing",
        context: { scopeId: created.scopeId, reason: "idle-ttl" },
      },
    ]);
  });

  it("does not arm a new idle timer when a terminal arrives during close", async () => {
    const local = createRig({ creatingScopeTtlMs: 60_000, idleScopeTtlMs: 500 });
    let saved: Emit | null = null;
    local.scriptFor("p-1").executeImpl = (_input, emit) => {
      saved = emit;
      emit({ type: "started", requestedModel: "gpt-test" });
      emit(completedProto("gpt-test", "ok", 1));
      return Promise.resolve();
    };
    local.scriptFor("p-1").closeImpl = async () => {
      saved?.(completedProto("gpt-test", "late", 1));
    };
    const created = await local.manager.createScope(
      scopeRequest([participant("p-1")], "req-late-term"),
    );
    local.manager.activateScope(created.scopeId, created.controllerId, created.leaseEpoch);
    await local.manager.execute(created.scopeId, {
      ...ctrlOf(created),
      executionId: "exec-late",
      participantId: "p-1",
      snapshot: baseSnap(),
    });
    await flushMicrotasks();
    await local.manager.closeScope(created.scopeId, ctrlOf(created));
    expect(soleScope(local.manager).idleTimer).toBeNull();
    expect(local.scriptFor("p-1").closeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(soleScope(local.manager).idleTimer).toBeNull();
    expect(local.scriptFor("p-1").closeCount).toBe(1);
    expect(local.manager.getScopeStatus(created.scopeId).state).toBe("closed");
    expect(local.logs.filter((line) => line.event === "scope.idle_ttl_expired")).toEqual([]);
    expect(local.logs.filter((line) => line.event === "scope.closing")).toEqual([
      {
        level: "info",
        event: "scope.closing",
        context: { scopeId: created.scopeId, reason: "controller-close" },
      },
    ]);
  });

  it("fences activate, takeover, and close, and closes every scope from closeAll", async () => {
    const first = await rig.manager.createScope(
      scopeRequest([participant("p-1")], "req-fence-001"),
    );
    const second = await rig.manager.createScope(
      scopeRequest([participant("p-2")], "req-fence-002"),
    );
    await expectHttp(
      () => rig.manager.activateScope(first.scopeId, "other", first.leaseEpoch),
      409,
      STALE,
    );
    await expectHttp(
      () => rig.manager.activateScope(first.scopeId, first.controllerId, 9),
      409,
      STALE,
    );
    await expectHttp(() => rig.manager.activateScope("scope-missing", "c", 1), 404, NOT_FOUND);
    await expectHttp(() => rig.manager.takeover("scope-missing", "ctrl-x"), 404, NOT_FOUND);
    await expectHttp(
      () => rig.manager.closeScope(first.scopeId, { controllerId: "other", leaseEpoch: 1 }),
      409,
      STALE,
    );
    rig.scriptFor("p-1").closeImpl = () => Promise.reject(new Error("close boom"));
    expect(await rig.manager.closeScope(first.scopeId, ctrlOf(first))).toEqual({
      scopeId: first.scopeId,
      state: "closed",
    });
    expect(rig.manager.getScopeStatus(first.scopeId).participants[0]?.runtime).toBe("cold");
    expect(rig.scriptFor("p-1").closeCount).toBe(1);
    await expectHttp(() => rig.manager.closeScope(first.scopeId, ctrlOf(first)), 409, SCOPE_CLOSED);
    await expectHttp(() => rig.manager.takeover(first.scopeId, "ctrl-x"), 409, SCOPE_CLOSED);
    await expectHttp(
      () => rig.manager.activateScope(first.scopeId, first.controllerId, first.leaseEpoch),
      409,
      SCOPE_CLOSED,
    );

    const gate = deferred<void>();
    rig.scriptFor("p-2").closeImpl = () => gate.promise;
    const closing = rig.manager.closeScope(second.scopeId, ctrlOf(second));
    await flushMicrotasks();
    await expectHttp(() => rig.manager.takeover(second.scopeId, "ctrl-y"), 409, SCOPE_CLOSED);
    await rig.manager.closeAll("again");
    expect(rig.logs.filter((line) => line.event === "scope.closing")).toEqual([
      {
        level: "info",
        event: "scope.closing",
        context: { scopeId: first.scopeId, reason: "controller-close" },
      },
      {
        level: "info",
        event: "scope.closing",
        context: { scopeId: second.scopeId, reason: "controller-close" },
      },
    ]);
    gate.resolve();
    await closing;
    expect(rig.manager.getScopeStatus(second.scopeId).state).toBe("closed");
    await rig.manager.closeAll("shutdown");
    expect(rig.logs.filter((line) => line.context && line.context.reason === "shutdown")).toEqual(
      [],
    );
  });
});

describe("scope manager execute, cancel, and ack", () => {
  it("rejects execute before activation, for a stale controller, and for an unknown participant", async () => {
    const created = await rig.manager.createScope(
      scopeRequest([participant("p-1")], "req-exec-fence"),
    );
    const body = {
      ...ctrlOf(created),
      executionId: "exec-1",
      participantId: "p-1",
      snapshot: baseSnap(),
    };
    await expectHttp(() => rig.manager.execute(created.scopeId, body), 409, {
      code: "SCOPE_CLOSED",
      phase: "dispatch",
      message: "Scope is not active.",
      retryable: false,
    });
    rig.manager.activateScope(created.scopeId, created.controllerId, created.leaseEpoch);
    await expectHttp(
      () => rig.manager.execute(created.scopeId, { ...body, controllerId: "other" }),
      409,
      STALE,
    );
    await expectHttp(
      () => rig.manager.execute(created.scopeId, { ...body, participantId: "missing" }),
      404,
      {
        code: "PARTICIPANT_NOT_FOUND",
        phase: "dispatch",
        message: "Unknown participant.",
        retryable: false,
      },
    );
    await expectHttp(
      () =>
        rig.manager.execute("scope-missing", {
          controllerId: "c",
          leaseEpoch: 1,
          executionId: "exec-x",
          participantId: "p-1",
          snapshot: baseSnap(),
        }),
      404,
      NOT_FOUND,
    );
    await rig.manager.closeScope(created.scopeId, ctrlOf(created));
    await expectHttp(() => rig.manager.execute(created.scopeId, body), 409, SCOPE_CLOSED);
  });

  it("runs a full turn, reconnects the same execution id, then an incremental turn", async () => {
    const created = await openedScope(rig);
    const first = await rig.manager.execute(created.scopeId, {
      ...ctrlOf(created),
      executionId: "exec-1",
      participantId: "p-1",
      snapshot: baseSnap(),
    });
    expect(first).toEqual({ executionId: "exec-1", state: "running", lastSeq: 0 });
    await flushMicrotasks();
    expect(rig.executions.get("exec-1")?.state).toBe("completed");
    expect(rig.executions.get("exec-1")?.events).toEqual(defaultEvents("exec-1"));
    expect(rig.manager.getScopeStatus(created.scopeId).participants[0]?.runtime).toBe("ready");
    expect(rig.reconciler.record("p-1")).toEqual({
      sessionEpoch: 0,
      digestVersion: 1,
      contextRevision: 1,
      contextDigest: "digest-r1",
      participantSnapshotDigest: "participant-digest-1",
      appliedItemCount: 1,
      itemDigests: [HELLO_DIGEST],
      topic: "T",
      background: "B",
      executionCount: 1,
      cumulativeInputTokens: 12,
      executionIds: ["exec-1"],
    });

    const duplicate = await rig.manager.execute(created.scopeId, {
      ...ctrlOf(created),
      executionId: "exec-1",
      participantId: "p-1",
      snapshot: baseSnap(),
    });
    expect(duplicate).toEqual({ executionId: "exec-1", state: "completed", lastSeq: 2 });
    expect(rig.scriptFor("p-1").executeInputs).toEqual([
      { executionId: "exec-1", prompt: FULL_PROMPT, modelId: "gpt-test", coldStart: true },
    ]);

    const second = await rig.manager.execute(created.scopeId, {
      ...ctrlOf(created),
      executionId: "exec-2",
      participantId: "p-1",
      snapshot: snap({
        revision: 2,
        topic: "T",
        background: "B",
        items: [helloItem(), otherItem()],
      }),
    });
    expect(second).toEqual({ executionId: "exec-2", state: "running", lastSeq: 0 });
    await flushMicrotasks();
    expect(rig.scriptFor("p-1").executeInputs).toEqual([
      { executionId: "exec-1", prompt: FULL_PROMPT, modelId: "gpt-test", coldStart: true },
      { executionId: "exec-2", prompt: INCREMENTAL_PROMPT, modelId: "gpt-test", coldStart: false },
    ]);
    expect(rig.executions.get("exec-2")?.events).toEqual(defaultEvents("exec-2"));
    expect(rig.reconciler.record("p-1")).toEqual({
      sessionEpoch: 0,
      digestVersion: 1,
      contextRevision: 2,
      contextDigest: "digest-r2",
      participantSnapshotDigest: "participant-digest-1",
      appliedItemCount: 2,
      itemDigests: [HELLO_DIGEST, OTHER_DIGEST],
      topic: "T",
      background: "B",
      executionCount: 2,
      cumulativeInputTokens: 24,
      executionIds: ["exec-1", "exec-2"],
    });
  });

  it("fails a turn that needs a rebase and does not dispatch the driver", async () => {
    const created = await openedScope(rig);
    await rig.manager.execute(created.scopeId, {
      ...ctrlOf(created),
      executionId: "exec-1",
      participantId: "p-1",
      snapshot: baseSnap(),
    });
    await flushMicrotasks();
    const outcome = await rig.manager.execute(created.scopeId, {
      ...ctrlOf(created),
      executionId: "exec-2",
      participantId: "p-1",
      snapshot: snap({
        revision: 2,
        topic: "U",
        background: "B",
        items: [helloItem(), otherItem()],
      }),
    });
    expect(outcome).toEqual({ executionId: "exec-2", state: "failed", lastSeq: 2 });
    expect(rig.executions.get("exec-2")?.events).toEqual([
      { executionId: "exec-2", seq: 1, at: AT, type: "started", requestedModel: "gpt-test" },
      {
        executionId: "exec-2",
        seq: 2,
        at: AT,
        type: "failed",
        error: {
          code: "NEEDS_REBASE",
          phase: "dispatch",
          retryable: false,
          message: "session reconciliation: shared_context_changed",
          executionId: "exec-2",
          participantId: "p-1",
          driverId: "codex-app-server",
        },
        dispatchState: "not_dispatched",
        toolState: "none",
        retryable: false,
      },
    ]);
    expect(rig.scriptFor("p-1").executeInputs).toEqual([
      { executionId: "exec-1", prompt: FULL_PROMPT, modelId: "gpt-test", coldStart: true },
    ]);
    expect(rig.manager.getScopeStatus(created.scopeId).participants[0]?.runtime).toBe("ready");
    expect(rig.reconciler.record("p-1")?.executionIds).toEqual(["exec-1"]);
    const replay = await rig.manager.execute(created.scopeId, {
      ...ctrlOf(created),
      executionId: "exec-2",
      participantId: "p-1",
      snapshot: snap({
        revision: 2,
        topic: "U",
        background: "B",
        items: [helloItem(), otherItem()],
      }),
    });
    expect(replay).toEqual({ executionId: "exec-2", state: "failed", lastSeq: 2 });
    expect(rig.executions.get("exec-2")?.lastSeq).toBe(2);
  });

  it("records an INTERNAL failure when execute rejects, including a non-Error and a clipped message", async () => {
    const created = await openedScope(
      rig,
      [participant("p-clip"), participant("p-str"), participant("p-later")],
      "req-exec-fail",
    );
    rig.scriptFor("p-clip").executeImpl = () => Promise.reject(new Error("x".repeat(300)));
    rig.scriptFor("p-str").executeImpl = () => Promise.reject("nope");
    rig.scriptFor("p-later").executeImpl = (_input, emit) => {
      emit({ type: "started", requestedModel: "gpt-test" });
      throw new Error("later");
    };
    expect(
      await rig.manager.execute(created.scopeId, {
        ...ctrlOf(created),
        executionId: "exec-clip",
        participantId: "p-clip",
        snapshot: baseSnap(),
      }),
    ).toEqual({ executionId: "exec-clip", state: "running", lastSeq: 0 });
    await flushMicrotasks();
    expect(rig.executions.get("exec-clip")?.events).toEqual([
      {
        executionId: "exec-clip",
        seq: 1,
        at: AT,
        type: "failed",
        error: {
          code: "INTERNAL",
          phase: "dispatch",
          retryable: false,
          message: "x".repeat(256),
          executionId: "exec-clip",
          participantId: "p-clip",
        },
        dispatchState: "unknown",
        toolState: "unknown",
        retryable: false,
      },
    ]);
    expect(
      await rig.manager.execute(created.scopeId, {
        ...ctrlOf(created),
        executionId: "exec-str",
        participantId: "p-str",
        snapshot: baseSnap(),
      }),
    ).toEqual({ executionId: "exec-str", state: "running", lastSeq: 0 });
    await flushMicrotasks();
    expect(rig.executions.get("exec-str")?.events[0]).toEqual({
      executionId: "exec-str",
      seq: 1,
      at: AT,
      type: "failed",
      error: {
        code: "INTERNAL",
        phase: "dispatch",
        retryable: false,
        message: "execute failed",
        executionId: "exec-str",
        participantId: "p-str",
      },
      dispatchState: "unknown",
      toolState: "unknown",
      retryable: false,
    });
    expect(
      await rig.manager.execute(created.scopeId, {
        ...ctrlOf(created),
        executionId: "exec-later",
        participantId: "p-later",
        snapshot: baseSnap(),
      }),
    ).toEqual({ executionId: "exec-later", state: "running", lastSeq: 0 });
    await flushMicrotasks();
    expect(rig.executions.get("exec-later")?.events).toEqual([
      { executionId: "exec-later", seq: 1, at: AT, type: "started", requestedModel: "gpt-test" },
      {
        executionId: "exec-later",
        seq: 2,
        at: AT,
        type: "failed",
        error: {
          code: "INTERNAL",
          phase: "dispatch",
          retryable: false,
          message: "later",
          executionId: "exec-later",
          participantId: "p-later",
        },
        dispatchState: "unknown",
        toolState: "unknown",
        retryable: false,
      },
    ]);
    expect(
      rig.manager.getScopeStatus(created.scopeId).participants.map((entry) => entry.runtime),
    ).toEqual(["ready", "ready", "ready"]);
    expect(rig.reconciler.record("p-clip")).toBeNull();
  });

  it("enforces the concurrent execution quota and frees a slot when one finishes", async () => {
    const ids = ["p-1", "p-2", "p-3", "p-4", "p-5"];
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const emits = new Map<string, Emit>();
    for (const id of ids) {
      const gate = deferred<void>();
      gates.set(id, gate);
      rig.scriptFor(id).executeImpl = (input, emit) => {
        emits.set(input.executionId, emit);
        emit({ type: "started", requestedModel: "gpt-test" });
        return gate.promise;
      };
    }
    const created = await openedScope(
      rig,
      ids.map((id) => participant(id)),
      "req-quota-exec",
    );
    for (const id of ids.slice(0, 4)) {
      const outcome = await rig.manager.execute(created.scopeId, {
        ...ctrlOf(created),
        executionId: `exec-${id}`,
        participantId: id,
        snapshot: baseSnap(),
      });
      expect(outcome).toEqual({ executionId: `exec-${id}`, state: "running", lastSeq: 0 });
    }
    const seen: RuntimeEvent[] = [];
    const unsub = rig.executions.follow("exec-p-1", 0, (event) => {
      seen.push(event);
    });
    expect(seen).toEqual([
      { executionId: "exec-p-1", seq: 1, at: AT, type: "started", requestedModel: "gpt-test" },
    ]);
    expect(rig.manager.counts()).toEqual({
      activeScopes: 1,
      liveDriverProcesses: 5,
      runningExecutions: 4,
      eventConnections: 1,
    });
    if (!unsub) throw new Error("expected a follower");
    unsub();
    expect(rig.manager.counts().eventConnections).toBe(0);
    await expectHttp(
      () =>
        rig.manager.execute(created.scopeId, {
          ...ctrlOf(created),
          executionId: "exec-p-5",
          participantId: "p-5",
          snapshot: baseSnap(),
        }),
      429,
      {
        code: "RESOURCE_LIMIT",
        phase: "quota",
        message: "Concurrent execution quota reached.",
        retryable: false,
      },
    );
    await expectHttp(
      () =>
        rig.manager.execute(created.scopeId, {
          ...ctrlOf(created),
          executionId: "exec-p-1b",
          participantId: "p-1",
          snapshot: baseSnap(),
        }),
      409,
      {
        code: "PARTICIPANT_BUSY",
        phase: "dispatch",
        message: "participant is busy, not ready.",
        retryable: false,
      },
    );
    const finish = emits.get("exec-p-1");
    const gate = gates.get("p-1");
    if (!finish || !gate) throw new Error("missing exec-p-1 controls");
    finish(completedProto("gpt-test", "done", 2));
    gate.resolve();
    await flushMicrotasks();
    expect(rig.manager.counts().runningExecutions).toBe(3);
    const fifth = await rig.manager.execute(created.scopeId, {
      ...ctrlOf(created),
      executionId: "exec-p-5",
      participantId: "p-5",
      snapshot: baseSnap(),
    });
    expect(fifth).toEqual({ executionId: "exec-p-5", state: "running", lastSeq: 0 });
    expect(rig.manager.counts().runningExecutions).toBe(4);
    for (const id of ["p-2", "p-3", "p-4", "p-5"]) gates.get(id)?.resolve();
    await flushMicrotasks();
  });

  it("cancels a running execution as cancelling and a finished one as its settled state", async () => {
    const gate = deferred<void>();
    let saved: Emit | null = null;
    rig.scriptFor("p-1").executeImpl = (_input, emit) => {
      saved = emit;
      emit({ type: "started", requestedModel: "gpt-test" });
      return gate.promise;
    };
    rig.scriptFor("p-1").cancelImpl = async () => {
      saved?.({
        type: "interrupted",
        reason: "user_cancelled",
        dispatchState: "accepted",
        toolState: "none",
      });
      gate.resolve();
    };
    const owner = await openedScope(rig, [participant("p-1")], "req-cancel-own");
    const other = await openedScope(rig, [participant("p-2")], "req-cancel-oth");
    const started = await rig.manager.execute(owner.scopeId, {
      ...ctrlOf(owner),
      executionId: "exec-cancel",
      participantId: "p-1",
      snapshot: baseSnap(),
    });
    expect(started).toEqual({ executionId: "exec-cancel", state: "running", lastSeq: 0 });
    await expectHttp(() => rig.manager.cancel(other.scopeId, "exec-cancel", ctrlOf(other)), 404, {
      code: "EXECUTION_NOT_FOUND",
      phase: "cancel",
      message: "Unknown execution.",
      retryable: false,
    });
    await expectHttp(() => rig.manager.cancel(owner.scopeId, "exec-missing", ctrlOf(owner)), 404, {
      code: "EXECUTION_NOT_FOUND",
      phase: "cancel",
      message: "Unknown execution.",
      retryable: false,
    });
    await expectHttp(
      () =>
        rig.manager.cancel(owner.scopeId, "exec-cancel", { controllerId: "nope", leaseEpoch: 1 }),
      409,
      STALE,
    );
    expect(await rig.manager.cancel(owner.scopeId, "exec-cancel", ctrlOf(owner))).toEqual({
      executionId: "exec-cancel",
      state: "cancelling",
    });
    expect(rig.scriptFor("p-1").cancelIds).toEqual(["exec-cancel"]);
    expect(rig.executions.get("exec-cancel")?.state).toBe("interrupted");
    expect(rig.executions.get("exec-cancel")?.events).toEqual([
      { executionId: "exec-cancel", seq: 1, at: AT, type: "started", requestedModel: "gpt-test" },
      {
        executionId: "exec-cancel",
        seq: 2,
        at: AT,
        type: "interrupted",
        reason: "user_cancelled",
        dispatchState: "accepted",
        toolState: "none",
      },
    ]);
    expect(rig.manager.getScopeStatus(owner.scopeId).participants[0]?.runtime).toBe("ready");
    expect(await rig.manager.cancel(owner.scopeId, "exec-cancel", ctrlOf(owner))).toEqual({
      executionId: "exec-cancel",
      state: "interrupted",
    });
    expect(rig.scriptFor("p-1").cancelIds).toEqual(["exec-cancel", "exec-cancel"]);

    rig.executions.begin("exec-ghost", "ghost", owner.scopeId);
    await expectHttp(() => rig.manager.cancel(owner.scopeId, "exec-ghost", ctrlOf(owner)), 404, {
      code: "PARTICIPANT_NOT_FOUND",
      phase: "cancel",
      message: "Unknown participant.",
      retryable: false,
    });
  });

  it("acknowledges a terminal execution and rejects conflicts, misses, and cross-scope acks", async () => {
    const created = await openedScope(rig, [participant("p-1")], "req-ack-00001");
    const other = await openedScope(rig, [participant("p-2")], "req-ack-00002");
    await rig.manager.execute(created.scopeId, {
      ...ctrlOf(created),
      executionId: "exec-ack",
      participantId: "p-1",
      snapshot: baseSnap(),
    });
    await flushMicrotasks();
    rig.executions.begin("exec-early", "p-1", created.scopeId);
    await expectHttp(
      () => rig.manager.ack(created.scopeId, "exec-early", 1, "committed", ctrlOf(created)),
      409,
      {
        code: "EXECUTION_CONFLICT",
        phase: "commit",
        message: "ACK before a terminal event.",
        retryable: false,
        executionId: "exec-early",
      },
    );
    await expectHttp(
      () => rig.manager.ack(created.scopeId, "exec-ack", 1, "committed", ctrlOf(created)),
      409,
      {
        code: "EXECUTION_CONFLICT",
        phase: "commit",
        message: "ACK finalSeq does not match the terminal event.",
        retryable: false,
        executionId: "exec-ack",
      },
    );
    expect(rig.manager.ack(created.scopeId, "exec-ack", 2, "discarded", ctrlOf(created))).toEqual({
      executionId: "exec-ack",
      ackState: "acknowledged",
      disposition: "discarded",
    });
    expect(rig.manager.ack(created.scopeId, "exec-ack", 2, "discarded", ctrlOf(created))).toEqual({
      executionId: "exec-ack",
      ackState: "acknowledged",
      disposition: "discarded",
    });
    await expectHttp(
      () => rig.manager.ack(created.scopeId, "exec-ack", 2, "committed", ctrlOf(created)),
      409,
      {
        code: "EXECUTION_CONFLICT",
        phase: "commit",
        message: "ACK disposition differs from the recorded terminal disposition.",
        retryable: false,
        executionId: "exec-ack",
      },
    );
    expect(
      rig.manager.ack(created.scopeId, "exec-missing", 1, "committed", ctrlOf(created)),
    ).toEqual({
      executionId: "exec-missing",
      ackState: "expired",
      disposition: null,
    });
    await expectHttp(
      () => rig.manager.ack(other.scopeId, "exec-ack", 2, "discarded", ctrlOf(other)),
      404,
      {
        code: "EXECUTION_NOT_FOUND",
        phase: "commit",
        message: "Unknown execution.",
        retryable: false,
      },
    );
    await expectHttp(
      () =>
        rig.manager.ack(created.scopeId, "exec-ack", 2, "discarded", {
          controllerId: "nope",
          leaseEpoch: 1,
        }),
      409,
      STALE,
    );
    await rig.manager.closeScope(created.scopeId, ctrlOf(created));
    expect(rig.executions.get("exec-ack")).toBeNull();
    expect(rig.reconciler.record("p-1")).toBeNull();
    expect(rig.scriptFor("p-1").closeCount).toBe(1);
    expect(rig.manager.counts()).toEqual({
      activeScopes: 1,
      liveDriverProcesses: 1,
      runningExecutions: 0,
      eventConnections: 0,
    });
  });

  it("uses registry fallbacks when a terminal read or conflict error is missing", async () => {
    let reads = 0;
    let boundScopeId = "";
    const emitted: unknown[] = [];
    const executions: ExecutionRegistry = {
      begin: () => ({
        record: {
          executionId: "exec-rebase",
          participantId: "p-1",
          scopeId: boundScopeId,
          state: "running",
          events: [],
          lastSeq: 0,
          bufferedBytes: 0,
          ackState: "pending",
          disposition: null,
          tombstone: false,
          terminal: null,
          createdAt: AT,
        },
        created: true,
      }),
      get: (executionId) => {
        reads += 1;
        if (executionId === "exec-cancel" && reads === 1) {
          const record: ExecutionRecord = {
            executionId,
            participantId: "p-1",
            scopeId: boundScopeId,
            state: "completed",
            events: [],
            lastSeq: 2,
            bufferedBytes: 0,
            ackState: "pending",
            disposition: null,
            tombstone: false,
            terminal: null,
            createdAt: AT,
          };
          return record;
        }
        return null;
      },
      emit: (_executionId, proto) => {
        emitted.push(proto);
        return { type: proto.type } as RuntimeEvent;
      },
      follow: () => null,
      ack: () => ({ outcome: "conflict", disposition: "committed" }),
      runningCount: () => 0,
      eventConnectionCount: () => 0,
      releaseScope: () => undefined,
      reset: () => undefined,
    };
    const local = createRig({
      executions,
      creatingScopeTtlMs: 60_000,
      idleScopeTtlMs: 60_000,
    });
    const created = await local.manager.createScope(
      scopeRequest([participant("p-1")], "req-fallback-1"),
    );
    local.manager.activateScope(created.scopeId, created.controllerId, created.leaseEpoch);
    boundScopeId = created.scopeId;
    local.reconciler.recordApplied("p-1", baseSnap(), "exec-prev", 0, null);
    expect(
      await local.manager.execute(created.scopeId, {
        ...ctrlOf(created),
        executionId: "exec-rebase",
        participantId: "p-1",
        snapshot: snap({
          revision: 2,
          topic: "U",
          background: "B",
          items: [helloItem(), otherItem()],
        }),
      }),
    ).toEqual({ executionId: "exec-rebase", state: "failed", lastSeq: 2 });
    expect(emitted).toEqual([
      { type: "started", requestedModel: "gpt-test" },
      {
        type: "failed",
        error: {
          code: "NEEDS_REBASE",
          phase: "dispatch",
          retryable: false,
          message: "session reconciliation: shared_context_changed",
          executionId: "exec-rebase",
          participantId: "p-1",
          driverId: "codex-app-server",
        },
        dispatchState: "not_dispatched",
        toolState: "none",
        retryable: false,
      },
    ]);
    expect(local.scriptFor("p-1").executeInputs).toEqual([]);
    reads = 0;
    expect(await local.manager.cancel(created.scopeId, "exec-cancel", ctrlOf(created))).toEqual({
      executionId: "exec-cancel",
      state: "completed",
    });
    expect(local.scriptFor("p-1").cancelIds).toEqual(["exec-cancel"]);
    await expectHttp(
      () => local.manager.ack(created.scopeId, "exec-ack", 1, "committed", ctrlOf(created)),
      409,
      {
        code: "EXECUTION_CONFLICT",
        phase: "commit",
        message: "ACK conflict.",
        retryable: false,
      },
    );
  });
});
