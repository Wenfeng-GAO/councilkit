/**
 * Stage A gate: real-CLI conformance + cold/warm A/B latency measurement.
 *
 * Runs the REAL Runtime Host (real supervisor, real trusted installations,
 * real drivers) on the canonical origin against the four V1 paths:
 *   cld ant-glm5.2 | cld moonshot | cld deepseek | codex app-server
 *
 * Conformance (per path, in order — any failure stops the run):
 *   1. scope create (real spawn + handshake) + activate
 *   2. two consecutive turns completing with effective-model evidence and
 *      session reuse (exactly one spawn covering both turns)
 *   3. cancel of a long turn -> interrupted(user_cancelled), then a recovery
 *      turn completes (participant usable again)
 *   4. close -> driver processes reaped
 *
 * A/B measurement (per path): N cold samples (fresh scope each) and N warm
 * samples (repeat turns in one scope). Thresholds (plan, Stage A):
 *   - warm local-prep median <= 20% of cold median AND cold-warm >= 500ms
 *   - warm first-delta median <= cold first-delta median + 500ms
 *   - at least 4/5 warm turns reach first delta within 10s
 *   - Host + both drivers resident RSS growth <= 2 GiB (measured once,
 *     combined, after the per-path runs)
 *
 * Usage:
 *   TSX_TSCONFIG_PATH=tsconfig.host.json node --import tsx \
 *     tests/smoke/real-cli-conformance.mts [--path <id>] [--quick] [--out file.json]
 *
 *   --path: run a single path (cld-ant | cld-moonshot | cld-deepseek | codex)
 *   --quick: 1 cold + 1 warm sample (for iteration)
 *   --rss-only: measure only the combined-RSS gate (a path failure elsewhere
 *     stops the full run before it would reach this stage)
 */
import { writeFile } from "node:fs/promises";
import { TIMEOUTS } from "@shared/runtime/contracts";
import type { RuntimeEvent } from "@shared/runtime/events";
import type {
  ClaudeRoute,
  ContextSnapshot,
  InstallationDto,
  ParticipantSpec,
} from "@shared/runtime/schemas";
import { loadConfig } from "../../runtime-host/config";
import { createClaudeStreamJsonDriver } from "../../runtime-host/drivers/claude-stream-json";
import { createCodexAppServerDriver } from "../../runtime-host/drivers/codex-app-server";
import type { DriverDeps, ParticipantDriver } from "../../runtime-host/drivers/types";
import { createExecutionRegistry } from "../../runtime-host/executions/execution-registry";
import {
  type InstallationRecord,
  type InstallationRegistry,
  createInstallationRegistry,
} from "../../runtime-host/installations/registry";
import { createLogger } from "../../runtime-host/logging";
import { createProcessSupervisor } from "../../runtime-host/process/process-supervisor";
import { installationRoutes } from "../../runtime-host/routes/installations";
import { scopeRoutes } from "../../runtime-host/routes/scopes";
import { createScopeManager } from "../../runtime-host/scopes/scope-manager";
import { createSessionReconciler } from "../../runtime-host/scopes/session-reconciler";
import { type TestHost, authedHeaders, createTestHost } from "../host/helpers";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PathDef {
  id: string;
  driverId: "claude-stream-json" | "codex-app-server";
  route?: ClaudeRoute;
  /**
   * Pins the requested/canonical model; must still appear in the live-probed
   * catalog (closed set). codex picks from a multi-model catalog; cld routes
   * always take the driver-normalized canonical (catalog default or the
   * route's declared serving model).
   */
  preferredModelId?: string;
}

const PATHS: PathDef[] = [
  { id: "cld-ant", driverId: "claude-stream-json", route: "ant-glm5.2" },
  { id: "cld-moonshot", driverId: "claude-stream-json", route: "moonshot" },
  { id: "cld-deepseek", driverId: "claude-stream-json", route: "deepseek" },
  { id: "codex", driverId: "codex-app-server", preferredModelId: "gpt-5.6-sol" },
];

const args = process.argv.slice(2);
const onlyPath = args.includes("--path") ? args[args.indexOf("--path") + 1] : null;
const quick = args.includes("--quick");
const rssOnly = args.includes("--rss-only");
const jsonOut = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const COLD_SAMPLES = quick ? 1 : 5;
const WARM_SAMPLES = quick ? 1 : 5;

