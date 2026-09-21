import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type FrozenIntegrateIdentity,
  SQUAD_BRIDGE_CONTRACT_VERSION,
  agentSeatEnv,
  assertSquadBridgeVersion,
  canRequestPublish,
  canonicalSha256,
  frozenIntegrateCommand,
  inheritRepairHistory,
  isTrustedSquadctlIntegrateReceipt,
} from "@shared/runtime/squad-bridge-contract";
import { type SquadBridgeProbe, discoverSquadBridge } from "@shared/runtime/squad-bridge-discovery";
import {
  type SquadHistoryEnvelope,
  assertHistoryOriginsOwned,
  historyEnvelopeHash,
  parseHistoryCapabilities,
  parseHistoryEnvelope,
  readVerifiedHistoryExport,
} from "@shared/runtime/squad-history-bridge";
import { mapSquadStatus } from "@shared/runtime/squad-journal-map";
import {
  type SquadPrProfile,
  buildFrozenPrProfile,
  deliveryAuthorityFromProfile,
  headsRef,
  withCandidateSha,
} from "@shared/runtime/squad-pr-profile";
import { errors } from "../errors";
import { atomicWriteJson, readFileText } from "../store/atomic-write";
import { ensureHome } from "../store/paths";
import { type RunCommand, defaultRunCommand } from "./checkout-pr";
import { GROK_SESSION_WAIT_MS, grokLeaderSocket, spawnEnvForDriver } from "./driver-commands";
import {
  type ProcessFingerprint,
  fingerprintPid,
  isProcessGroupLeader,
  listGroupPids,
  sameProcess,
  signalVerifiedGroup,
  waitForGroupIdle,
  waitForLeaderFingerprint,
} from "./process-identity";
import { assertFrozenRemoteUrls } from "./repair-workspace";
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

export { GROK_SESSION_WAIT_MS };

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
  /** Test-only native-session wait. Production uses GROK_SESSION_WAIT_MS. */
  sessionWaitMs?: number;
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
  executionStatus: "running" | "failed" | "stopped";
  failReason: string | null;
  process: ProcessFingerprint | null;
  processGroup: ProcessFingerprint[];
  observedExitCode: number | null;
  observedSignal: string | null;
  executionId: string | null;
  toolVersion: string | null;
}

interface OwnedChild {
  child: ChildProcess;
  executionId: string;
  fingerprint: ProcessFingerprint | null;
}

interface ExecutionGeneration {
  executionId: string;
  pid: number | null;
  fingerprint: ProcessFingerprint | null;
  child?: ChildProcess;
}

export class SquadctlBridge implements SquadBridge {
  private readonly tasks = new Map<string, string>();
  private readonly children = new Map<string, OwnedChild>();

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

