import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type FrozenIntegrateIdentity,
  SQUAD_BRIDGE_CONTRACT_VERSION,
  agentSeatEnv,
  assertSquadBridgeVersion,
  canRequestPublish,
  frozenIntegrateCommand,
  inheritRepairHistory,
  isTrustedSquadctlIntegrateReceipt,
} from "@shared/runtime/squad-bridge-contract";
import { type SquadBridgeProbe, discoverSquadBridge } from "@shared/runtime/squad-bridge-discovery";
import { mapSquadStatus } from "@shared/runtime/squad-journal-map";
import {
  type SquadPrProfile,
  buildFrozenPrProfile,
  deliveryAuthorityFromProfile,
  withCandidateSha,
} from "@shared/runtime/squad-pr-profile";
import { errors } from "../errors";
import { atomicWriteJson, readFileText } from "../store/atomic-write";
import { ensureHome } from "../store/paths";
import { type RunCommand, defaultRunCommand } from "./checkout-pr";
import { grokLeaderSocket, spawnEnvForDriver } from "./driver-commands";
import type {
  SquadBridge,
  SquadBridgeDelivery,
  SquadBridgePublishResult,
  SquadBridgeStartRequest,
  SquadBridgeStartResult,
  SquadBridgeStatus,
} from "./squad-bridge";
import { probeAndVerifySquadBridge } from "./squadctl-verify";

export type { SquadBridgeProbe };

const IDENTITY_FILE = "councilkit-bridge.json";
const PROMPT_FILE = "orchestrator-prompt.md";
const PROFILE_FILE = "councilkit-pr-profile.json";
const AUTHORITY_FILE = "delivery-authority.json";
const DEFAULT_MODEL = "grok-4.6";
const SESSION_WAIT_MS = 4_000;

export function probeSquadBridge(env: NodeJS.ProcessEnv = process.env): SquadBridgeProbe {
  return probeAndVerifySquadBridge(env);
}

export interface SpawnOrchestratorInput {
  executable: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  requestedSession: string;
}

export type SpawnOrchestrator = (input: SpawnOrchestratorInput) => {
  pid: number;
  child?: ChildProcess;
  stdoutBuf?: { text: string };
};

export interface SquadctlBridgeOptions {
  runCommand?: RunCommand;
  spawnOrchestrator?: SpawnOrchestrator;
  killProcess?: (pid: number, signal?: NodeJS.Signals) => void;
  env?: NodeJS.ProcessEnv;
  workspaceCwd?: string;
  home?: string;
  executable?: string;
  orchestratorExecutable?: string;
  skipCliVerify?: boolean;
}

interface BridgeIdentity {
  taskId: string;
  squadTaskId: string;
  taskDir: string;
  workspaceCwd: string;
  requestedRuntime: string;
  actualRuntime: string | null;
  model: string | null;
  requestedSession: string | null;
  nativeSession: string | null;
  orchestratorPid: number | null;
  writerPids: number[];
  skillVersion: string;
  skillDir: string | null;
  squadctlPath: string | null;
  packagePath: string | null;
  delivery: SquadBridgeDelivery | null;
  stopped: boolean;
}

export class SquadctlBridge implements SquadBridge {
  private readonly tasks = new Map<string, string>();
  private readonly children = new Map<string, ChildProcess>();

  constructor(private readonly options: SquadctlBridgeOptions = {}) {}

  start(request: SquadBridgeStartRequest): SquadBridgeStartResult {
    const probe = this.probe();
    const version = assertSquadBridgeVersion({
      requested: request.requestedVersion,
      actual: this.options.executable || probe.available ? SQUAD_BRIDGE_CONTRACT_VERSION : null,
    });
    if (!version.ok) return version;
    const taskId = `squad-task-${randomUUID()}`;
    const taskDir = join(this.home(), "squad-tasks", taskId);
    mkdirSync(taskDir, { recursive: true, mode: 0o700 });
    const history = inheritRepairHistory({
      packageFields: request.packageFields,
      bridgeAncestorDir: request.bridgeAncestorDir ?? taskDir,
      history: request.history ?? {
        kind: "squad-repair-history",
        version: 1,
        source_hash: "b".repeat(64),
        project: request.delivery?.repo ?? "unknown",
      },
    });
    if (!history.ok) return history;
    this.tasks.set(taskId, taskDir);
    return { ok: true, taskId, taskDir };
  }

