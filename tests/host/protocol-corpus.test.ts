import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createClaudeStreamJsonDriver } from "@host/drivers/claude-stream-json";
import { createCodexAppServerDriver } from "@host/drivers/codex-app-server";
import type { DriverDeps, DriverEvent, ParticipantDriver } from "@host/drivers/types";
import type { InstallationRecord } from "@host/installations/registry";
import { createLogger } from "@host/logging";
import type {
  DriverProcess,
  DriverSpawnSpec,
  ProcessSupervisor,
} from "@host/process/process-supervisor";
import type { ParticipantSpec } from "@shared/runtime/schemas";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Protocol corpus replay: feeds real redacted captures
 * (tests/fixtures/protocol-corpus/) through the production driver parser and
 * asserts the normalized event stream. The driver's own outbound frames are
 * matched against the capture in order — request methods must arrive in the
 * recorded sequence; response frames must match id and payload exactly.
 */

const CORPUS_ROOT = fileURLToPath(new URL("../fixtures/protocol-corpus", import.meta.url));

interface CorpusFrame {
  dir: "in" | "out";
  msg: Record<string, unknown>;
}

function loadCorpus(name: string): CorpusFrame[] {
  return readFileSync(join(CORPUS_ROOT, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CorpusFrame);
}

const TIMEOUTS = {
  handshakeMs: 3_000,
  dispatchAckMs: 800,
  streamIdleMs: 2_000,
  turnMs: 10_000,
  interruptGraceMs: 600,
  shutdownGraceMs: 1_000,
};

class FakeDriverProcess implements DriverProcess {
  readonly pid = 41_000;
  readonly pgid = 41_000;
  readonly watchdogPid = 41_001;
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly events = new EventEmitter();
  readonly killed: string[] = [];
  stdinClosed = false;

  constructor(
    readonly participantId: string,
    onDriverLine: (line: string) => void,
  ) {
    let buffer = "";
    this.stdin = new Writable({
      write(chunk, _encoding, callback) {
        buffer += chunk.toString("utf8");
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim().length > 0) onDriverLine(line);
          index = buffer.indexOf("\n");
        }
        callback();
      },
    });
  }

  waitSupervised(_timeoutMs: number): Promise<void> {
    return Promise.resolve();
  }
  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.killed.push(signal);
  }
  closeStdin(): void {
    this.stdinClosed = true;
  }
  shutdown(_graceMs?: number): Promise<void> {
    this.events.emit("exit", { code: 0, signal: null });
    return Promise.resolve();
  }
  __testInjectControlLine(_line: string): void {
    throw new Error("not used in corpus tests");
  }
  simulateExit(code: number): void {
    this.stdout.end();
    this.events.emit("exit", { code, signal: null });
  }
}

/**
 * Sequential corpus replayer. On every driver frame: match the next recorded
 * outbound frame (method for requests, id+payload for responses), then feed
 * the recorded inbound frames — the response to the just-matched request
 * (rewritten to the driver's request id) plus notifications up to the next
 * outbound frame. Requests the capture never answered get a synthetic `{}`.
 */
class CorpusReplay {
  private pointer = 0;
  readonly matchedOutbounds: { expected: Record<string, unknown>; actual: unknown }[] = [];

  constructor(
    private readonly frames: CorpusFrame[],
    private readonly proc: FakeDriverProcess,
  ) {}

  get exhausted(): boolean {
    return this.pointer >= this.frames.length;
  }

  handleDriverLine(line: string): void {
    const actual = JSON.parse(line) as Record<string, unknown>;
    while (this.pointer < this.frames.length && this.frames[this.pointer]?.dir !== "out") {
      this.pointer += 1;
    }
    const expectedFrame = this.frames[this.pointer];
    if (!expectedFrame) {
      throw new Error(`driver sent frame past end of corpus: ${line.slice(0, 200)}`);
    }
    const expected = expectedFrame.msg;
    if (typeof expected.method === "string") {
      if (actual.method !== expected.method) {
        throw new Error(
          `outbound mismatch: expected method ${String(expected.method)}, got ${String(actual.method)}`,
        );
      }
    } else {
      if (String(actual.id) !== String(expected.id)) {
        throw new Error(
          `response id mismatch: expected ${String(expected.id)}, got ${String(actual.id)}`,
        );
      }
      expect(actual.result).toEqual(expected.result);
    }
    this.matchedOutbounds.push({ expected, actual });
    this.pointer += 1;
    this.feedInbound(expected.id, actual.id);
  }