  exportHistory(request: {
    taskId: string;
    allowedOrigins: Array<{ journalTaskId: string; taskDir: string }>;
    projectId: string;
    repairChainId: string;
  }): { envelope: SquadHistoryEnvelope; hash: string; historyPath: string } {
    const identity = this.readIdentity(request.taskId);
    if (!identity) throw errors.runFailed("cannot export history from an unknown squad task");
    if (this.writerStillLive(identity)) {
      throw errors.runFailed("refusing history export while the previous writer is alive");
    }
    this.stabilizeTask(identity);
    const exported = this.runSquadctlSync([
      "history",
      "export",
      "--task-dir",
      identity.taskDir,
      "--json",
    ]);
    if (exported.exitCode !== 0) {
      throw errors.runFailed(
        `squadctl history export failed: ${exported.stderr || exported.stdout}`,
      );
    }
    const envelope = parseHistoryEnvelope(parseJson(exported.stdout));
    if (!envelope) {
      throw errors.runFailed("squadctl history export did not return squad-history-bridge.v1");
    }
    const ownedRoot = join(this.home(), "squad-tasks");
    const owned = assertHistoryOriginsOwned(envelope, request.allowedOrigins, ownedRoot, {
      projectId: request.projectId,
      repairChainId: request.repairChainId,
    });
    if (!owned.ok) throw errors.runFailed(owned.reason);
    const envelopePath = join(identity.taskDir, "councilkit-history-envelope.json");
    writeFileSync(envelopePath, `${JSON.stringify(envelope)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    writeFileSync(
      join(identity.taskDir, "councilkit-history.json"),
      `${JSON.stringify(envelope.history)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    return { envelope, hash: historyEnvelopeHash(envelope), historyPath: envelopePath };
  }

  async resume(request: { taskId: string }): Promise<SquadBridgeStatus> {
    const identity = this.readIdentity(request.taskId);
    if (!identity) {
      return { taskId: request.taskId, event: mapSquadStatus(null, { stopped: true }) };
    }
    const probe = this.probe();
    if (identity.squadctlPath && probe.executable && identity.squadctlPath !== probe.executable) {
      throw errors.usage("squadctl path changed; refusing to resume a different bridge");
    }
    if (identity.toolVersion && probe.toolVersion && identity.toolVersion !== probe.toolVersion) {
      throw errors.usage("squadctl version changed; refusing to resume a different bridge");
    }
    if (this.writerStillLive(identity)) {
      throw errors.runFailed("refusing resume while the previous orchestrator writer is alive");
    }
    if (!identity.nativeSession) {
      return { taskId: request.taskId, event: mapSquadStatus(null, { stopped: true }) };
    }
    const resumed = this.runSquadctlSync(["resume", "--task-dir", identity.taskDir, "--json"]);
    if (resumed.exitCode !== 0 || !isOfficialSquadResumeReceipt(parseJson(resumed.stdout))) {
      throw errors.runFailed(
        `squadctl resume failed: ${resumed.stderr || resumed.stdout || `exit ${resumed.exitCode}`}`,
      );
    }
    await this.spawnForTask(request.taskId, {
      ...identity,
      stopped: false,
      executionStatus: "running",
      failReason: null,
      observedExitCode: null,
      observedSignal: null,
    });
    return this.status(request);
  }

  stop(request: { taskId: string }): { kind: "stopped" } {
    const identity = this.readIdentity(request.taskId);
    const owned = this.children.get(request.taskId);
    const child = owned?.child;
    const frozen =
      identity?.process ?? (child?.pid ? waitForLeaderFingerprint(child.pid, 200) : null);
    this.terminateWriters(frozen, identity ?? null, child);
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    if (frozen && sameProcess(frozen, fingerprintPid(frozen.pid))) {
      throw errors.runFailed(`orchestrator writer still alive: ${frozen.pid}`);
    }
    if (frozen && !fingerprintPid(frozen.pid)) {
      const leftovers = listGroupPids(frozen.pgid).filter((pid) => fingerprintPid(pid) !== null);
      if (leftovers.length > 0) {
        throw errors.runFailed(`orchestrator writers still alive: ${leftovers.join(",")}`);
      }
    }
    if (identity?.orchestratorPid) {
      const expected = identity.process ?? frozen;
      if (expected && sameProcess(expected, fingerprintPid(identity.orchestratorPid))) {
        throw errors.runFailed("orchestrator process is alive without a frozen process group");
      }
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
        executionStatus: "stopped",
        orchestratorPid: null,
        writerPids: [],
        process: null,
      });
    }
    this.releaseChild(request.taskId, identity?.executionId ?? owned?.executionId ?? null);
    return { kind: "stopped" };
  }