  resume(request: { taskId: string }): SquadBridgeStatus {
    const identity = this.readIdentity(request.taskId);
    if (!identity) {
      return { taskId: request.taskId, event: mapSquadStatus(null, { stopped: true }) };
    }
    const probe = this.probe();
    if (identity.squadctlPath && probe.executable && identity.squadctlPath !== probe.executable) {
      throw errors.usage("squadctl path changed; refusing to resume a different bridge");
    }
    if (identity.skillVersion && probe.version && identity.skillVersion !== probe.version) {
      throw errors.usage("squadctl version changed; refusing to resume a different bridge");
    }
    if (identity.orchestratorPid && this.pidAlive(identity.orchestratorPid)) {
      throw errors.runFailed("refusing resume while the previous orchestrator writer is alive");
    }
    if (!identity.nativeSession) {
      throw errors.usage("no native session to resume; refusing a silent fresh session");
    }
    this.runSquadctlSync(["resume", "--task-dir", identity.taskDir, "--json"]);
    const next = { ...identity, stopped: false };
    this.writeIdentity(request.taskId, next);
    this.spawnChild(request.taskId, next);
    return this.status(request);
  }

  stop(request: { taskId: string }): { kind: "stopped" } {
    const identity = this.readIdentity(request.taskId);
    const pids = new Set<number>();
    const child = this.children.get(request.taskId);
    if (child?.pid) pids.add(child.pid);
    try {
      child?.kill("SIGKILL");
    } catch {
      // already gone
    }
    if (identity?.orchestratorPid) pids.add(identity.orchestratorPid);
    for (const pid of identity?.writerPids ?? []) pids.add(pid);
    for (const pid of pids) this.killTree(pid);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const alive = [...pids].filter((pid) => this.pidAlive(pid));
      if (alive.length === 0) break;
      for (const pid of alive) {
        try {
          (this.options.killProcess ?? process.kill)(pid, "SIGKILL");
        } catch {
          try {
            (this.options.killProcess ?? process.kill)(-pid, "SIGKILL");
          } catch {
            // gone
          }
        }
      }
      spawnSync("sleep", ["0.05"], { shell: false });
    }
    const still = [...pids].filter((pid) => {
      if (child && child.pid === pid && (child.killed || child.exitCode !== null)) return false;
      return this.pidAlive(pid);
    });
    if (still.length > 0) {
      throw errors.runFailed(`orchestrator writers still alive: ${still.join(",")}`);
    }
    if (identity) {
      const snapshot = this.runSquadctlSync(["status", "--task-dir", identity.taskDir, "--json"]);
      const epoch = readEpoch(parseJson(snapshot.stdout));
      if (epoch === null) {
        throw errors.runFailed("cannot pause squad task without a journal epoch");
      }
      const paused = this.runSquadctlSync([
        "pause",
        "--task-dir",
        identity.taskDir,
        "--expected-epoch",
        String(epoch),
        "--worktree",
        identity.workspaceCwd,
        "--json",
      ]);
      if (paused.exitCode !== 0) {
        throw errors.runFailed(`squadctl pause failed: ${paused.stderr || paused.stdout}`);
      }
      this.writeIdentity(request.taskId, {
        ...identity,
        stopped: true,
        orchestratorPid: null,
        writerPids: [],
      });
    }
    this.children.delete(request.taskId);
    return { kind: "stopped" };
  }

  status(request: { taskId: string }): SquadBridgeStatus {
    const identity = this.readIdentity(request.taskId);
    if (identity?.stopped) {
      return {
        taskId: request.taskId,
        event: mapSquadStatus(null, { stopped: true }),
      };
    }
    const taskDir = identity?.taskDir ?? this.tasks.get(request.taskId);
    if (!taskDir) {
      return { taskId: request.taskId, event: mapSquadStatus(null) };
    }
    const snapshot = this.runSquadctlSync(["status", "--task-dir", taskDir, "--json"]);
    return {
      taskId: request.taskId,
      event: mapSquadStatus(parseJson(snapshot.stdout), { stopped: identity?.stopped }),
    };
  }

  async requestPublish(request: {
    taskId: string;
    identity: FrozenIntegrateIdentity;
  }): Promise<SquadBridgePublishResult> {
    const snapshot = this.status(request);
    if (!canRequestPublish(snapshot.event)) {
      return { ok: false, code: "JOURNAL_GATES_INCOMPLETE" };
    }
    const cmd = frozenIntegrateCommand({
      verb: "push-remote",
      identity: request.identity,
    });
    if (!cmd.ok) return { ok: false, code: "UNTRUSTED_RECEIPT" };
    const stored = this.readIdentity(request.taskId);
    const taskDir = stored?.taskDir ?? this.tasks.get(request.taskId);
    if (!taskDir || !stored?.delivery) return { ok: false, code: "UNTRUSTED_RECEIPT" };
    const workspace = stored.workspaceCwd;
    const frozen = this.readFrozenProfile(taskDir);
    if (!frozen) return { ok: false, code: "UNTRUSTED_RECEIPT" };
    const profile = withCandidateSha(frozen, request.identity.candidateSha);
    const profilePath = this.writeProfile(taskDir, profile);
    const check = await this.runSquadctl([
      "integrate",
      "check-remote",
      "--task-dir",
      taskDir,
      "--repo-root",
      workspace,
      "--profile",
      profilePath,
      "--expected-old-sha",
      request.identity.expectedOldSha,
      "--candidate-sha",
      request.identity.candidateSha,
      "--json",
    ]);
    if (
      check.exitCode !== 0 ||
      !isTrustedSquadctlIntegrateReceipt(parseJson(check.stdout), request.identity, "check-remote")
    ) {
      return { ok: false, code: "UNTRUSTED_RECEIPT" };
    }
    const push = await this.runSquadctl([
      "integrate",
      "push-remote",
      "--task-dir",
      taskDir,
      "--repo-root",
      workspace,
      "--profile",
      profilePath,
      "--expected-old-sha",
      request.identity.expectedOldSha,
      "--candidate-sha",
      request.identity.candidateSha,
      "--json",
    ]);
    if (
      push.exitCode !== 0 ||
      !isTrustedSquadctlIntegrateReceipt(parseJson(push.stdout), request.identity, "push-remote")
    ) {
      return { ok: false, code: "UNTRUSTED_RECEIPT" };
    }
    return {
      ok: true,
      receipt: {
        action: "push-remote",
        passed: true,
        candidateSha: request.identity.candidateSha,
        expectedOldSha: request.identity.expectedOldSha,
        repo: request.identity.repo,
        ref: request.identity.sourceBranch,
      },
    };
  }

  async prepare(input: {
    taskId: string;
    baseSha: string;
    packagePath: string;
    delivery?: SquadBridgeDelivery;
  }): Promise<void> {
    const probe = this.probe();
    const exe = this.executable(probe);
    if (exe === null) {
      throw errors.usage(probe.reason ?? "squadctl not available");
    }
    const taskDir = this.tasks.get(input.taskId) ?? join(this.home(), "squad-tasks", input.taskId);
    const squadTaskId = makeSquadTaskId();
    const cwd = this.options.workspaceCwd ?? process.cwd();
    const delivery = input.delivery ?? null;
    const init = await this.runSquadctl(
      [
        "init",
        "--task-dir",
        taskDir,
        "--task-id",
        squadTaskId,
        "--base-sha",
        input.baseSha,
        "--planning",
        "simple",
        "--owner",
        "councilkit",
        "--repo",
        cwd,
        "--no-observe",
        "--allow-behind-origin",
        "--json",
      ],
      exe,
    );
    if (init.exitCode !== 0) {
      throw errors.runFailed(`squadctl init failed: ${init.stderr || init.stdout || "exit"}`);
    }
    const intake = await this.runSquadctl(
      ["intake", "--task-dir", taskDir, "--package", input.packagePath, "--json"],
      exe,
    );
    if (intake.exitCode !== 0) {
      throw errors.runFailed(`squadctl intake failed: ${intake.stderr || intake.stdout || "exit"}`);
    }
    if (delivery) {
      this.writeFrozenDelivery(taskDir, delivery, delivery.sourceSha);
    }
    const orch = this.orchestrator(probe);
    const requestedSession = randomUUID();
    const identity: BridgeIdentity = {
      taskId: input.taskId,
      squadTaskId,
      taskDir,
      workspaceCwd: cwd,
      requestedRuntime: orch.requestedRuntime,
      actualRuntime: orch.executable ? basename(orch.executable) : null,
      model: DEFAULT_MODEL,
      requestedSession,
      nativeSession: null,
      orchestratorPid: null,
      writerPids: [],
      skillVersion: probe.version ?? SQUAD_BRIDGE_CONTRACT_VERSION,
      skillDir: probe.skillDir,
      squadctlPath: exe,
      packagePath: input.packagePath,
      delivery,
      stopped: false,
    };
    this.writeIdentity(input.taskId, identity);
    await this.spawnForTask(input.taskId, identity);
  }

  writerPids(): number[] {
    const pids: number[] = [];
    for (const identity of this.allIdentities()) {
      for (const pid of [identity.orchestratorPid, ...identity.writerPids]) {
        if (pid && this.pidAlive(pid)) pids.push(pid);
      }
    }
    return pids;
  }

  private spawnChild(
    taskId: string,
    identity: BridgeIdentity,
  ): {
    pid: number;
    child?: ChildProcess;
    stdoutBuf?: { text: string };
  } {
    const probe = this.probe();
    const orchExe = this.orchestrator(probe).executable;
    if (!orchExe) throw errors.usage("independent Orchestrator executable missing");
    const promptPath = writeOrchestratorPrompt(identity, probe);
    const logPath = join(identity.taskDir, "orchestrator.log");
    const requested = identity.nativeSession ?? identity.requestedSession ?? randomUUID();
    const argv = grokOrchestratorArgv({
      executable: orchExe,
      workspace: identity.workspaceCwd,
      model: identity.model ?? DEFAULT_MODEL,
      promptPath,
      resumeSession: identity.nativeSession,
    });
    const baseEnv = this.options.env ?? process.env;
    const isolated = this.options.executable
      ? baseEnv
      : spawnEnvForDriver("grok-stream-json", identity.workspaceCwd, baseEnv);
    const env = {
      ...agentSeatEnv(isolated),
      GROK_SESSION_ID: requested,
    };
    const spawnImpl = this.options.spawnOrchestrator ?? defaultSpawnOrchestrator;
    const spawned = spawnImpl({
      executable: orchExe,
      argv,
      cwd: identity.workspaceCwd,
      env,
      logPath,
      requestedSession: requested,
    });
    if (spawned.child) this.children.set(taskId, spawned.child);
    this.writeIdentity(taskId, {
      ...identity,
      orchestratorPid: spawned.pid,
      writerPids: [spawned.pid],
      actualRuntime: basename(orchExe),
      requestedSession: identity.requestedSession ?? requested,
      stopped: false,
    });
    return spawned;
  }

  private async spawnForTask(taskId: string, identity: BridgeIdentity): Promise<void> {
    const spawned = this.spawnChild(taskId, identity);
    const frozen = identity.nativeSession;
    const observed = spawned.child
      ? await waitForSessionId(spawned.child, SESSION_WAIT_MS, spawned.stdoutBuf)
      : null;
    if (frozen && observed && observed !== frozen) {
      this.killTree(spawned.pid);
      throw errors.runFailed("native session_id did not match the frozen session");
    }
    const current = this.readIdentity(taskId) ?? identity;
    this.writeIdentity(taskId, {
      ...current,
      nativeSession: observed ?? frozen,
    });
  }

  private probe(): SquadBridgeProbe {
    const env = this.options.env ?? process.env;
    if (this.options.executable) {
      return {
        ...discoverSquadBridge(env),
        available: true,
        version: SQUAD_BRIDGE_CONTRACT_VERSION,
        reason: null,
        executable: this.options.executable,
        orchestrator: {
          requestedRuntime: "grokb",
          actualRuntime: null,
          model: DEFAULT_MODEL,
          nativeSession: null,
          executable: this.options.orchestratorExecutable ?? null,
        },
      };
    }
    if (this.options.skipCliVerify) return discoverSquadBridge(env);
    return probeAndVerifySquadBridge(env);
  }

  private executable(probe: SquadBridgeProbe): string | null {
    return this.options.executable ?? probe.executable;
  }

  private orchestrator(probe: SquadBridgeProbe): {
    requestedRuntime: string;
    executable: string | null;
  } {
    return {
      requestedRuntime: probe.orchestrator?.requestedRuntime ?? "grokb",
      executable: this.options.orchestratorExecutable ?? probe.orchestrator?.executable ?? null,
    };
  }

  private async runSquadctl(
    argv: string[],
    exe?: string | null,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const probe = this.probe();
    const executable = exe ?? this.executable(probe);
    if (!executable) {
      return { stdout: "", stderr: probe.reason ?? "squadctl missing", exitCode: 2 };
    }
    const run = this.options.runCommand ?? defaultRunCommand;
    return run({
      executable,
      argv,
      cwd: this.options.workspaceCwd ?? process.cwd(),
      env: this.options.env ?? process.env,
    });
  }

  private runSquadctlSync(argv: string[]): {
    stdout: string;
    stderr: string;
    exitCode: number | null;
  } {
    const executable = this.executable(this.probe());
    if (!executable) {
      return { stdout: "", stderr: "squadctl missing", exitCode: 2 };
    }
    const result = spawnSync(executable, argv, {
      cwd: this.options.workspaceCwd ?? process.cwd(),
      env: this.options.env ?? process.env,
      encoding: "utf8",
      timeout: 15_000,
      shell: false,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status,
    };
  }

  private writeFrozenDelivery(
    taskDir: string,
    delivery: SquadBridgeDelivery,
    sourceSha: string,
  ): SquadPrProfile {
    mkdirSync(taskDir, { recursive: true, mode: 0o700 });
    const profile = buildFrozenPrProfile({
      sourceBranch: delivery.sourceBranch,
      sourceSha,
      expectedOldSha: delivery.expectedOldSha,
      remote: delivery.remote,
      authorityRef: delivery.grantHash,
    });
    this.writeProfile(taskDir, profile);
    writeFileSync(
      join(taskDir, AUTHORITY_FILE),
      `${JSON.stringify(deliveryAuthorityFromProfile(profile), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return profile;
  }

  private writeProfile(taskDir: string, profile: SquadPrProfile): string {
    const path = join(taskDir, PROFILE_FILE);
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return path;
  }

  private readFrozenProfile(taskDir: string): SquadPrProfile | null {
    const text = readFileText(join(taskDir, PROFILE_FILE));
    if (text === null) return null;
    try {
      return JSON.parse(text) as SquadPrProfile;
    } catch {
      return null;
    }
  }

  private identityPath(taskId: string): string {
    const taskDir = this.tasks.get(taskId) ?? join(this.home(), "squad-tasks", taskId);
    return join(taskDir, IDENTITY_FILE);
  }

  private readIdentity(taskId: string): BridgeIdentity | null {
    const text = readFileText(this.identityPath(taskId));
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as BridgeIdentity;
      if (parsed && typeof parsed.taskId === "string") {
        this.tasks.set(taskId, parsed.taskDir);
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  private writeIdentity(taskId: string, identity: BridgeIdentity): void {
    this.tasks.set(taskId, identity.taskDir);
    atomicWriteJson(this.identityPath(taskId), identity);
  }

  private allIdentities(): BridgeIdentity[] {
    const found: BridgeIdentity[] = [];
    for (const taskId of this.tasks.keys()) {
      const row = this.readIdentity(taskId);
      if (row) found.push(row);
    }
    return found;
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private killTree(pid: number): void {
    const kill = this.options.killProcess ?? process.kill;
    try {
      kill(-pid, "SIGTERM");
    } catch {
      try {
        kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  private home(): string {
    return this.options.home ?? ensureHome();
  }
}

function grokOrchestratorArgv(input: {
  executable: string;
  workspace: string;
  model: string;
  promptPath: string;
  resumeSession: string | null;
}): string[] {
  const argv = [
    "--cwd",
    input.workspace,
    "-m",
    input.model,
    "--output-format",
    "streaming-messages-json",
    "--include-partial-messages",
    "--prompt-file",
    input.promptPath,
    "--leader-socket",
    grokLeaderSocket(input.workspace),
  ];
  if (!basename(input.executable).endsWith("grokb")) {
    argv.unshift("--always-approve");
  }
  if (input.resumeSession) {
    argv.unshift("--resume", input.resumeSession);
  }
  return argv;
}

function defaultSpawnOrchestrator(input: SpawnOrchestratorInput): {
  pid: number;
  child: ChildProcess;
  stdoutBuf: { text: string };
} {
  mkdirSync(dirname(input.logPath), { recursive: true });
  const out = createWriteStream(input.logPath, { flags: "a" });
  out.on("error", () => {
    // log path may disappear after tests tear down the temp home
  });
  const stdoutBuf = { text: "" };
  const child = spawn(input.executable, input.argv, {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf.text += chunk.toString("utf8");
    out.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    out.write(chunk);
  });
  if (!child.pid) throw errors.runFailed("orchestrator spawn produced no pid");
  return { pid: child.pid, child, stdoutBuf };
}

function waitForSessionId(
  child: ChildProcess,
  timeoutMs: number,
  stdoutBuf?: { text: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    const read = (): string => stdoutBuf?.text ?? "";
    const early = parseGrokSessionId(read());
    if (early) {
      resolve(early);
      return;
    }
    const finish = (value: string | null): void => {
      child.stdout?.off("data", onData);
      clearTimeout(timer);
      resolve(value);
    };
    const onData = (): void => {
      const found = parseGrokSessionId(read());
      if (found) finish(found);
    };
    const timer = setTimeout(() => finish(parseGrokSessionId(read())), timeoutMs);
    child.stdout?.on("data", onData);
    child.stdout?.resume();
  });
}

export function parseGrokSessionId(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.session_id === "string" && obj.session_id.length > 0) return obj.session_id;
      if (typeof obj.sessionId === "string" && obj.sessionId.length > 0) return obj.sessionId;
    } catch {
      // ignore non-json
    }
  }
  return null;
}

function writeOrchestratorPrompt(identity: BridgeIdentity, probe: SquadBridgeProbe): string {
  const path = join(identity.taskDir, PROMPT_FILE);
  const delivery = identity.delivery;
  const body = [
    "You are the independent Squad Orchestrator for a CouncilKit repair subtask.",
    "Use only the installed skill and squadctl control plane. Do not invent PASS receipts, journal events, or SHAs.",
    `skill-dir: ${identity.skillDir ?? probe.skillDir ?? ""}`,
    `squadctl: ${identity.squadctlPath ?? probe.executable ?? ""}`,
    `task-dir: ${identity.taskDir}`,
    `workspace: ${identity.workspaceCwd}`,
    `package: ${identity.packagePath ?? ""}`,
    `pr-profile: ${join(identity.taskDir, PROFILE_FILE)}`,
    `delivery-authority: ${join(identity.taskDir, AUTHORITY_FILE)}`,
    `requested runtime: ${identity.requestedRuntime}`,
    `actual runtime: ${identity.actualRuntime ?? "pending"}`,
    `model: ${identity.model ?? DEFAULT_MODEL}`,
    `native session: ${identity.nativeSession ?? "pending capture"}`,
    delivery
      ? `frozen grant ${delivery.grantHash} repo ${delivery.repo} source ${delivery.sourceBranch} sha ${delivery.sourceSha} remote ${delivery.remote}`
      : "frozen grant missing",
    "Roles: Orchestrator=this grok session; Builder continues this session after plan freeze; Reviewer and Verifier MUST be independent adapter runs.",
    "When freezing gate policy, include delivery_authority from delivery-authority.json unchanged.",
    "Do NOT run git push, squadctl integrate, or any remote update. CouncilKit will publish after you stop.",
    "Stop when candidate.status=completed, independent Review/Verify passed on the same SHA, and phase=integrating. Then wait; do not keep mutating.",
  ].join("\n");
  writeFileSync(path, `${body}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

function makeSquadTaskId(): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 4);
  return `${day}-repair-${suffix}`;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function readEpoch(view: unknown): number | null {
  if (view === null || typeof view !== "object" || Array.isArray(view)) return null;
  const epoch = (view as { epoch?: unknown }).epoch;
  return typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0 ? epoch : null;
}