const logger = createLogger();

const TURN1_INSTRUCTION = "Reply with exactly: OK";
const TURN2_INSTRUCTION = "Reply with exactly: DONE";
const CANCEL_INSTRUCTION = "Count from 1 to 300, one number per line, no other text.";
const WARM_INSTRUCTION = "Reply with exactly: GO";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function api<T = unknown>(
  host: TestHost,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${host.baseUrl}${path}`, {
    method,
    headers: authedHeaders(host),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = (await response.json()) as {
    ok: boolean;
    data?: T;
    error?: { code: string; message: string };
  };
  if (!envelope.ok) {
    throw new Error(
      `API ${method} ${path} -> ${response.status} ${envelope.error?.code}: ${envelope.error?.message}`,
    );
  }
  return envelope.data as T;
}

async function collectEvents(
  host: TestHost,
  path: string,
  until: (event: RuntimeEvent) => boolean,
  timeoutMs: number,
): Promise<RuntimeEvent[]> {
  const controller = new AbortController();
  const response = await fetch(`${host.baseUrl}${path}`, {
    headers: authedHeaders(host),
    signal: controller.signal,
  });
  if (!response.body) throw new Error("no SSE body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: RuntimeEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      let chunk: { done?: boolean; value?: Uint8Array };
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("sse-timeout")), remaining),
          ),
        ]);
      } catch {
        break;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine && block.includes("event: runtime")) {
          const event = JSON.parse(dataLine.slice(6)) as RuntimeEvent;
          events.push(event);
          if (until(event)) return events;
        }
        index = buffer.indexOf("\n\n");
      }
    }
    return events;
  } finally {
    controller.abort();
    reader.cancel().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function snapshot(
  participantId: string,
  items: { id: string; content: string }[],
  instruction: string,
  revision: number,
): ContextSnapshot {
  return {
    digestVersion: 1,
    roomContext: {
      contextRevision: revision,
      contextDigest: `smoke-r${revision}`,
      items: items.map((item) => ({ id: item.id, role: "user" as const, content: item.content })),
    },
    participant: { participantId, participantSnapshotDigest: "smoke-participant" },
    instruction: {
      kind: "message",
      instructionDigest: `smoke-instr-${revision}`,
      text: instruction,
    },
  };
}

function specFor(
  path: PathDef,
  installationId: string,
  participantId: string,
  modelId: string,
): ParticipantSpec {
  const profile: ParticipantSpec["profile"] =
    path.driverId === "claude-stream-json"
      ? {
          driverId: "claude-stream-json" as const,
          installationId,
          credentialMode: "installation-managed" as const,
          options: { route: path.route as ClaudeRoute },
        }
      : {
          driverId: "codex-app-server" as const,
          installationId,
          credentialMode: "installation-managed" as const,
          options: {},
        };
  return {
    participantId,
    profile,
    modelId,
    personaPrompt: "You are a terse conformance-test participant. Follow instructions exactly.",
  };
}

/**
 * The requested model for a path: the pinned preference when present, else
 * the probed catalog default. A pinned model must belong to the live catalog
 * — the closed-set property is never bypassed.
 */
function resolveCanonical(
  path: PathDef,
  probeResult: { canonicalModelId: string; catalog: string[] },
): string {
  if (!path.preferredModelId) return probeResult.canonicalModelId;
  if (!probeResult.catalog.includes(path.preferredModelId)) {
    throw new Error(
      `${path.id}: preferred model ${path.preferredModelId} not in probed catalog [${probeResult.catalog.join(", ")}]`,
    );
  }
  return path.preferredModelId;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface Rig {
  host: TestHost;
  installations: InstallationRegistry;
  spawnCount(): number;
  liveDriverPids(): number[];
  makeDriver(path: PathDef, participantId: string): ParticipantDriver;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const config = loadConfig();
  const baseSupervisor = createProcessSupervisor({ config, logger });
  let spawnCount = 0;
  const pids = new Set<number>();
  const supervisor: typeof baseSupervisor = {
    ...baseSupervisor,
    spawnDriver: async (spec) => {
      spawnCount += 1;
      const proc = await baseSupervisor.spawnDriver(spec);
      // pid is null until the watchdog reports `supervised`; track it there.
      if (proc.pid) pids.add(proc.pid);
      proc.events.on("supervised", ({ pid }: { pid: number | null }) => {
        if (typeof pid === "number") pids.add(pid);
      });
      proc.events.on("exit", () => {
        if (proc.pid) pids.delete(proc.pid);
      });
      return proc;
    },
  };
  const installations = createInstallationRegistry({ logger });
  const executions = createExecutionRegistry({ logger });
  const driverDeps: DriverDeps = {
    supervisor,
    logger,
    timeouts: TIMEOUTS,
    workRoot: config.driverWorkRoot,
  };
  const factories = {
    "claude-stream-json": createClaudeStreamJsonDriver(driverDeps),
    "codex-app-server": createCodexAppServerDriver(driverDeps),
  };
  const scopeManager = createScopeManager({
    installations,
    executions,
    reconciler: createSessionReconciler(),
    driverFactories: factories,
    logger,
    hostInstanceId: "smoke-host",
  });
  const host = await createTestHost({
    extraServices: {
      installationRegistry: installations,
      executionRegistry: executions,
      scopeManager,
    },
    routesFactory: (services) => [...installationRoutes(services), ...scopeRoutes(services)],
  });
  return {
    host,
    installations,
    spawnCount: () => spawnCount,
    liveDriverPids: () => [...pids],
    makeDriver: (path, participantId) => factories[path.driverId](participantId),
    async close() {
      await scopeManager.closeAll("smoke-cleanup").catch(() => undefined);
      await baseSupervisor.shutdownAll().catch(() => undefined);
      await host.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Flow helpers
// ---------------------------------------------------------------------------

interface ScopeHandle {
  scopeId: string;
  controllerId: string;
  leaseEpoch: number;
}

async function createActiveScope(
  host: TestHost,
  scopeRequestId: string,
  participants: ParticipantSpec[],
): Promise<{ scope: ScopeHandle; prewarmMs: number }> {
  const t0 = Date.now();
  const created = await api<ScopeHandle>(host, "POST", "/api/v1/scopes", {
    scopeRequestId,
    participants,
  });
  const prewarmMs = Date.now() - t0;
  const scope = created;
  await api(host, "POST", `/api/v1/scopes/${scope.scopeId}/activate`, {
    controllerId: scope.controllerId,
    leaseEpoch: scope.leaseEpoch,
  });
  return { scope, prewarmMs };
}

async function closeScope(host: TestHost, scope: ScopeHandle): Promise<void> {
  await api(host, "POST", `/api/v1/scopes/${scope.scopeId}/close`, {
    controllerId: scope.controllerId,
    leaseEpoch: scope.leaseEpoch,
  });
}

interface TurnResult {
  events: RuntimeEvent[];
  dispatchToStartedMs: number;
  dispatchToFirstDeltaMs: number | null;
  dispatchToTerminalMs: number;
}

async function runTurn(
  host: TestHost,
  scope: ScopeHandle,
  executionId: string,
  participantId: string,
  snap: ContextSnapshot,
  timeoutMs = 180_000,
): Promise<TurnResult> {
  const t0 = Date.now();
  await api(host, "POST", `/api/v1/scopes/${scope.scopeId}/executions`, {
    controllerId: scope.controllerId,
    leaseEpoch: scope.leaseEpoch,
    executionId,
    participantId,
    snapshot: snap,
  });
  const events = await collectEvents(
    host,
    `/api/v1/scopes/${scope.scopeId}/executions/${executionId}/events`,
    (event) =>
      event.type === "completed" || event.type === "failed" || event.type === "interrupted",
    timeoutMs,
  );
  const terminal = events.at(-1);
  if (
    !terminal ||
    (terminal.type !== "completed" && terminal.type !== "failed" && terminal.type !== "interrupted")
  ) {
    throw new Error(`execution ${executionId}: no terminal within ${timeoutMs}ms`);
  }
  const started = events.find((event) => event.type === "started");
  const firstDelta = events.find((event) => event.type === "output.delta");
  return {
    events,
    dispatchToStartedMs: started ? Date.parse(started.at) - t0 : -1,
    dispatchToFirstDeltaMs: firstDelta ? Date.parse(firstDelta.at) - t0 : null,
    dispatchToTerminalMs: Date.parse(terminal.at) - t0,
  };
}

function requireCompleted(
  events: RuntimeEvent[],
  context: string,
): { output: string; effectiveModel: string | null; verdict: string } {
  const terminal = events.at(-1);
  if (terminal?.type !== "completed") {
    const detail = terminal?.type === "failed" ? terminal.error : terminal;
    throw new Error(`${context}: expected completed, got ${JSON.stringify(detail)?.slice(0, 400)}`);
  }
  if (terminal.output.trim().length === 0) {
    throw new Error(`${context}: empty normalized output`);
  }
  return {
    output: terminal.output,
    effectiveModel: terminal.effectiveModel,
    verdict: terminal.modelVerdict,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

async function rssBytes(pids: number[]): Promise<number> {
  if (pids.length === 0) return 0;
  const { execFile } = await import("node:child_process");
  return new Promise((resolvePromise) => {
    execFile("ps", ["-o", "rss=", "-p", pids.join(",")], (error, stdout) => {
      if (error) return resolvePromise(0);
      const kb = stdout
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((n) => Number.isFinite(n))
        .reduce((a, b) => a + b, 0);
      resolvePromise(kb * 1024);
    });
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface ColdSample {
  prewarmMs: number;
  firstDeltaMs: number | null;
  terminalMs: number;
}

interface WarmSample {
  prepMs: number;
  firstDeltaMs: number | null;
  terminalMs: number;
}

interface PathReport {
  pathId: string;
  canonicalModel: string;
  conformance: { step: string; ok: boolean; detail?: string }[];
  cold: ColdSample[];
  warm: WarmSample[];
  spawnCount: number;
  verdicts: Record<string, boolean | string>;
}

// ---------------------------------------------------------------------------
// Per-path run
// ---------------------------------------------------------------------------

async function runPath(path: PathDef): Promise<PathReport> {
  console.error(`\n=== path ${path.id} ===`);
  const rig = await createRig();
  const report: PathReport = {
    pathId: path.id,
    canonicalModel: "",
    conformance: [],
    cold: [],
    warm: [],
    spawnCount: 0,
    verdicts: {},
  };
  const step = (name: string, detail?: string) => {
    report.conformance.push({ step: name, ok: true, detail });
    console.error(`  [ok] ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    const installation = rig.installations
      .list()
      .find((dto: InstallationDto) => dto.driverId === path.driverId && dto.state === "trusted");
    if (!installation) throw new Error(`no trusted installation for ${path.driverId}`);
    const record: InstallationRecord = rig.installations.assertExecutable(
      installation.installationId,
    );
    step("installation trusted", installation.installationId);

    // --- canonical model probe on a scratch driver -------------------------
    const probeId = `probe-${path.id}`;
    const probe = rig.makeDriver(path, probeId);
    const probeResult = await probe.prewarm({
      participantId: probeId,
      spec: specFor(path, installation.installationId, probeId, path.preferredModelId ?? "probe"),
      installation: record,
    });
    const canonical = resolveCanonical(path, probeResult);
    await probe.close();
    report.canonicalModel = canonical;
    step("canonical model probed", canonical);

    const participantId = `p-${path.id}`;
    const spawnsBeforeConformance = rig.spawnCount();

    // --- conformance: two turns on one session ------------------------------
    const conf = await createActiveScope(rig.host, `smoke-${path.id}-conf`, [
      specFor(path, installation.installationId, participantId, canonical),
    ]);
    step("scope created + activated", `prewarm ${conf.prewarmMs}ms`);

    const turn1 = await runTurn(
      rig.host,
      conf.scope,
      `smoke-${path.id}-conf-t1`,
      participantId,
      snapshot(
        participantId,
        [{ id: "m1", content: "conformance turn one" }],
        TURN1_INSTRUCTION,
        1,
      ),
    );
    const t1 = requireCompleted(turn1.events, "turn 1");
    if (t1.effectiveModel !== canonical) {
      throw new Error(`turn 1 effectiveModel ${t1.effectiveModel} != canonical ${canonical}`);
    }
    if (t1.verdict !== "match") throw new Error(`turn 1 verdict ${t1.verdict}`);
    step(
      "turn 1 completed",
      `effective=${t1.effectiveModel} verdict=${t1.verdict} out=${JSON.stringify(t1.output.slice(0, 24))}`,
    );

    const turn2 = await runTurn(
      rig.host,
      conf.scope,
      `smoke-${path.id}-conf-t2`,
      participantId,
      snapshot(
        participantId,
        [
          { id: "m1", content: "conformance turn one" },
          { id: "m2", content: t1.output.slice(0, 200) },
        ],
        TURN2_INSTRUCTION,
        2,
      ),
    );
    const t2 = requireCompleted(turn2.events, "turn 2");
    if (t2.effectiveModel !== canonical) {
      throw new Error(`turn 2 effectiveModel ${t2.effectiveModel} != canonical ${canonical}`);
    }
    const confSpawns = rig.spawnCount() - spawnsBeforeConformance;
    if (confSpawns !== 1) {
      throw new Error(`expected exactly 1 spawn for two turns, saw ${confSpawns}`);
    }
    step("turn 2 completed, session reused", `spawns=${confSpawns}`);

    // --- conformance: cancel + recovery -------------------------------------
    const cancelExec = `smoke-${path.id}-conf-cancel`;
    const cancelRun = runTurn(
      rig.host,
      conf.scope,
      cancelExec,
      participantId,
      snapshot(
        participantId,
        [
          { id: "m1", content: "conformance turn one" },
          { id: "m2", content: t1.output.slice(0, 200) },
          { id: "m3", content: t2.output.slice(0, 200) },
        ],
        CANCEL_INSTRUCTION,
        3,
      ),
    );
    // Cancel after the first delta (or 5s, whichever comes first).
    const firstDeltaSeen = (async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 100));
        const status = await api<{ state: string; lastSeq: number }>(
          rig.host,
          "GET",
          `/api/v1/scopes/${conf.scope.scopeId}/executions/${cancelExec}`,
        );
        if (status.lastSeq >= 2 || status.state !== "running") return;
      }
    })();
    await Promise.race([firstDeltaSeen, new Promise((r) => setTimeout(r, 5_000))]);
    await api(
      rig.host,
      "POST",
      `/api/v1/scopes/${conf.scope.scopeId}/executions/${cancelExec}/cancel`,
      {
        controllerId: conf.scope.controllerId,
        leaseEpoch: conf.scope.leaseEpoch,
      },
    );
    const cancelResult = await cancelRun;
    const cancelTerminal = cancelResult.events.at(-1);
    if (cancelTerminal?.type !== "interrupted" || cancelTerminal.reason !== "user_cancelled") {
      throw new Error(
        `cancel: expected interrupted(user_cancelled), got ${JSON.stringify(cancelTerminal)?.slice(0, 300)}`,
      );
    }
    step("cancel produced interrupted(user_cancelled)");

    const recovery = await runTurn(
      rig.host,
      conf.scope,
      `smoke-${path.id}-conf-recovery`,
      participantId,
      snapshot(
        participantId,
        [
          { id: "m1", content: "conformance turn one" },
          { id: "m2", content: t1.output.slice(0, 200) },
          { id: "m3", content: t2.output.slice(0, 200) },
        ],
        TURN1_INSTRUCTION,
        4,
      ),
    );
    requireCompleted(recovery.events, "recovery turn");
    step("recovery turn completed after cancel");

    await closeScope(rig.host, conf.scope);
    for (let i = 0; i < 50 && rig.liveDriverPids().length > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (rig.liveDriverPids().length > 0) {
      throw new Error(`driver processes still alive after close: ${rig.liveDriverPids()}`);
    }
    step("scope closed, drivers reaped");

    // --- A/B: cold samples (fresh scope each) -------------------------------
    for (let i = 0; i < COLD_SAMPLES; i += 1) {
      const cold = await createActiveScope(rig.host, `smoke-${path.id}-cold-${i}`, [
        specFor(path, installation.installationId, participantId, canonical),
      ]);
      const turn = await runTurn(
        rig.host,
        cold.scope,
        `smoke-${path.id}-cold-${i}-t1`,
        participantId,
        snapshot(participantId, [{ id: "m1", content: "cold sample" }], TURN1_INSTRUCTION, 1),
      );
      requireCompleted(turn.events, `cold sample ${i}`);
      report.cold.push({
        prewarmMs: cold.prewarmMs,
        firstDeltaMs: turn.dispatchToFirstDeltaMs,
        terminalMs: turn.dispatchToTerminalMs,
      });
      await closeScope(rig.host, cold.scope);
      console.error(
        `  cold[${i}] prewarm=${cold.prewarmMs}ms firstDelta=${turn.dispatchToFirstDeltaMs}ms terminal=${turn.dispatchToTerminalMs}ms`,
      );
    }

    // --- A/B: warm samples (repeat turns in one scope) ----------------------
    const warm = await createActiveScope(rig.host, `smoke-${path.id}-warm`, [
      specFor(path, installation.installationId, participantId, canonical),
    ]);
    const warmItems = [{ id: "m1", content: "warm session" }];
    const primer = await runTurn(
      rig.host,
      warm.scope,
      `smoke-${path.id}-warm-primer`,
      participantId,
      snapshot(participantId, warmItems, TURN1_INSTRUCTION, 1),
    );
    requireCompleted(primer.events, "warm primer");
    for (let i = 0; i < WARM_SAMPLES; i += 1) {
      warmItems.push({ id: `w${i}`, content: `warm turn ${i}` });
      const turn = await runTurn(
        rig.host,
        warm.scope,
        `smoke-${path.id}-warm-${i}`,
        participantId,
        snapshot(participantId, warmItems, WARM_INSTRUCTION, i + 2),
      );
      requireCompleted(turn.events, `warm sample ${i}`);
      report.warm.push({
        prepMs: turn.dispatchToStartedMs,
        firstDeltaMs: turn.dispatchToFirstDeltaMs,
        terminalMs: turn.dispatchToTerminalMs,
      });
      console.error(
        `  warm[${i}] prep=${turn.dispatchToStartedMs}ms firstDelta=${turn.dispatchToFirstDeltaMs}ms terminal=${turn.dispatchToTerminalMs}ms`,
      );
    }
    await closeScope(rig.host, warm.scope);

    // --- verdicts -------------------------------------------------------------
    const coldPrepMedian = median(report.cold.map((s) => s.prewarmMs));
    const warmPrepMedian = median(report.warm.map((s) => s.prepMs));
    const coldDeltaMedian = median(report.cold.map((s) => s.firstDeltaMs ?? s.terminalMs));
    const warmDeltaMedian = median(report.warm.map((s) => s.firstDeltaMs ?? s.terminalMs));
    const warmWithin10s = report.warm.filter(
      (s) => (s.firstDeltaMs ?? Number.POSITIVE_INFINITY) <= 10_000,
    ).length;
    const prepReductionOk =
      warmPrepMedian <= coldPrepMedian * 0.2 && coldPrepMedian - warmPrepMedian >= 500;
    const deltaOk = warmDeltaMedian <= coldDeltaMedian + 500;
    const warmCountOk = quick ? warmWithin10s >= 1 : warmWithin10s >= 4;
    report.verdicts = {
      coldPrepMedianMs: `${coldPrepMedian}`,
      warmPrepMedianMs: `${warmPrepMedian}`,
      prepReduction: prepReductionOk,
      coldFirstDeltaMedianMs: `${coldDeltaMedian}`,
      warmFirstDeltaMedianMs: `${warmDeltaMedian}`,
      warmFirstDeltaNotWorse: deltaOk,
      warmTurnsWithin10s: `${warmWithin10s}/${WARM_SAMPLES}`,
      warmCountOk,
    };
    report.spawnCount = rig.spawnCount();
    console.error(
      `  verdicts: prep ${coldPrepMedian}→${warmPrepMedian}ms (${prepReductionOk ? "ok" : "FAIL"}), firstDelta ${coldDeltaMedian}→${warmDeltaMedian}ms (${deltaOk ? "ok" : "FAIL"}), warm≤10s ${warmWithin10s}/${WARM_SAMPLES}`,
    );
    if (!prepReductionOk || !deltaOk || !warmCountOk) {
      throw new Error(`A/B thresholds failed for ${path.id}`);
    }
    return report;
  } finally {
    await rig.close();
  }
}