  status(request: { taskId: string }): SquadBridgeStatus {
    const identity = this.reconcileProcess(request.taskId);
    if (identity?.stopped || identity?.executionStatus === "stopped") {
      return {
        taskId: request.taskId,
        event: mapSquadStatus(null, { stopped: true }),
      };
    }
    if (identity?.executionStatus === "failed") {
      return {
        taskId: request.taskId,
        event: { kind: "failed", journal: mapSquadStatus(null).journal },
      };
    }
    const taskDir = identity?.taskDir ?? this.tasks.get(request.taskId);
    if (!taskDir) {
      return {
        taskId: request.taskId,
        event: { kind: "failed", journal: mapSquadStatus(null).journal },
      };
    }
    const snapshot = this.runSquadctlSync(["status", "--task-dir", taskDir, "--json"]);
    if (snapshot.exitCode !== 0) {
      return {
        taskId: request.taskId,
        event: { kind: "failed", journal: mapSquadStatus(null).journal },
      };
    }
    const event = mapSquadStatus(parseJson(snapshot.stdout), { stopped: identity?.stopped });
    if (
      identity &&
      !this.writerStillLive(identity) &&
      !canRequestPublish(event) &&
      event.kind === "running"
    ) {
      const failed = this.markObservedExit(
        request.taskId,
        identity.executionId
          ? {
              executionId: identity.executionId,
              pid: identity.orchestratorPid,
              fingerprint: identity.process,
            }
          : null,
        identity.observedExitCode,
        identity.observedSignal,
        "orchestrator exited before a publishable candidate",
      );
      if (failed?.executionStatus === "failed") {
        return {
          taskId: request.taskId,
          event: { kind: "failed", journal: event.journal },
        };
      }
    }
    return { taskId: request.taskId, event };
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
    const expectedFetch = stored.delivery.originUrl;
    const expectedPush = stored.delivery.pushUrl ?? stored.delivery.originUrl;
    if (expectedFetch && expectedPush) {
      try {
        await assertFrozenRemoteUrls(
          workspace,
          expectedFetch,
          expectedPush,
          this.options.runCommand ?? defaultRunCommand,
          this.options.env ?? process.env,
        );
      } catch {
        return { ok: false, code: "UNTRUSTED_RECEIPT" };
      }
    }
    const frozen = this.readFrozenProfile(taskDir);
    if (!frozen) return { ok: false, code: "UNTRUSTED_RECEIPT" };
    const profile = withCandidateSha(frozen, request.identity.candidateSha);
    const profilePath = this.writeProfile(taskDir, profile);
    const expected = {
      ...request.identity,
      remote: stored.delivery.remote,
      remoteRef: headsRef(request.identity.sourceBranch),
      profileHash: canonicalSha256(profile),
    };
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
      !isTrustedSquadctlIntegrateReceipt(parseJson(check.stdout), expected, "check-remote")
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
      !isTrustedSquadctlIntegrateReceipt(parseJson(push.stdout), expected, "push-remote")
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
    const existing = this.readIdentity(input.taskId);
    if (existing && this.writerStillLive(existing)) {
      throw errors.runFailed("refusing a second orchestrator while the previous writer is alive");
    }
    const cwd = this.options.workspaceCwd ?? process.cwd();
    const delivery = input.delivery ?? existing?.delivery ?? null;
    let squadTaskId = existing?.squadTaskId ?? null;
    if (this.taskInitialized(taskDir)) {
      squadTaskId = this.requireOfficialTaskId(taskDir);
      if (existing?.squadTaskId && existing.squadTaskId !== squadTaskId) {
        throw errors.runFailed("frozen squad identity does not match official task_id");
      }
      if (existing?.taskDir && existing.taskDir !== taskDir) {
        throw errors.runFailed("frozen squad task directory does not match");
      }
    } else {
      squadTaskId = existing?.squadTaskId ?? makeSquadTaskId();
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
      squadTaskId = this.requireOfficialTaskId(taskDir);
    }
    const identity = this.persistInitIdentity({
      taskId: input.taskId,
      squadTaskId,
      taskDir,
      cwd,
      delivery,
      packagePath: input.packagePath,
      probe,
      exe,
      existing,
    });
    if (!this.taskHasHistory(taskDir)) {
      const intakeArgv = this.intakeArgv(taskDir, input.packagePath, delivery);
      const intake = await this.runSquadctl(intakeArgv, exe);
      if (intake.exitCode !== 0) {
        throw errors.runFailed(
          `squadctl intake failed: ${intake.stderr || intake.stdout || "exit"}`,
        );
      }
      if (delivery && delivery.newRepairChain !== true && delivery.previousTaskId) {
        const completeness = intakeCompleteness(parseJson(intake.stdout));
        if (completeness !== "verified") {
          throw errors.runFailed(
            `subsequent intake historyCompleteness=${completeness ?? "missing"}; expected verified`,
          );
        }
      }
    }
    if (delivery) {
      this.writeFrozenDelivery(taskDir, delivery, delivery.sourceSha);
    }
    await this.spawnForTask(input.taskId, {
      ...identity,
      delivery: delivery ?? identity.delivery,
      packagePath: input.packagePath,
    });
  }

  writerPids(): number[] {
    const pids = new Set<number>();
    for (const identity of this.allIdentities()) {
      if (!this.writerStillLive(identity) || !identity.process) continue;
      pids.add(identity.process.pid);
      for (const fp of identity.processGroup ?? []) {
        if (sameProcess(fp, fingerprintPid(fp.pid))) pids.add(fp.pid);
      }
    }
    return [...pids];
  }

