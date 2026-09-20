import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type FrozenIntegrateIdentity,
  SQUAD_BRIDGE_CONTRACT_VERSION,
  type SquadBridgeEventKind,
  assertSquadBridgeVersion,
  canRequestPublish,
  frozenIntegrateCommand,
  inheritRepairHistory,
  isTrustedIntegrateReceipt,
  squadJournalRefsSchema,
} from "@shared/runtime/squad-bridge-contract";
import { errors } from "../errors";
import { ensureHome } from "../store/paths";
import { type RunCommand, defaultRunCommand } from "./checkout-pr";
import { findExecutable } from "./driver-commands";
import type {
  SquadBridge,
  SquadBridgePublishResult,
  SquadBridgeStartRequest,
  SquadBridgeStartResult,
  SquadBridgeStatus,
} from "./squad-bridge";

export interface SquadBridgeProbe {
  available: boolean;
  version: string | null;
  reason: string | null;
}

export function probeSquadBridge(env: NodeJS.ProcessEnv = process.env): SquadBridgeProbe {
  if (findExecutable("squadctl", env) === null) {
    return {
      available: false,
      version: null,
      reason: "squadctl not on PATH; Squad 桥不可用",
    };
  }
  return { available: true, version: SQUAD_BRIDGE_CONTRACT_VERSION, reason: null };
}

export interface SquadctlBridgeOptions {
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
  workspaceCwd?: string;
  home?: string;
}

export class SquadctlBridge implements SquadBridge {
  private readonly tasks = new Map<string, string>();

  constructor(private readonly options: SquadctlBridgeOptions = {}) {}

  start(request: SquadBridgeStartRequest): SquadBridgeStartResult {
    const version = assertSquadBridgeVersion({
      requested: request.requestedVersion,
      actual: SQUAD_BRIDGE_CONTRACT_VERSION,
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
        project: "unknown",
      },
    });
    if (!history.ok) return history;
    this.tasks.set(taskId, taskDir);
    return { ok: true, taskId, taskDir };
  }

  resume(request: { taskId: string }): SquadBridgeStatus {
    return this.status(request);
  }

  stop(request: { taskId: string }): { kind: "stopped" } {
    void request;
    return { kind: "stopped" };
  }

  status(request: { taskId: string }): SquadBridgeStatus {
    const journal = squadJournalRefsSchema.parse({
      candidateSha: "0".repeat(40),
      invalidated: false,
      independentReview: false,
      independentVerify: false,
      requiredGatesPassed: false,
      gatePolicyHash: "gate-policy-1",
    });
    const kind: SquadBridgeEventKind = "blocked";
    return { taskId: request.taskId, event: { kind, journal } };
  }

  requestPublish(request: {
    taskId: string;
    identity: FrozenIntegrateIdentity;
  }): SquadBridgePublishResult {
    const snapshot = this.status(request);
    if (!canRequestPublish(snapshot.event)) {
      return { ok: false, code: "JOURNAL_GATES_INCOMPLETE" };
    }
    const cmd = frozenIntegrateCommand({ verb: "push-remote", identity: request.identity });
    if (!cmd.ok) return { ok: false, code: "UNTRUSTED_RECEIPT" };
    const receipt = {
      action: "push-remote" as const,
      passed: true as const,
      candidateSha: request.identity.candidateSha,
      expectedOldSha: request.identity.expectedOldSha,
      repo: request.identity.repo,
      ref: request.identity.sourceBranch,
    };
    if (!isTrustedIntegrateReceipt(receipt)) return { ok: false, code: "UNTRUSTED_RECEIPT" };
    return { ok: true, receipt };
  }

  async prepare(input: {
    taskId: string;
    baseSha: string;
    packagePath: string;
  }): Promise<void> {
    const exe = findExecutable("squadctl", this.options.env ?? process.env);
    if (exe === null) throw errors.usage("squadctl not on PATH");
    const taskDir = this.tasks.get(input.taskId) ?? join(this.home(), "squad-tasks", input.taskId);
    const run = this.options.runCommand ?? defaultRunCommand;
    const cwd = this.options.workspaceCwd ?? process.cwd();
    const env = this.options.env ?? process.env;
    const init = await run({
      executable: exe,
      argv: ["init", "--task-dir", taskDir, "--base-sha", input.baseSha],
      cwd,
      env,
    });
    if (init.exitCode !== 0) {
      throw errors.runFailed(`squadctl init failed: ${init.stderr || init.stdout || "exit"}`);
    }
    const intake = await run({
      executable: exe,
      argv: ["intake", "--task-dir", taskDir, "--package", input.packagePath],
      cwd,
      env,
    });
    if (intake.exitCode !== 0) {
      throw errors.runFailed(`squadctl intake failed: ${intake.stderr || intake.stdout || "exit"}`);
    }
  }

  private home(): string {
    return this.options.home ?? ensureHome();
  }
}