// ---------------------------------------------------------------------------
// Combined RSS check (Host + both drivers resident)
// ---------------------------------------------------------------------------

async function measureCombinedRss(): Promise<{ deltaBytes: number; detail: string }> {
  console.error("\n=== combined RSS (Host + cld + codex drivers) ===");
  const rig = await createRig();
  try {
    const baseline = await rssBytes([process.pid]);
    for (const path of [PATHS[0] as PathDef, PATHS[3] as PathDef]) {
      const installation = rig.installations
        .list()
        .find((dto: InstallationDto) => dto.driverId === path.driverId && dto.state === "trusted");
      if (!installation) throw new Error(`no trusted installation for ${path.driverId}`);
      const record = rig.installations.assertExecutable(installation.installationId);
      const probeId = `probe-rss-${path.id}`;
      const probe = rig.makeDriver(path, probeId);
      const probeResult = await probe.prewarm({
        participantId: probeId,
        spec: specFor(path, installation.installationId, probeId, path.preferredModelId ?? "probe"),
        installation: record,
      });
      const canonical = resolveCanonical(path, probeResult);
      await probe.close();
      const participantId = `p-rss-${path.id}`;
      await createActiveScope(rig.host, `smoke-rss-${path.id}`, [
        specFor(path, installation.installationId, participantId, canonical),
      ]);
    }
    await new Promise((r) => setTimeout(r, 1_000));
    const hostRss = await rssBytes([process.pid]);
    const driverRss = await rssBytes(rig.liveDriverPids());
    const deltaBytes = hostRss - baseline + driverRss;
    const detail = `host=${(hostRss / 2 ** 20).toFixed(0)}MiB (Δ${((hostRss - baseline) / 2 ** 20).toFixed(0)}MiB), drivers=${(driverRss / 2 ** 20).toFixed(0)}MiB across ${rig.liveDriverPids().length} processes`;
    console.error(`  ${detail} => combined Δ=${(deltaBytes / 2 ** 20).toFixed(0)}MiB`);
    return { deltaBytes, detail };
  } finally {
    await rig.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (rssOnly) {
    const measured = await measureCombinedRss();
    const rss = { ...measured, withinBudget: measured.deltaBytes <= 2 * 2 ** 30 };
    const summary = { generatedAt: new Date().toISOString(), quick, reports: [], rss };
    if (jsonOut) await writeFile(jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
    if (!rss.withinBudget) {
      console.error(`RSS budget exceeded: ${(measured.deltaBytes / 2 ** 20).toFixed(0)}MiB > 2GiB`);
      process.exit(1);
    }
    console.error("\nRSS GATE PASSED");
    return;
  }
  const selected = onlyPath ? PATHS.filter((p) => p.id === onlyPath) : PATHS;
  if (selected.length === 0) throw new Error(`unknown --path ${onlyPath}`);
  const reports: PathReport[] = [];
  for (const path of selected) {
    try {
      reports.push(await runPath(path));
    } catch (error) {
      console.error(`\nPATH ${path.id} FAILED: ${error instanceof Error ? error.message : error}`);
      const failed = {
        pathId: path.id,
        canonicalModel: "",
        conformance: [{ step: "run", ok: false, detail: String(error) }],
        cold: [],
        warm: [],
        spawnCount: 0,
        verdicts: { run: "failed" },
      } satisfies PathReport;
      reports.push(failed);
      const summary = { generatedAt: new Date().toISOString(), quick, reports, rss: null };
      if (jsonOut) await writeFile(jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
      process.exit(1);
    }
  }
  let rss: { deltaBytes: number; detail: string; withinBudget: boolean } | null = null;
  if (!onlyPath) {
    const measured = await measureCombinedRss();
    rss = { ...measured, withinBudget: measured.deltaBytes <= 2 * 2 ** 30 };
    if (!rss.withinBudget) {
      console.error(`RSS budget exceeded: ${(measured.deltaBytes / 2 ** 20).toFixed(0)}MiB > 2GiB`);
      if (jsonOut) {
        await writeFile(
          jsonOut,
          `${JSON.stringify({ generatedAt: new Date().toISOString(), quick, reports, rss }, null, 2)}\n`,
        );
      }
      process.exit(1);
    }
  }
  const summary = { generatedAt: new Date().toISOString(), quick, reports, rss };
  if (jsonOut) await writeFile(jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
  console.error("\nALL GATES PASSED");
}

void main();