  private spawnChild(
    taskId: string,
    identity: BridgeIdentity,
  ): {
    pid: number;
    child?: ChildProcess;
    stdoutBuf?: { text: string };
    executionId: string;
    fingerprint: ProcessFingerprint | null;
  } {
    const probe = this.probe();
    const orchExe = this.orchestrator(probe).executable;
    if (!orchExe) throw errors.usage("independent Orchestrator executable missing");
    const promptPath = writeOrchestratorPrompt(identity, probe);
    const logPath = join(identity.taskDir, "orchestrator.log");
    const requested = identity.requestedSession ?? randomUUID();
    const argv = grokOrchestratorArgv({
      executable: orchExe,
      workspace: identity.workspaceCwd,
      model: identity.model ?? DEFAULT_MODEL,
      promptPath,
      resumeSession: identity.nativeSession,
      sessionId: identity.nativeSession ? null : requested,
    });
    const baseEnv = this.options.env ?? process.env;
    const isolated =
      this.options.executable || this.options.spawnOrchestrator
        ? baseEnv
        : spawnEnvForDriver("grok-stream-json", identity.workspaceCwd, baseEnv);
    const { GROK_SESSION_ID: _session, GROK_AGENT: _agent, ...env } = agentSeatEnv(isolated);
    const spawnImpl = this.options.spawnOrchestrator ?? defaultSpawnOrchestrator;
    const spawned = spawnImpl({
      executable: orchExe,
      argv,
      cwd: identity.workspaceCwd,
      env,
      logPath,
      requestedSession: requested,
    });
    const executionId = randomUUID();
    const fingerprint = spawned.pid ? waitForLeaderFingerprint(spawned.pid) : null;
    const processGroup = fingerprint
      ? uniqueFingerprints([
          fingerprint,
          ...listGroupPids(fingerprint.pgid).map((pid) => fingerprintPid(pid)),
        ])
      : [];
    const writerPids =
      processGroup.length > 0
        ? processGroup.map((row) => row.pid)
        : spawned.pid
          ? [spawned.pid]
          : [];
    this.writeIdentity(taskId, {
      ...identity,
      executionId,
      orchestratorPid: spawned.pid,
      writerPids,
      process: fingerprint,
      processGroup,
      observedExitCode: null,
      observedSignal: null,
      actualRuntime: basename(orchExe),
      requestedSession: identity.requestedSession ?? requested,
      stopped: false,
      executionStatus: "running",
      failReason: null,
    });
    if (spawned.child) {
      this.children.set(taskId, { child: spawned.child, executionId, fingerprint });
    }
    return { ...spawned, executionId, fingerprint };
  }

  private async spawnForTask(taskId: string, identity: BridgeIdentity): Promise<void> {
    const spawned = this.spawnChild(taskId, identity);
    const generation: ExecutionGeneration = {
      executionId: spawned.executionId,
      pid: spawned.pid,
      fingerprint: spawned.fingerprint,
      child: spawned.child,
    };
    if (spawned.child) this.attachLifecycle(taskId, spawned.child, generation);
    const expectedSession = identity.nativeSession ?? identity.requestedSession;
    const supervised = spawned.child
      ? await superviseOrchestrator(
          spawned.child,
          this.options.sessionWaitMs ?? GROK_SESSION_WAIT_MS,
          spawned.stdoutBuf,
        )
      : { ok: false as const, reason: "orchestrator produced no child process", exitCode: null };
    if (!this.isCurrentGeneration(taskId, generation)) return;
    if (!supervised.ok) {
      this.abortSpawn(taskId, spawned.pid, supervised.reason, generation);
      throw errors.runFailed(supervised.reason);
    }
    if (!expectedSession || supervised.sessionId !== expectedSession) {
      this.abortSpawn(
        taskId,
        spawned.pid,
        expectedSession
          ? "native session_id did not match the frozen session"
          : "orchestrator produced no native session_id",
        generation,
      );
      throw errors.runFailed(
        expectedSession
          ? "native session_id did not match the frozen session"
          : "orchestrator produced no native session_id",
      );
    }
    if (!this.isCurrentGeneration(taskId, generation)) return;
    const current = this.readIdentity(taskId) ?? identity;
    if (current.executionStatus === "failed" || current.stopped) {
      if (!current.nativeSession) {
        this.writeIdentity(taskId, { ...current, nativeSession: supervised.sessionId });
      }
      return;
    }
    this.writeIdentity(taskId, {
      ...current,
      nativeSession: supervised.sessionId,
      executionStatus: "running",
      failReason: null,
    });
  }

  private attachLifecycle(
    taskId: string,
    child: ChildProcess,
    generation: ExecutionGeneration,
  ): void {
    child.on("exit", (code, signal) => {
      this.noteOrchestratorExit(taskId, generation, code, signal, null);
    });
    child.on("error", (error) => {
      this.noteOrchestratorExit(taskId, generation, null, null, error);
    });
  }