  private feedInbound(corpusRequestId: unknown, driverRequestId: unknown): void {
    let answered = corpusRequestId === undefined;
    while (this.pointer < this.frames.length && this.frames[this.pointer]?.dir === "in") {
      const frame = this.frames[this.pointer] as CorpusFrame;
      const msg = structuredClone(frame.msg);
      const isResponse = Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error");
      if (
        corpusRequestId !== undefined &&
        isResponse &&
        String(msg.id) === String(corpusRequestId)
      ) {
        msg.id = driverRequestId;
        answered = true;
      }
      this.pointer += 1;
      this.proc.stdout.write(`${JSON.stringify(msg)}\n`);
    }
    if (!answered) {
      this.proc.stdout.write(`${JSON.stringify({ id: driverRequestId, result: {} })}\n`);
    }
  }
}

const FAKE_INSTALLATION: InstallationRecord = {
  installationId: "codex-abcdef123456",
  driverId: "codex-app-server",
  name: "codex",
  discoveredPath: "/fake/codex",
  realpath: "/fake/codex",
  fingerprint: "sha256:00",
  state: "trusted",
  components: [],
  detail: null,
};

function codexSpec(participantId: string): ParticipantSpec {
  return {
    participantId,
    profile: {
      driverId: "codex-app-server",
      installationId: FAKE_INSTALLATION.installationId,
      credentialMode: "installation-managed",
      options: {},
    },
    modelId: "gpt-5.6-sol",
  };
}

interface Harness {
  driver: ParticipantDriver;
  processes: FakeDriverProcess[];
  workRoot: string;
  events: DriverEvent[];
  replay(): CorpusReplay;
}

async function makeHarness(corpusName: string): Promise<Harness> {
  const workRoot = await mkdtemp(join(tmpdir(), "ck-corpus-test-"));
  const processes: FakeDriverProcess[] = [];
  let replay: CorpusReplay | null = null;
  let lineHandler: (line: string) => void = (line) => {
    throw new Error(`driver wrote before replay was bound: ${line.slice(0, 120)}`);
  };
  const supervisor = {
    events: new EventEmitter(),
    spawnDriver(spec: DriverSpawnSpec): Promise<DriverProcess> {
      const proc = new FakeDriverProcess(spec.participantId, (line) => lineHandler(line));
      processes.push(proc);
      const bound = new CorpusReplay(loadCorpus(corpusName), proc);
      replay = bound;
      lineHandler = (line) => bound.handleDriverLine(line);
      return Promise.resolve(proc);
    },
    liveCount: () => processes.length,
    reapedByWatchdogCount: () => 0,
    reapedAfterWatchdogDeath: () => 0,
    shutdownAll: () => Promise.resolve(),
  };
  const logger = createLogger({ sink: () => undefined });
  const deps: DriverDeps = {
    supervisor: supervisor as unknown as ProcessSupervisor,
    logger,
    timeouts: TIMEOUTS,
    workRoot,
  };
  const driver = createCodexAppServerDriver(deps)("p-corpus");
  const events: DriverEvent[] = [];
  return {
    driver,
    processes,
    workRoot,
    events,
    replay: () => {
      if (!replay) throw new Error("driver never spawned");
      return replay;
    },
  };
}

function prewarm(h: Harness) {
  return h.driver.prewarm({
    participantId: "p-corpus",
    spec: codexSpec("p-corpus"),
    installation: FAKE_INSTALLATION,
  });
}

function executeCollecting(h: Harness, executionId: string): Promise<void> {
  return h.driver.execute(
    { executionId, prompt: "Reply with exactly: OK", modelId: "gpt-5.6-sol", coldStart: true },
    (event) => {
      h.events.push(event);
    },
  );
}

function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = () => {
      if (predicate()) return resolvePromise();
      if (Date.now() - start > timeoutMs) return rejectPromise(new Error("waitFor timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop() as () => Promise<void>;
    await cleanup();
  }
});