  private noteOrchestratorExit(
    taskId: string,
    generation: ExecutionGeneration,
    code: number | null,
    signal: NodeJS.Signals | null,
    error: Error | null,
  ): void {
    if (!this.isCurrentGeneration(taskId, generation)) return;
    const identity = this.readIdentity(taskId);
    if (!identity || identity.stopped || identity.executionStatus === "failed") return;
    const reason =
      error?.message ??
      (signal ? `orchestrator received ${signal}` : `orchestrator exited (${code ?? "null"})`);
    const snapshot = this.runSquadctlSync(["status", "--task-dir", identity.taskDir, "--json"]);
    if (!this.isCurrentGeneration(taskId, generation)) return;
    const event = mapSquadStatus(parseJson(snapshot.stdout));
    if ((code === 0 || (code === null && !signal && !error)) && canRequestPublish(event)) {
      const latest = this.readIdentity(taskId);
      if (!latest || !this.isCurrentGeneration(taskId, generation)) return;
      this.writeIdentity(taskId, {
        ...latest,
        observedExitCode: code,
        observedSignal: signal,
        orchestratorPid: null,
        writerPids: [],
      });
      return;
    }
    this.markObservedExit(taskId, generation, code, signal, reason);
  }

  private markObservedExit(
    taskId: string,
    generation: ExecutionGeneration | null,
    code: number | null,
    signal: string | null,
    reason: string,
  ): BridgeIdentity | null {
    if (generation && !this.isCurrentGeneration(taskId, generation))
      return this.readIdentity(taskId);
    const identity = this.readIdentity(taskId);
    if (!identity) return null;
    if (identity.stopped) return identity;
    if (identity.executionStatus === "failed") return identity;
    if (generation && !this.isCurrentGeneration(taskId, generation)) return identity;
    return this.writeIdentity(taskId, {
      ...identity,
      executionStatus: "failed",
      failReason: reason,
      observedExitCode: code,
      observedSignal: signal,
      orchestratorPid: null,
      writerPids: [],
    });
  }

  private reconcileProcess(taskId: string): BridgeIdentity | null {
    const identity = this.readIdentity(taskId);
    if (!identity) return null;
    if (identity.stopped || identity.executionStatus === "failed") return identity;
    if (this.writerStillLive(identity)) return identity;
    const snapshot = this.runSquadctlSync(["status", "--task-dir", identity.taskDir, "--json"]);
    const event = mapSquadStatus(parseJson(snapshot.stdout));
    if (canRequestPublish(event)) {
      return this.writeIdentity(taskId, {
        ...identity,
        orchestratorPid: null,
        writerPids: [],
      });
    }
    const generation: ExecutionGeneration | null = identity.executionId
      ? {
          executionId: identity.executionId,
          pid: identity.orchestratorPid,
          fingerprint: identity.process,
        }
      : null;
    if (identity.nativeSession || identity.observedExitCode !== null || identity.observedSignal) {
      return this.markObservedExit(
        taskId,
        generation,
        identity.observedExitCode,
        identity.observedSignal,
        identity.failReason ?? "orchestrator exited before a publishable candidate",
      );
    }
    return this.markObservedExit(
      taskId,
      generation,
      identity.observedExitCode,
      identity.observedSignal,
      "orchestrator process is no longer the frozen writer",
    );
  }