describe("protocol corpus replay (codex app-server 0.144.5)", () => {
  it("normal turn: handshake, streaming, authoritative completion", async () => {
    const h = await makeHarness("codex/0.144.5-normal-turn.jsonl");
    cleanups.push(async () => {
      await h.driver.close().catch(() => undefined);
      await rm(h.workRoot, { recursive: true, force: true });
    });

    const result = await prewarm(h);
    expect(result.canonicalModelId).toBe("gpt-5.6-sol");
    expect(result.catalog).toContain("gpt-5.6-sol");
    expect(result.catalog.length).toBeGreaterThan(3);

    await executeCollecting(h, "exec-corpus-1");

    const types = h.events.map((event) => event.type);
    expect(types[0]).toBe("started");
    const deltas = h.events.filter((event) => event.type === "output.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const terminal = h.events.at(-1);
    expect(terminal?.type).toBe("completed");
    if (terminal?.type !== "completed") throw new Error("unreachable");
    expect(terminal.output).toBe("OK");
    expect(terminal.requestedModel).toBe("gpt-5.6-sol");
    expect(terminal.effectiveModel).toBe("gpt-5.6-sol");
    expect(terminal.modelVerdict).toBe("match");
    expect(terminal.dispatchState).toBe("accepted");
    expect(terminal.toolState).toBe("none");
    expect(terminal.usage).toEqual({ inputTokens: 19_856, outputTokens: 5 });
    const streamed = deltas
      .map((event) => (event.type === "output.delta" ? event.text : ""))
      .join("");
    expect(streamed).toBe("OK");
    expect(h.driver.contextWindowTokens()).toBe(258_400);
    expect(h.replay().exhausted).toBe(true);
    expect(h.driver.sessionEpoch).toBe(0);

    await h.driver.close();
    expect(h.driver.sessionEpoch).toBe(1);
  });

  it("crash mid-turn: EOF without terminal -> interrupted(driver_crash)", async () => {
    const h = await makeHarness("codex/derived-crash-mid-turn.jsonl");
    cleanups.push(async () => {
      await h.driver.close().catch(() => undefined);
      await rm(h.workRoot, { recursive: true, force: true });
    });
    await prewarm(h);

    const run = executeCollecting(h, "exec-corpus-crash");
    await waitFor(() => h.events.some((event) => event.type === "output.delta"));
    const proc = h.processes[0] as FakeDriverProcess;
    proc.simulateExit(3);
    await run;

    const terminal = h.events.at(-1);
    expect(terminal?.type).toBe("interrupted");
    if (terminal?.type !== "interrupted") throw new Error("unreachable");
    expect(terminal.reason).toBe("driver_crash");
    expect(terminal.dispatchState).toBe("accepted");
    expect(terminal.toolState).toBe("none");
    expect(h.driver.sessionEpoch).toBe(1);
  });

  it("interrupt: cancel after first delta -> interrupted(user_cancelled)", async () => {
    const h = await makeHarness("codex/derived-interrupted-turn.jsonl");
    cleanups.push(async () => {
      await h.driver.close().catch(() => undefined);
      await rm(h.workRoot, { recursive: true, force: true });
    });
    await prewarm(h);

    const run = executeCollecting(h, "exec-corpus-cancel");
    await waitFor(() => h.events.some((event) => event.type === "output.delta"));
    await h.driver.cancel("exec-corpus-cancel");
    await run;

    const terminal = h.events.at(-1);
    expect(terminal?.type).toBe("interrupted");
    if (terminal?.type !== "interrupted") throw new Error("unreachable");
    expect(terminal.reason).toBe("user_cancelled");
    const interruptOutbound = h
      .replay()
      .matchedOutbounds.find((entry) => entry.expected.method === "turn/interrupt");
    expect(interruptOutbound).toBeDefined();
    expect(h.replay().exhausted).toBe(true);
  });

  it("approval request: always answered denied, turn proceeds", async () => {
    const h = await makeHarness("codex/derived-approval-request.jsonl");
    cleanups.push(async () => {
      await h.driver.close().catch(() => undefined);
      await rm(h.workRoot, { recursive: true, force: true });
    });
    await prewarm(h);
    await executeCollecting(h, "exec-corpus-approval");

    const terminal = h.events.at(-1);
    expect(terminal?.type).toBe("completed");
    const denial = h
      .replay()
      .matchedOutbounds.find((entry) => String(entry.expected.id) === "srv-approval-1");
    expect(denial).toBeDefined();
    expect(denial?.expected.result).toEqual({ decision: "denied" });
    expect(h.replay().exhausted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cld (claude-stream-json) corpus replay
// ---------------------------------------------------------------------------

const FAKE_CLD_INSTALLATION: InstallationRecord = {
  installationId: "cld-abcdef123456",
  driverId: "claude-stream-json",
  name: "cld",
  discoveredPath: "/fake/cld",
  realpath: "/fake/cld",
  fingerprint: "sha256:00",
  state: "trusted",
  components: [{ role: "claude-binary", path: "/fake/claude", fingerprint: "sha256:00" }],
  detail: null,
};

function cldSpec(participantId: string): ParticipantSpec {
  return {
    participantId,
    profile: {
      driverId: "claude-stream-json",
      installationId: FAKE_CLD_INSTALLATION.installationId,
      credentialMode: "installation-managed",
      options: { route: "ant-glm5.2" },
    },
    modelId: "GLM-5.2[1m]",
  };
}

/**
 * cld variant of the sequential replayer. Driver outbound frames are
 * control_request (matched on request.subtype) and user messages (matched on
 * type; request ids and uuids are driver-generated, so the recorded inbound
 * control_response request_id and replay-echo uuid are rewritten to match).
 */
class CldCorpusReplay {
  private pointer = 0;
  readonly matchedOutbounds: { expected: Record<string, unknown>; actual: unknown }[] = [];

  constructor(
    private readonly frames: CorpusFrame[],
    private readonly proc: FakeDriverProcess,
  ) {}

  get exhausted(): boolean {
    return this.pointer >= this.frames.length;
  }

  handleDriverLine(line: string): void {
    const actual = JSON.parse(line) as Record<string, unknown>;
    while (this.pointer < this.frames.length && this.frames[this.pointer]?.dir !== "out") {
      this.pointer += 1;
    }
    const expectedFrame = this.frames[this.pointer];
    if (!expectedFrame) {
      throw new Error(`driver sent frame past end of corpus: ${line.slice(0, 200)}`);
    }
    const expected = expectedFrame.msg;
    if (actual.type === "control_request") {
      const actualSubtype = (actual.request as Record<string, unknown> | undefined)?.subtype;
      const expectedSubtype = (expected.request as Record<string, unknown> | undefined)?.subtype;
      if (expected.type !== "control_request" || actualSubtype !== expectedSubtype) {
        throw new Error(
          `outbound mismatch: expected control ${String(expectedSubtype)}, got ${String(actualSubtype)}`,
        );
      }
    } else if (actual.type === "user") {
      if (expected.type !== "user") {
        throw new Error(`outbound mismatch: expected ${String(expected.type)}, got user message`);
      }
    } else {
      throw new Error(`unexpected driver frame: ${line.slice(0, 200)}`);
    }
    this.matchedOutbounds.push({ expected, actual });
    this.pointer += 1;
    this.feedInbound(actual);
  }

  private feedInbound(actual: Record<string, unknown>): void {
    while (this.pointer < this.frames.length && this.frames[this.pointer]?.dir === "in") {
      const frame = this.frames[this.pointer] as CorpusFrame;
      const msg = structuredClone(frame.msg);
      if (msg.type === "control_response" && actual.type === "control_request") {
        (msg.response as Record<string, unknown>).request_id = actual.request_id;
      }
      // The replay echo of the driver's own user message must carry the
      // driver's uuid; the interrupt marker user frame keeps its recorded one.
      if (msg.type === "user" && actual.type === "user") {
        msg.uuid = actual.uuid;
      }
      this.pointer += 1;
      this.proc.stdout.write(`${JSON.stringify(msg)}\n`);
    }
  }
}

interface CldHarness {
  driver: ParticipantDriver;
  logger: ReturnType<typeof createLogger>;
  workRoot: string;
  events: DriverEvent[];
  replay(): CldCorpusReplay;
}

async function makeCldHarness(corpusName: string): Promise<CldHarness> {
  const workRoot = await mkdtemp(join(tmpdir(), "ck-corpus-cld-test-"));
  let replay: CldCorpusReplay | null = null;
  let lineHandler: (line: string) => void = (line) => {
    throw new Error(`driver wrote before replay was bound: ${line.slice(0, 120)}`);
  };
  const supervisor = {
    events: new EventEmitter(),
    spawnDriver(spec: DriverSpawnSpec): Promise<DriverProcess> {
      const proc = new FakeDriverProcess(spec.participantId, (line) => lineHandler(line));
      const bound = new CldCorpusReplay(loadCorpus(corpusName), proc);
      replay = bound;
      lineHandler = (line) => bound.handleDriverLine(line);
      return Promise.resolve(proc);
    },
    liveCount: () => 1,
    reapedByWatchdogCount: () => 0,
    reapedAfterWatchdogDeath: () => 0,
    shutdownAll: () => Promise.resolve(),
  };
  const logger = createLogger({ sink: () => undefined });
  const deps: DriverDeps = {
    supervisor: supervisor as unknown as ProcessSupervisor,
    logger,
    timeouts: TIMEOUTS,
    workRoot,
  };
  const driver = createClaudeStreamJsonDriver(deps)("p-corpus-cld");
  const events: DriverEvent[] = [];
  return {
    driver,
    logger,
    workRoot,
    events,
    replay: () => {
      if (!replay) throw new Error("driver never spawned");
      return replay;
    },
  };
}

describe("protocol corpus replay (cld ant-glm5.2 stream-json)", () => {
  it("handshake, completed turn with real usage, cancel mid-stream -> user_cancelled", async () => {
    const h = await makeCldHarness("cld/ant-glm5.2-session.jsonl");
    cleanups.push(async () => {
      await h.driver.close().catch(() => undefined);
      await rm(h.workRoot, { recursive: true, force: true });
    });

    const prewarmResult = await h.driver.prewarm({
      participantId: "p-corpus-cld",
      spec: cldSpec("p-corpus-cld"),
      installation: FAKE_CLD_INSTALLATION,
    });
    expect(prewarmResult.canonicalModelId).toBe("GLM-5.2[1m]");

    // Turn 1: the recorded full turn replays into a completed event.
    await h.driver.execute(
      {
        executionId: "exec-corpus-cld-1",
        prompt: "Reply with exactly: OK",
        modelId: "GLM-5.2[1m]",
        coldStart: true,
      },
      (event) => h.events.push(event),
    );
    const terminal1 = h.events.at(-1);
    expect(terminal1?.type).toBe("completed");
    if (terminal1?.type !== "completed") throw new Error("unreachable");
    expect(terminal1.output).toBe("OK");
    expect(terminal1.effectiveModel).toBe("GLM-5.2[1m]");
    expect(terminal1.modelVerdict).toBe("match");
    expect(terminal1.dispatchState).toBe("accepted");
    // Real cumulative usage was diffed down to this turn's increment.
    const usageEvent = h.events.find((event) => event.type === "usage");
    expect(usageEvent?.type).toBe("usage");
    if (usageEvent?.type !== "usage") throw new Error("unreachable");
    expect(usageEvent.usage.inputTokens).toBe(141);
    expect(usageEvent.usage.outputTokens).toBe(3);
    expect(usageEvent.usage.costUsd).toBeCloseTo(0.00078, 6);

    // Turn 2: cancel after the first real delta; the recorded interrupt
    // terminal (result subtype error_during_execution) is normalized.
    h.events.length = 0;
    const run = h.driver.execute(
      {
        executionId: "exec-corpus-cld-2",
        prompt: "Count from 1 to 300, one number per line, no other text.",
        modelId: "GLM-5.2[1m]",
        coldStart: false,
      },
      (event) => h.events.push(event),
    );
    await waitFor(() => h.events.some((event) => event.type === "output.delta"));
    await h.driver.cancel("exec-corpus-cld-2");
    await run;

    const terminal2 = h.events.at(-1);
    expect(terminal2?.type).toBe("interrupted");
    if (terminal2?.type !== "interrupted") throw new Error("unreachable");
    expect(terminal2.reason).toBe("user_cancelled");
    expect(terminal2.dispatchState).toBe("accepted");

    const interruptOutbound = h
      .replay()
      .matchedOutbounds.find(
        (entry) =>
          entry.expected.type === "control_request" &&
          (entry.expected.request as Record<string, unknown> | undefined)?.subtype === "interrupt",
      );
    expect(interruptOutbound).toBeDefined();
    expect(h.replay().exhausted).toBe(true);

    // Real command_lifecycle frames went to diagnostics, never the event stream.
    expect(h.logger.diagnostics().some((entry) => entry.kind === "claude.unknown_frame")).toBe(
      true,
    );

    await h.driver.close();
    expect(h.driver.sessionEpoch).toBe(1);
  });
});

describe("protocol corpus (cld handshakes)", () => {
  it("all three routes expose a resolvable default model", () => {
    const handshakes = JSON.parse(
      readFileSync(join(CORPUS_ROOT, "cld", "init-handshakes.json"), "utf8"),
    ) as Record<
      string,
      { response?: { response?: { models?: { value?: string; resolvedModel?: string }[] } } }
    >;
    expect(Object.keys(handshakes).sort()).toEqual(["ant-glm5.2", "deepseek", "moonshot"]);
    for (const [route, frame] of Object.entries(handshakes)) {
      const models = frame.response?.response?.models ?? [];
      const canonical = models.find((model) => model.value === "default")?.resolvedModel;
      expect(typeof canonical, `route ${route} must resolve a default model`).toBe("string");
      expect(canonical?.length).toBeGreaterThan(0);
    }
  });
});