  private abortSpawn(
    taskId: string,
    pid: number,
    reason: string,
    generation?: ExecutionGeneration,
  ): void {
    if (generation && !this.isCurrentGeneration(taskId, generation)) return;
    const identity = this.readIdentity(taskId);
    const fp = identity?.process ?? fingerprintPid(pid);
    if (fp && sameProcess(fp, fingerprintPid(fp.pid))) {
      signalVerifiedGroup(fp, "SIGKILL");
    } else if (!fp && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (generation && !this.isCurrentGeneration(taskId, generation)) return;
    const latest = this.readIdentity(taskId) ?? identity;
    this.writeIdentity(taskId, {
      ...(latest ?? {
        taskId,
        squadTaskId: taskId,
        taskDir: this.tasks.get(taskId) ?? "",
        workspaceCwd: this.options.workspaceCwd ?? process.cwd(),
        requestedRuntime: "grokb",
        actualRuntime: null,
        model: DEFAULT_MODEL,
        requestedSession: null,
        nativeSession: null,
        orchestratorPid: null,
        writerPids: [],
        skillVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
        toolVersion: null,
        skillDir: null,
        squadctlPath: null,
        packagePath: null,
        delivery: null,
        stopped: false,
        executionStatus: "failed",
        failReason: reason,
        process: null,
        processGroup: [],
        observedExitCode: null,
        observedSignal: null,
        executionId: generation?.executionId ?? null,
      }),
      executionStatus: "failed",
      failReason: reason,
      orchestratorPid: null,
      writerPids: [],
      process: null,
    });
    this.releaseChild(
      taskId,
      generation?.executionId ?? latest?.executionId ?? identity?.executionId ?? null,
    );
  }

  private terminateWriters(
    frozen: ProcessFingerprint | null,
    identity: BridgeIdentity | null,
    child: ChildProcess | undefined,
  ): void {
    const liveAtStart = frozen ? fingerprintPid(frozen.pid) : null;
    if (frozen && liveAtStart && !sameProcess(frozen, liveAtStart)) {
      throw errors.runFailed(
        `orchestrator process identity drifted (pid ${frozen.pid} reused); refusing to signal a foreign process group`,
      );
    }
    const verifiedMembers = (identity?.processGroup ?? []).filter((fp) =>
      sameProcess(fp, fingerprintPid(fp.pid)),
    );
    const signalVerifiedPids = (signal: NodeJS.Signals): void => {
      for (const fp of verifiedMembers) {
        try {
          process.kill(fp.pid, signal);
        } catch {
          // already gone
        }
      }
      if (child?.pid && frozen && sameProcess(frozen, fingerprintPid(child.pid))) {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };
    const leaderOurs = Boolean(
      frozen && liveAtStart && isProcessGroupLeader(frozen) && sameProcess(frozen, liveAtStart),
    );
    if (leaderOurs && frozen) {
      if (!signalVerifiedGroup(frozen, "SIGTERM")) {
        throw errors.runFailed("refusing to signal a process group that is not the frozen writer");
      }
      signalVerifiedPids("SIGTERM");
      if (!waitForGroupIdle(frozen.pgid, 1_200, frozen)) {
        const liveNow = fingerprintPid(frozen.pid);
        if (sameProcess(frozen, liveNow)) {
          signalVerifiedGroup(frozen, "SIGKILL");
        } else if (liveNow === null) {
          for (const pid of listGroupPids(frozen.pgid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // already gone
            }
          }
        }
        signalVerifiedPids("SIGKILL");
        waitForGroupIdle(frozen.pgid, 1_200, frozen);
      }
      return;
    }
    signalVerifiedPids("SIGTERM");
    const deadline = Date.now() + 1_200;
    while (Date.now() < deadline && verifiedMembers.some((fp) => fingerprintPid(fp.pid))) {
      spawnSync("/bin/sleep", ["0.05"], { shell: false, timeout: 200 });
    }
    if (verifiedMembers.some((fp) => fingerprintPid(fp.pid))) {
      signalVerifiedPids("SIGKILL");
      spawnSync("/bin/sleep", ["0.2"], { shell: false, timeout: 500 });
    }
  }

  private writerStillLive(identity: BridgeIdentity): boolean {
    const owned = this.children.get(identity.taskId);
    if (
      owned?.child &&
      owned.child.exitCode === null &&
      !owned.child.killed &&
      (!identity.executionId || owned.executionId === identity.executionId)
    ) {
      return true;
    }
    if (identity.process && sameProcess(identity.process, fingerprintPid(identity.process.pid))) {
      return true;
    }
    return (identity.processGroup ?? []).some((fp) => sameProcess(fp, fingerprintPid(fp.pid)));
  }

  private isCurrentGeneration(taskId: string, generation: ExecutionGeneration): boolean {
    const identity = this.readIdentity(taskId);
    if (!identity || identity.executionId !== generation.executionId) return false;
    if (
      generation.fingerprint &&
      identity.process &&
      !sameProcess(generation.fingerprint, identity.process)
    ) {
      return false;
    }
    const owned = this.children.get(taskId);
    if (owned && owned.executionId !== generation.executionId) return false;
    if (owned?.child && generation.child && owned.child !== generation.child) return false;
    return true;
  }

  private releaseChild(taskId: string, executionId: string | null): void {
    const owned = this.children.get(taskId);
    if (!owned) return;
    if (executionId && owned.executionId !== executionId) return;
    this.children.delete(taskId);
  }

  private persistInitIdentity(input: {
    taskId: string;
    squadTaskId: string;
    taskDir: string;
    cwd: string;
    delivery: SquadBridgeDelivery | null;
    packagePath: string;
    probe: SquadBridgeProbe;
    exe: string;
    existing: BridgeIdentity | null;
  }): BridgeIdentity {
    const previous = input.existing ?? this.readIdentity(input.taskId);
    const orch = this.orchestrator(input.probe);
    const launched = Boolean(previous?.nativeSession);
    return this.writeIdentity(input.taskId, {
      taskId: input.taskId,
      squadTaskId: input.squadTaskId,
      taskDir: input.taskDir,
      workspaceCwd: input.cwd,
      requestedRuntime: orch.requestedRuntime,
      actualRuntime:
        previous?.actualRuntime ?? (orch.executable ? basename(orch.executable) : null),
      model: previous?.model ?? DEFAULT_MODEL,
      requestedSession: previous?.requestedSession ?? randomUUID(),
      nativeSession: previous?.nativeSession ?? null,
      orchestratorPid: previous?.orchestratorPid ?? null,
      writerPids: previous?.writerPids ?? [],
      skillVersion: input.probe.version ?? SQUAD_BRIDGE_CONTRACT_VERSION,
      toolVersion: input.probe.toolVersion,
      skillDir: input.probe.skillDir,
      squadctlPath: input.exe,
      packagePath: input.packagePath,
      delivery: input.delivery ?? previous?.delivery ?? null,
      stopped: launched ? (previous?.stopped ?? false) : false,
      executionStatus: launched ? (previous?.executionStatus ?? "stopped") : "stopped",
      failReason: previous?.failReason ?? null,
      process: previous?.process ?? null,
      processGroup: previous?.processGroup ?? [],
      observedExitCode: previous?.observedExitCode ?? null,
      observedSignal: previous?.observedSignal ?? null,
      executionId: previous?.executionId ?? null,
    });
  }

  private requireOfficialTaskId(taskDir: string): string {
    const snapshot = this.runSquadctlSync(["status", "--task-dir", taskDir, "--json"]);
    if (snapshot.exitCode !== 0) {
      throw errors.runFailed(
        `initialized squad task has unreadable official status: ${snapshot.stderr || snapshot.stdout || "exit"}`,
      );
    }
    const raw = parseJson(snapshot.stdout);
    const taskId =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as { task_id?: unknown }).task_id
        : null;
    if (typeof taskId !== "string" || !SQUAD_TASK_ID_RE.test(taskId)) {
      throw errors.runFailed("initialized squad task has no official task_id");
    }
    return taskId;
  }

  private taskInitialized(taskDir: string): boolean {
    try {
      return existsSync(join(taskDir, "events.jsonl"));
    } catch {
      return false;
    }
  }

  private taskHasHistory(taskDir: string): boolean {
    return existsSync(join(taskDir, "repair-history.v1.json"));
  }

  private intakeArgv(
    taskDir: string,
    packagePath: string,
    delivery: SquadBridgeDelivery | null,
  ): string[] {
    const argv = ["intake", "--task-dir", taskDir, "--package", packagePath, "--json"];
    if (delivery?.newRepairChain === true) {
      if (!delivery.repo || !delivery.parentRunId) {
        throw errors.usage("new repair chain requires frozen project-id and repair-chain-id");
      }
      argv.splice(
        5,
        0,
        "--new-repair-chain",
        "--project-id",
        delivery.repo,
        "--repair-chain-id",
        delivery.parentRunId,
      );
      return argv;
    }
    if (delivery?.previousTaskId) {
      if (!delivery.repo || !delivery.parentRunId) {
        throw errors.usage("history intake requires frozen project-id and repair-chain-id");
      }
      const historyFile = delivery.historyExportPath;
      if (!historyFile) {
        throw errors.runFailed("subsequent squad task is missing a frozen history export");
      }
      const loaded = readVerifiedHistoryExport(historyFile, delivery.historyExportHash);
      if (!loaded.ok) {
        throw errors.runFailed(loaded.reason);
      }
      const envelope = loaded.envelope;
      const historyObjectPath = join(taskDir, "councilkit-history-import.json");
      writeFileSync(historyObjectPath, `${JSON.stringify(envelope.history)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      argv.push(
        "--history",
        historyObjectPath,
        "--project-id",
        delivery.repo,
        "--repair-chain-id",
        delivery.parentRunId,
      );
      const origins = envelope?.origins ?? [];
      if (origins.length === 0) {
        throw errors.runFailed("frozen history export has no origin mapping");
      }
      for (const origin of origins) {
        argv.push("--origin-task-dir", `${origin.task_id}=${origin.task_dir}`);
      }
    }
    return argv;
  }

  private stabilizeTask(identity: BridgeIdentity): void {
    if (identity.stopped) return;
    const snapshot = this.runSquadctlSync(["status", "--task-dir", identity.taskDir, "--json"]);
    const epoch = readEpoch(parseJson(snapshot.stdout));
    if (epoch === null) return;
    this.runSquadctlSync([
      "pause",
      "--task-dir",
      identity.taskDir,
      "--expected-epoch",
      String(epoch),
      "--worktree",
      identity.workspaceCwd,
      "--json",
    ]);
  }

  private readHistoryContract(executable: string, env: NodeJS.ProcessEnv): string | null {
    const result = spawnSync(executable, ["history", "capabilities", "--json"], {
      env,
      encoding: "utf8",
      timeout: 8_000,
      shell: false,
    });
    if (result.status !== 0) return null;
    const parsed = parseJson(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return parseHistoryCapabilities(parsed)?.contract ?? null;
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
        toolVersion: null,
        historyContract: this.readHistoryContract(this.options.executable, env),
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
        return {
          ...parsed,
          processGroup: parsed.processGroup ?? [],
          observedExitCode: parsed.observedExitCode ?? null,
          observedSignal: parsed.observedSignal ?? null,
          executionId: parsed.executionId ?? null,
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  private writeIdentity(taskId: string, identity: BridgeIdentity): BridgeIdentity {
    this.tasks.set(taskId, identity.taskDir);
    atomicWriteJson(this.identityPath(taskId), identity);
    return identity;
  }

  private allIdentities(): BridgeIdentity[] {
    const found: BridgeIdentity[] = [];
    for (const taskId of this.tasks.keys()) {
      const row = this.readIdentity(taskId);
      if (row) found.push(row);
    }
    return found;
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
  sessionId: string | null;
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
  } else if (input.sessionId) {
    argv.unshift("--session-id", input.sessionId);
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

export function superviseOrchestrator(
  child: ChildProcess,
  timeoutMs: number,
  stdoutBuf?: { text: string },
): Promise<
  { ok: true; sessionId: string } | { ok: false; reason: string; exitCode: number | null }
> {
  return new Promise((resolve) => {
    const read = (): string => stdoutBuf?.text ?? "";
    let settled = false;
    const timer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
    const finish = (
      value:
        | { ok: true; sessionId: string }
        | { ok: false; reason: string; exitCode: number | null },
    ): void => {
      if (settled) return;
      settled = true;
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (timer.id !== undefined) clearTimeout(timer.id);
      resolve(value);
    };
    const onData = (): void => {
      const found = parseGrokSessionId(read());
      if (found) finish({ ok: true, sessionId: found });
    };
    const onExit = (code: number | null): void => {
      const found = parseGrokSessionId(read());
      if (found) finish({ ok: true, sessionId: found });
      else
        finish({
          ok: false,
          reason: `orchestrator exited before native session (${code ?? "null"})`,
          exitCode: code,
        });
    };
    const onError = (error: Error): void => {
      finish({ ok: false, reason: error.message, exitCode: null });
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
    child.stdout?.resume();
    const early = parseGrokSessionId(read());
    if (early) {
      finish({ ok: true, sessionId: early });
      return;
    }
    if (child.exitCode !== null || child.signalCode) {
      finish({
        ok: false,
        reason: `orchestrator exited before native session (${child.exitCode ?? child.signalCode})`,
        exitCode: child.exitCode,
      });
      return;
    }
    timer.id = setTimeout(() => {
      const found = parseGrokSessionId(read());
      if (found) finish({ ok: true, sessionId: found });
      else
        finish({
          ok: false,
          reason: "orchestrator produced no native session_id",
          exitCode: child.exitCode,
        });
    }, timeoutMs);
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

const SQUAD_TASK_ID_RE = /^[0-9]{8}-[a-z0-9][a-z0-9-]{0,47}-[a-z0-9]{4}$/;

function makeSquadTaskId(): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 4);
  return `${day}-repair-${suffix}`;
}

function isOfficialSquadResumeReceipt(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const row = raw as Record<string, unknown>;
  if (row.resumed !== true) return false;
  if (typeof row.epoch !== "number" || !Number.isInteger(row.epoch) || row.epoch < 0) {
    return false;
  }
  if (typeof row.head_sha !== "string" || !/^[a-f0-9]{40}$/i.test(row.head_sha)) return false;
  if (typeof row.diff_hash !== "string" || !/^[a-f0-9]{64}$/i.test(row.diff_hash)) return false;
  return true;
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

function intakeCompleteness(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as { historyCompleteness?: unknown }).historyCompleteness;
  return typeof value === "string" ? value : null;
}

function uniqueFingerprints(rows: Array<ProcessFingerprint | null>): ProcessFingerprint[] {
  const seen = new Set<number>();
  const out: ProcessFingerprint[] = [];
  for (const row of rows) {
    if (!row || seen.has(row.pid)) continue;
    seen.add(row.pid);
    out.push(row);
  }
  return out;
}

function readEpoch(view: unknown): number | null {
  if (view === null || typeof view !== "object" || Array.isArray(view)) return null;
  const epoch = (view as { epoch?: unknown }).epoch;
  return typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0 ? epoch : null;
}
