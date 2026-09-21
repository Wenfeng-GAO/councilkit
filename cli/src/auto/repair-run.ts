import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LedgerFinding } from "@shared/runtime/cli-ledger";
import { readCliRun } from "@shared/runtime/cli-runs-index";
import {
  type AdjudicationProjection,
  assertionIdFor,
  gateAcceptanceView,
  ingestAdjudication,
} from "@shared/runtime/repair-adjudication";
import {
  V2_TRIAL_DEFAULTS,
  canOpenSourceFix,
  newRepairBudget,
  writeCutoffMs,
} from "@shared/runtime/repair-chain";
import {
  type GoalContract,
  type VerificationAsset,
  buildGoalContract,
  generateTaskCard,
  goalContractSchema,
  goalIdentityFingerprint,
} from "@shared/runtime/repair-contract";
import {
  canStartWriter,
  createExecutionIntent,
  markExecutionStarted,
} from "@shared/runtime/repair-execution";
import {
  type RepairGateResult,
  type RepairGateReview,
  evaluateRepairGate,
  extractAggregatorVerdict,
} from "@shared/runtime/repair-gate";
import { assertSquadPipelineIsolation } from "@shared/runtime/repair-isolation";
import { type RepairPackage, buildRepairPackage } from "@shared/runtime/repair-package";
import { isFrozenPolicyHash } from "@shared/runtime/repair-policy";
import {
  recordRootCauseFailure,
  recoveryActionFor,
  shouldEnterDiagnosis,
} from "@shared/runtime/repair-progress";
import { recoverPublishReceipt } from "@shared/runtime/repair-publish";
import { canExportRepairPackage } from "@shared/runtime/review-case";
import {
  type FrozenIntegrateIdentity,
  SQUAD_BRIDGE_CONTRACT_VERSION,
  canRequestPublish,
} from "@shared/runtime/squad-bridge-contract";
import {
  type AllowedHistoryOrigin,
  HISTORY_BRIDGE_UPGRADE_MESSAGE,
  SQUAD_HISTORY_BRIDGE_CONTRACT,
  assertHistoryOriginsOwned,
  historyEnvelopeHash,
  parseHistoryEnvelope,
  readVerifiedHistoryExport,
} from "@shared/runtime/squad-history-bridge";
import { ReviewExit, runReview } from "../commands/review";
import { EXIT, errors } from "../errors";
import type { OutputSink } from "../output";
import { atomicWriteFile, atomicWriteJson } from "../store/atomic-write";
import { resolvePaths } from "../store/paths";
import { type CheckedOutPr, defaultRunCommand, inspectPullRequest } from "./checkout-pr";
import { loadFindingGroups } from "./finding-groups";
import {
  codeTraceFromReview,
  codeTraceMethods,
  commandMethods,
  ensureCandidateSnapshot,
  extraProbeManifestVersion,
  hashTestAssetContents,
  persistVerificationAssets,
  receiptFromIsolatedLog,
  runCandidateCommand,
  verificationCacheKey,
  writeCommandLog,
} from "./repair-candidate-verify";
import {
  consumeLockedRetry,
  consumeLockedSourceFix,
  loadOrCreateChain,
  peekLockedRetry,
  readRepairChain,
} from "./repair-chain-store";
import {
  executionRecordPath,
  readExecutionRecord,
  spawnDeadlineSupervisor,
  writeExecutionRecord,
} from "./repair-deadline-supervisor";
import { ensureRepairHandoff } from "./repair-handoff";
import { acquireWriterLease, releaseWriterLease } from "./repair-lease";
import {
  type RepairCycle,
  type RepairState,
  appendRepairJournal,
  readRepairState,
  writeRepairLive,
  writeRepairState,
} from "./repair-persist";
import { runRepairPreflight, sourceNeedsSupplementReview } from "./repair-preflight";
import { type RepairProfile, loadRepairProfile, loadReusableRepairGrant } from "./repair-profile";
import { assembleProductionGate, isV2Protocol } from "./repair-protocol";
import {
  inspectCwdForRepair,
  materializeRepairWorkspace,
  readRemoteUrls,
  resolveRepairWorkspaceCwd,
  sourceRepoRealpath,
} from "./repair-workspace";
import type { SquadBridge, SquadBridgeDelivery } from "./squad-bridge";
import { type SquadBridgeProbe, SquadctlBridge, probeSquadBridge } from "./squadctl-bridge";

export interface RepairLoopOutcome {
  runId: string;
  sourceRunId: string;
  status: "completed" | "interrupted";
  businessResult: "approved" | "needs_attention" | "stopped";
  reasonCode: string | null;
  lastError: string | null;
  outerUsed: number;
  latestReviewId: string | null;
  exitCode: number;
}

export interface RepairLoopDeps {
  bridge?: SquadBridge;
  bridgeProbe?: () => SquadBridgeProbe;
  reviewImpl?: (
    argv: string[],
    out: OutputSink,
  ) => Promise<{ runId: string; incomplete?: boolean }>;
  inspectPr?: (prUrl: string) => Promise<CheckedOutPr>;
  isPidAlive?: (pid: number) => boolean;
  now?: () => string;
  nowMs?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  abortSignal?: AbortSignal;
  pollIntervalMs?: number;
  workspaceCwd?: string;
  pinShaReview?: boolean;
}

export async function defaultRepairReviewImpl(
  argv: string[],
  out: OutputSink,
): Promise<{ runId: string; incomplete?: boolean }> {
  let created = runIdFromArgv(argv);
  try {
    await runReview(argv, out, {
      onRunCreated: (id) => {
        created = id;
      },
    });
  } catch (error) {
    if (error instanceof ReviewExit) {
      if (!created) throw error;
      const run = readCliRun(created);
      return { runId: created, incomplete: run?.reviewEvidence?.complete !== true };
    }
    throw error;
  }
  if (!created) throw errors.runFailed("review did not assign a run id");
  const run = readCliRun(created);
  return { runId: created, incomplete: run?.reviewEvidence?.complete !== true };
}

export async function executeRepairLoop(input: {
  runId: string;
  runDir: string;
  sourceRunId: string;
  profileName: string;
  out: OutputSink;
  deps?: RepairLoopDeps;
}): Promise<RepairLoopOutcome> {
  const deps = input.deps ?? {};
  const now = deps.now ?? (() => new Date().toISOString());
  let state = readRepairState(input.runDir);
  if (state === null) {
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: "councilkit_incomplete",
      message: "repair state missing",
    });
  }
  const probe = (deps.bridgeProbe ?? probeSquadBridge)();
  if (!deps.bridge && !probe.available) {
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: "BRIDGE_VERSION_MISSING",
      message: probe.reason ?? "squad bridge is unavailable",
    });
  }
  if (!deps.bridge && probe.historyContract !== SQUAD_HISTORY_BRIDGE_CONTRACT) {
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: "HISTORY_INVALID",
      message: probe.reason ?? HISTORY_BRIDGE_UPGRADE_MESSAGE,
    });
  }
  const profile = loadRepairProfile(input.profileName);
  let workspaceCwd: string;
  try {
    workspaceCwd = resolveRepairWorkspaceCwd({
      explicit: deps.workspaceCwd,
      frozen: state.workspaceCwd,
      sourceRunId: input.sourceRunId,
      runId: input.runId,
    });
    const sourceRepo = sourceRepoRealpath(input.sourceRunId);
    const sourceSha = readCliRun(input.sourceRunId)?.reviewEvidence?.sha;
    if (sourceRepo && sourceSha && !deps.workspaceCwd) {
      const sourceUrls = await readRemoteUrls(sourceRepo, defaultRunCommand, process.env);
      const origin = state.frozenOriginUrl ?? sourceUrls?.fetchUrl;
      const push = state.frozenPushUrl ?? sourceUrls?.pushUrl ?? origin;
      const frozen = await materializeRepairWorkspace({
        dest: workspaceCwd,
        sourceRepo,
        sourceBranch: profile.sourceBranch,
        sourceSha,
        expectedOriginUrl: origin ?? undefined,
        expectedPushUrl: push ?? undefined,
        expectedRepo: profile.repo,
      });
      workspaceCwd = frozen.cwd;
      state = patchState(input.runDir, {
        ...state,
        frozenOriginUrl: frozen.fetchUrl,
        frozenPushUrl: frozen.pushUrl,
        workspaceCwd,
      });
    }
  } catch (error) {
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: "pr_drift",
      message: error instanceof Error ? error.message : "workspace rejected",
    });
  }
  const bridge =
    deps.bridge ??
    new SquadctlBridge({
      workspaceCwd,
      isolationMode: state.isolationMode ?? profile.isolationMode ?? null,
      home: resolvePaths().home,
    });
  const source = readCliRun(input.sourceRunId);
  const prUrl = source?.reviewEvidence?.prUrl ?? profile.prUrl;
  const inspectCwd = inspectCwdForRepair({ workspaceCwd, sourceRunId: input.sourceRunId });
  const inspect =
    deps.inspectPr ?? ((url: string) => inspectPullRequest(url, undefined, undefined, inspectCwd));
  let pr: CheckedOutPr;
  try {
    pr = await inspect(prUrl);
  } catch (error) {
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: "identity_mismatch",
      message: error instanceof Error ? error.message : "inspect failed",
    });
  }
  const grant = loadReusableRepairGrant({
    runDir: input.runDir,
    profile,
    grantId: state.grantId,
    grantHash: state.grantHash,
    now: now(),
    hasWritableCycle: Boolean(
      state.grantId || state.grantHash || state.cycles?.some((cycle) => Boolean(cycle.squadTaskId)),
    ),
  });
  const persistedPolicy = isFrozenPolicyHash(state.frozenPolicyHash)
    ? state.frozenPolicyHash
    : null;
  state = patchState(input.runDir, {
    ...state,
    prUrl,
    workspaceCwd,
    grantId: grant.grantId,
    grantHash: grant.grantHash,
    profileHash: profile.integrityHash,
    frozenBaseSha: state.frozenBaseSha ?? pr.baseSha ?? null,
    priorCompleteReviewId: state.priorCompleteReviewId ?? input.sourceRunId,
    protocolVersion: state.protocolVersion ?? profile.protocolVersion ?? "v1",
    isolationMode: state.isolationMode ?? profile.isolationMode ?? null,
    frozenPolicyHash: persistedPolicy,
  });
  if (isV2Protocol(state.protocolVersion)) {
    const isolationMode = state.isolationMode;
    if (isolationMode !== "strong" && isolationMode !== "collaborative") {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "isolation_required",
        message: "v2 repair requires an explicit isolation mode (strong or collaborative)",
      });
    }
    const isolation = assertSquadPipelineIsolation(isolationMode);
    if (!isolation.ok) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "isolation_unavailable",
        message: isolation.reason,
      });
    }
    const nowMs = (deps.nowMs ?? Date.now)();
    try {
      const sourceRun = readCliRun(input.sourceRunId);
      const originalRequest = sourceRun?.title?.trim();
      if (!originalRequest) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "councilkit_incomplete",
          message: "original request is missing; refusing to mint a placeholder goal identity",
        });
      }
      const loaded = loadOrCreateChain({
        repo: profile.repo,
        prUrl,
        goalFingerprint: goalIdentityFingerprint(originalRequest),
        parentRunId: input.runId,
        budget:
          state.budget ??
          newRepairBudget(
            {
              sourceFixMax: profile.sourceFixMax ?? V2_TRIAL_DEFAULTS.sourceFixMax,
              deadlineMs: profile.deadlineMs ?? V2_TRIAL_DEFAULTS.deadlineMs,
              diagnoseMs: profile.diagnoseMs ?? V2_TRIAL_DEFAULTS.diagnoseMs,
              startedAtMs: nowMs,
            },
            nowMs,
          ),
        nowMs,
      });
      const budget = loaded.chain.budget;
      const frozenPolicyHash = state.frozenPolicyHash;
      const reused = loadFrozenGoalContract(input.runDir, loaded.chain.parentRunIds);
      const missingEvidence: string[] = [];
      const contract =
        typeof frozenPolicyHash !== "string"
          ? null
          : persistGoalProjection({
              runDir: input.runDir,
              contract:
                reused ??
                buildGoalContract({
                  sourceRunId: input.sourceRunId,
                  originalRequest,
                  goal: originalRequest,
                  invariants: [],
                  allowedScope: uniqueScope(sourceRun?.findings ?? []),
                  acceptance: realAcceptanceMethods(sourceRun?.findings ?? [], missingEvidence),
                  chainId: loaded.chain.chainId,
                  frozenPolicyHash,
                }),
              candidateSha: state.candidateSha ?? null,
              missingEvidence,
              remainingBudget: `${budget.sourceFixMax - budget.sourceFixUsed} source-fix left`,
            });
      state = patchState(input.runDir, {
        ...state,
        chainId: loaded.chain.chainId,
        goalFingerprint: loaded.chain.goalFingerprint,
        budget,
        deadlineAtMs: state.deadlineAtMs ?? budget.startedAtMs + budget.deadlineMs,
        writeCutoffAtMs: state.writeCutoffAtMs ?? writeCutoffMs(budget),
        contractVersion: contract?.version ?? state.contractVersion ?? null,
        goalSummary: contract?.goal ?? originalRequest,
        remainingBudget: `${budget.sourceFixMax - budget.sourceFixUsed} source-fix left`,
      });
    } catch (error) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "councilkit_incomplete",
        message: error instanceof Error ? error.message : "failed to inherit repair chain",
      });
    }
  } else if (
    state.timeoutMs !== null &&
    (state.deadlineAtMs === null || state.deadlineAtMs === undefined)
  ) {
    const nowMs = (deps.nowMs ?? Date.now)();
    state = patchState(input.runDir, {
      ...state,
      deadlineAtMs: nowMs + state.timeoutMs,
    });
  }
  const published = Boolean(state.publishedSha);
  const preflight = runRepairPreflight({
    sourceRunId: state.packageSourceRunId ?? input.sourceRunId,
    profile,
    pr,
    bridgeVersion: probe.version ?? (deps.bridge ? SQUAD_BRIDGE_CONTRACT_VERSION : null),
    historyCount: state.historyCount ?? null,
    parentOuterUsed: state.outerUsed,
    workspaceCwd,
    expectedHeadSha: expectedRemoteSha(state, source?.reviewEvidence?.sha ?? ""),
    allowSupplement: !published,
  });
  if (!preflight.ok) {
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: preflight.reasonCode,
      message: preflight.message,
    });
  }
  let packageSourceId = state.packageSourceRunId ?? input.sourceRunId;
  if (preflight.needsSupplement) {
    const supplemented = await runSupplementReview({
      input,
      deps,
      state,
      prUrl,
      now,
    });
    if (supplemented.done) return supplemented.outcome;
    state = supplemented.state;
    packageSourceId = supplemented.packageSourceId;
  }
  const packageSource = readCliRun(packageSourceId);
  const openCount =
    packageSource?.findings.filter((row) => row.status !== "accepted").length ??
    preflight.openFindingIds.length;
  if (openCount === 0) {
    const gate = gateFromSource(
      packageSourceId,
      preflight.sourceSha,
      pr,
      profile.base,
      state.frozenPolicyHash,
      state.frozenBaseSha,
    );
    if (gate.passed) {
      return finish(input, {
        businessResult: "approved",
        reasonCode: null,
        message: "already clear",
        outerUsed: state.outerUsed,
      });
    }
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: gate.reasons[0]?.code ?? "coverage_incomplete",
      message: "zero open findings without a verifiable same-SHA squad gate",
    });
  }
  acquireWriterLease({
    repo: profile.repo,
    sourceBranch: profile.sourceBranch,
    holderKind: "repair",
    holderRunId: input.runId,
    pid: process.pid,
  });
  state = patchState(input.runDir, {
    ...state,
    packageSourceRunId: packageSourceId,
  });

  while (state.businessResult === null) {
    const last = state.cycles?.at(-1);
    const resumeSlot = last && last.phase !== "closed" && last.phase !== "gated";
    if (!resumeSlot && state.outerUsed >= state.outerMax) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "findings_open",
        message: "outer cycle budget exhausted",
        outerUsed: state.outerUsed,
      });
    }
    const cycleN = resumeSlot ? (last?.n ?? state.outerUsed) : state.outerUsed + 1;
    if (cycleN > state.outerMax) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "findings_open",
        message: "no 11th writable subtask",
        outerUsed: state.outerUsed,
      });
    }
    if (!resumeSlot) {
      if (isV2Protocol(state.protocolVersion) && state.budget) {
        const allowed = canOpenSourceFix(state.budget, (deps.nowMs ?? Date.now)());
        if (!allowed.ok) {
          return finish(input, {
            businessResult: "needs_attention",
            reasonCode: allowed.reason,
            message:
              allowed.reason === "write_cutoff"
                ? "write cutoff reached; remaining budget is reserved for final review"
                : allowed.reason === "deadline"
                  ? "chain deadline reached"
                  : "source-fix budget exhausted",
            outerUsed: state.outerUsed,
          });
        }
      }
      if (cycleN > 1 && bridge.prepare && !bridge.exportHistory) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "HISTORY_INVALID",
          message: HISTORY_BRIDGE_UPGRADE_MESSAGE,
          outerUsed: state.outerUsed,
        });
      }
      appendRepairJournal(input.runDir, { kind: "outer_cycle.intent", n: cycleN, at: now() });
      const cycles = [...(state.cycles ?? []), { n: cycleN, phase: "reserved" as const }];
      const executionId = executionIdFor(input.runId, cycleN);
      let v2Budget = state.budget;
      const chainId = state.chainId;
      if (isV2Protocol(state.protocolVersion) && chainId) {
        const consumed = consumeLockedSourceFix(chainId, (deps.nowMs ?? Date.now)());
        if (!consumed.ok) {
          return finish(input, {
            businessResult: "needs_attention",
            reasonCode: consumed.reason,
            message:
              consumed.reason === "write_cutoff"
                ? "write cutoff reached; remaining budget is reserved for final review"
                : consumed.reason === "deadline"
                  ? "chain deadline reached"
                  : consumed.reason === "source_fix_exhausted"
                    ? "source-fix budget exhausted"
                    : consumed.reason,
            outerUsed: state.outerUsed,
          });
        }
        v2Budget = consumed.budget;
        const execution = createExecutionIntent({
          executionId,
          kind: "source_fix",
          chainId,
          parentRunId: input.runId,
          inputSha: preflight.sourceSha,
          contractVersion: state.contractVersion ?? 1,
          deadlineAtMs: state.deadlineAtMs ?? Date.now() + V2_TRIAL_DEFAULTS.deadlineMs,
        });
        writeExecutionRecord(executionRecordPath(input.runDir, executionId), execution);
        spawnDeadlineSupervisor({
          cliBin: process.argv[1] ?? "councilkit",
          executionPath: executionRecordPath(input.runDir, executionId),
          logPath: join(input.runDir, "deadline-supervisor.log"),
        });
      }
      state = patchState(input.runDir, {
        ...state,
        casVersion: state.casVersion + 1,
        outerUsed: state.outerUsed + 1,
        cycles,
        budget: v2Budget,
        executions: [
          ...(state.executions ?? []),
          ...(executionId && isV2Protocol(state.protocolVersion)
            ? [
                createExecutionIntent({
                  executionId,
                  kind: "source_fix",
                  chainId: state.chainId ?? input.runId,
                  parentRunId: input.runId,
                  inputSha: preflight.sourceSha,
                  contractVersion: state.contractVersion ?? 1,
                  deadlineAtMs: state.deadlineAtMs ?? 0,
                }),
              ]
            : []),
        ],
        remainingBudget: v2Budget
          ? `${v2Budget.sourceFixMax - v2Budget.sourceFixUsed} source-fix left`
          : state.remainingBudget,
      });
    }
    const cycle = state.cycles?.find((row) => row.n === cycleN);
    let taskId = cycle?.squadTaskId ?? null;
    if (cycle?.phase === "reviewed" || cycle?.phase === "published") {
      taskId = cycle.squadTaskId ?? taskId;
    } else if (taskId) {
      writeRepairLive(input.runDir, { status: "running", phase: "repair-squad-repair" });
      input.out.progress(`repair outer ${cycleN}/${state.outerMax}`);
      let snapshot: ReturnType<SquadBridge["status"]>;
      try {
        snapshot = await Promise.resolve(bridge.resume({ taskId }));
        if (snapshot.event.kind === "stopped" && bridge.prepare) {
          if (cycleAlreadyLaunched(cycle)) {
            return finish(input, {
              businessResult: "needs_attention",
              reasonCode: "squad_failed",
              message:
                "official squad resume refused; frozen cycle already launched and cannot be re-prepared",
              outerUsed: state.outerUsed,
            });
          }
          const packageBody = loadRepairPackage(packageSourceId);
          let history: FrozenHistoryLaunch | null = null;
          if (cycleN > 1) {
            history = await resolveFrozenHistoryLaunch({
              runDir: input.runDir,
              runId: input.runId,
              state,
              cycle,
              previous: previousSquadTask(state, cycleN),
              profile,
              bridge,
              allowExport: false,
            });
            state = patchCycle(input.runDir, state, cycleN, {
              previousTaskId: history.previousTaskId,
              previousTaskDir: history.previousTaskDir,
              historyExportPath: history.historyExportPath,
              historyExportHash: history.historyExportHash,
            });
          }
          await bridge.prepare({
            taskId,
            baseSha: packageBody.source.sha,
            packagePath: ensureRepairHandoff({
              runId: input.runId,
              cycle: cycleN,
              body: packageBody,
            }).path,
            delivery: buildSquadDelivery({
              grantHash: grant.grantHash,
              profile,
              packageBody,
              state,
              preflightSha: preflight.sourceSha,
              runId: input.runId,
              cycleN,
              history,
            }),
          });
          snapshot = bridge.status({ taskId });
        }
      } catch (error) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "squad_failed",
          message: error instanceof Error ? error.message : "squad resume failed",
          outerUsed: state.outerUsed,
        });
      }
      if (bridge.writerPids) {
        const pids = bridge.writerPids();
        state = patchState(input.runDir, { ...state, writerPids: pids });
        bindExecutionPids(
          input.runDir,
          executionIdFor(input.runId, cycleN),
          pids,
          nowMsOrNow(deps),
        );
      }
      const boundResume = bindOfficialExpectedPolicy(bridge, taskId, input.runDir, state);
      if (!boundResume.ok) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "policy_unknown",
          message: boundResume.reason,
          outerUsed: state.outerUsed,
        });
      }
      state = bindOfficialPolicyState(input, state, boundResume.hash);
      snapshot = await waitForCandidate(bridge, taskId, snapshot, input.runDir, now, deps, state);
      const waited = terminalWaitOutcome(input, snapshot, state);
      if (waited) return waited;
      if (!isV2Protocol(state.protocolVersion)) {
        const publishedOutcome = await publishIfNeeded({
          input,
          deps,
          inspect,
          prUrl,
          profile,
          state,
          cycleN,
          taskId,
          snapshot,
          preflightSha: preflight.sourceSha,
          now,
          bridge,
        });
        if (publishedOutcome.done) return publishedOutcome.outcome;
        state = publishedOutcome.state;
      }
    } else {
      writeRepairLive(input.runDir, { status: "running", phase: "repair-squad-repair" });
      input.out.progress(`repair outer ${cycleN}/${state.outerMax}`);
      let packageBody: RepairPackage;
      try {
        packageBody = loadRepairPackage(packageSourceId);
      } catch (error) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "coverage_incomplete",
          message: error instanceof Error ? error.message : "repair package missing",
          outerUsed: state.outerUsed,
        });
      }
      const handoff = ensureRepairHandoff({
        runId: input.runId,
        cycle: cycleN,
        body: packageBody,
      });
      appendRepairJournal(input.runDir, {
        kind: "handoff",
        path: handoff.path,
        sha256: handoff.sha256,
        at: now(),
      });
      const previous = cycleN > 1 ? previousSquadTask(state, cycleN) : null;
      let history: FrozenHistoryLaunch | null = null;
      if (cycleN > 1 && bridge.exportHistory) {
        try {
          history = await resolveFrozenHistoryLaunch({
            runDir: input.runDir,
            runId: input.runId,
            state,
            cycle,
            previous,
            profile,
            bridge,
            allowExport: !(cycle?.historyExportPath && cycle.historyExportHash),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "frozen history export missing";
          return finish(input, {
            businessResult: "needs_attention",
            reasonCode: /writer is still alive/.test(message) ? "squad_failed" : "HISTORY_INVALID",
            message,
            outerUsed: state.outerUsed,
          });
        }
        state = patchCycle(input.runDir, state, cycleN, {
          previousTaskId: history.previousTaskId,
          previousTaskDir: history.previousTaskDir,
          historyExportPath: history.historyExportPath,
          historyExportHash: history.historyExportHash,
        });
      }
      const delivery = buildSquadDelivery({
        grantHash: grant.grantHash,
        profile,
        packageBody,
        state,
        preflightSha: preflight.sourceSha,
        runId: input.runId,
        cycleN,
        history,
      });
      const started = bridge.start({
        requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
        packageFields: {},
        handoffPath: handoff.path,
        baseSha: packageBody.source.sha,
        delivery,
        history: {
          kind: "squad-repair-history",
          version: 1,
          source_hash: handoff.sha256,
          project: profile.repo,
        },
        bridgeAncestorDir: startedTaskDir(state) ?? handoff.path,
      });
      if (!started.ok) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: started.code,
          message: started.code,
          outerUsed: state.outerUsed,
        });
      }
      taskId = started.taskId;
      state = patchCycle(input.runDir, state, cycleN, {
        phase: "active",
        squadTaskId: started.taskId,
        squadTaskDir: started.taskDir ?? null,
      });
      if (bridge.prepare) {
        try {
          await bridge.prepare({
            taskId: started.taskId,
            baseSha: packageBody.source.sha,
            packagePath: handoff.path,
            delivery,
          });
        } catch (error) {
          return finish(input, {
            businessResult: "needs_attention",
            reasonCode: "squad_failed",
            message: error instanceof Error ? error.message : "squad prepare failed",
            outerUsed: state.outerUsed,
          });
        }
      }
      if (bridge.writerPids) {
        const pids = bridge.writerPids();
        state = patchState(input.runDir, { ...state, writerPids: pids });
        bindExecutionPids(
          input.runDir,
          executionIdFor(input.runId, cycleN),
          pids,
          nowMsOrNow(deps),
        );
      }
      const boundStart = bindOfficialExpectedPolicy(bridge, started.taskId, input.runDir, state);
      if (!boundStart.ok) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "policy_unknown",
          message: boundStart.reason,
          outerUsed: state.outerUsed,
        });
      }
      state = bindOfficialPolicyState(input, state, boundStart.hash);
      let snapshot = bridge.status({ taskId: started.taskId });
      snapshot = await waitForCandidate(
        bridge,
        started.taskId,
        snapshot,
        input.runDir,
        now,
        deps,
        state,
      );
      const waited = terminalWaitOutcome(input, snapshot, state);
      if (waited) return waited;
      if (!isV2Protocol(state.protocolVersion)) {
        const publishedOutcome = await publishIfNeeded({
          input,
          deps,
          inspect,
          prUrl,
          profile,
          state,
          cycleN,
          taskId: started.taskId,
          snapshot,
          preflightSha: preflight.sourceSha,
          now,
          bridge,
        });
        if (publishedOutcome.done) return publishedOutcome.outcome;
        state = publishedOutcome.state;
      }
    }
    if (!taskId) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "squad_candidate_invalid",
        message: "squad task missing after resume",
        outerUsed: state.outerUsed,
      });
    }
    const candidateSnapshot = bridge.status({ taskId });
    const journalSha = candidateSnapshot.event.journal.candidateSha?.toLowerCase() ?? "";
    const usableJournalSha =
      /^[0-9a-f]{40}$/i.test(journalSha) && journalSha !== "0".repeat(40) ? journalSha : null;
    if (usableJournalSha && state.candidateSha !== usableJournalSha) {
      state = patchState(input.runDir, { ...state, candidateSha: usableJournalSha });
    }
    const identitySha = (
      usableJournalSha ??
      state.candidateSha ??
      state.publishedSha ??
      (isV2Protocol(state.protocolVersion) ? null : preflight.sourceSha)
    )?.toLowerCase();
    if (!identitySha || !/^[0-9a-f]{40}$/i.test(identitySha) || identitySha === "0".repeat(40)) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "coverage_incomplete",
        message: "candidate SHA is unknown; refusing to verify against the source checkout",
        outerUsed: state.outerUsed,
      });
    }
    const against = state.priorCompleteReviewId ?? input.sourceRunId;
    const existingChild =
      state.cycles?.find((row) => row.n === cycleN)?.childReviewId ??
      findCompleteChild(against, identitySha);
    let childId = existingChild;
    const cycleNow = state.cycles?.find((row) => row.n === cycleN);
    if (childId === null && cycleNow?.phase !== "reviewed") {
      writeRepairLive(input.runDir, { status: "running", phase: "repair-reviewing" });
      const review = deps.reviewImpl ?? defaultRepairReviewImpl;
      const childArgId = `ck-review-${randomUUID()}`;
      const argv = [prUrl, "--against", against, "--run-id", childArgId];
      if (isV2Protocol(state.protocolVersion) && workspaceCwd) {
        argv.push("--repo", workspaceCwd, "--pin-sha", identitySha);
      }
      const result = await review(argv, input.out);
      childId = result.runId;
      if (result.incomplete) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "councilkit_incomplete",
          message: "follow-up review incomplete",
          latestReviewId: childId,
          outerUsed: state.outerUsed,
        });
      }
    }
    if (childId === null) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "councilkit_incomplete",
        message: "follow-up review missing",
        outerUsed: state.outerUsed,
      });
    }
    const child = readCliRun(childId);
    if (child === null) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "councilkit_incomplete",
        message: "follow-up review missing",
        outerUsed: state.outerUsed,
      });
    }
    if (child.reviewEvidence?.complete) {
      state = patchState(input.runDir, {
        ...state,
        latestReviewId: childId,
        priorCompleteReviewId: childId,
      });
    } else {
      state = patchState(input.runDir, { ...state, latestReviewId: childId });
    }
    state = patchCycle(input.runDir, state, cycleN, { phase: "reviewed", childReviewId: childId });
    let remote: CheckedOutPr;
    try {
      remote = await inspect(prUrl);
    } catch (error) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "pr_drift",
        message: error instanceof Error ? error.message : "final inspect failed",
        latestReviewId: childId,
        outerUsed: state.outerUsed,
      });
    }
    const snapshot = bridge.status({ taskId });
    const reviewGate = toGateReview(child, identitySha);
    const findingGroups = loadFindingGroups({
      runDir: join(resolvePaths().runsRoot, childId),
      ledger: {
        runId: childId,
        sha: identitySha,
        findings: reviewGate.findings,
        againstRunId: child.reviewEvidence?.againstRunId ?? null,
      },
    });
    const projection = persistAdjudication(input.runDir, state.chainId, {
      sourceRunId: childId,
      candidateSha: identitySha,
      findings: reviewGate.findings,
      findingGroups,
    });
    const acceptance = gateAcceptanceView(projection);
    const contract = readGoalContractFile(join(input.runDir, "goal-contract.json"));
    const requiredForVerify = [
      ...commandMethods(contract).map((row) => row.assertionId),
      ...codeTraceMethods(contract).map((row) => row.assertionId),
    ];
    const commandAcceptance = commandMethods(contract);
    const verifyChainId = state.chainId;
    const materialized = await materializeIndependentVerification({
      runDir: input.runDir,
      contract,
      candidateSha: identitySha,
      workspaceCwd,
      deadlineAtMs: state.deadlineAtMs ?? null,
      nowMs: nowMsOrNow(deps),
      reserve:
        isV2Protocol(state.protocolVersion) && verifyChainId && commandAcceptance.length > 0
          ? () => {
              const allowed = peekLockedRetry(verifyChainId, "verify");
              if (!allowed.ok) return allowed;
              const verifiedBudget = consumeLockedRetry(verifyChainId, "verify");
              if (verifiedBudget.ok) {
                const current = readRepairState(input.runDir);
                if (current) {
                  state = patchState(input.runDir, { ...current, budget: verifiedBudget.budget });
                }
              }
              return verifiedBudget;
            }
          : undefined,
    });
    if (!materialized.ok) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: /deadline/.test(materialized.reason) ? "deadline" : "coverage_incomplete",
        message: materialized.reason,
        latestReviewId: childId,
        outerUsed: state.outerUsed,
      });
    }
    const verification = bindVerificationForGate({
      runDir: input.runDir,
      contract,
      candidateSha: identitySha,
      workspaceCwd: materialized.cwd ?? workspaceCwd,
      findings: reviewGate.findings,
    });
    if (requiredForVerify.length > 0 && verification.requiredAssertionIds.length === 0) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "coverage_incomplete",
        message: "required verification responsibilities are missing",
        latestReviewId: childId,
        outerUsed: state.outerUsed,
      });
    }
    const squadCandidate = {
      taskId,
      invalidated: snapshot.event.journal.invalidated,
      independentReview: snapshot.event.journal.independentReview,
      independentVerify: snapshot.event.journal.independentVerify,
      requiredGatesPassed: snapshot.event.journal.requiredGatesPassed,
      sha: snapshot.event.journal.candidateSha,
      gatePolicyHash: snapshot.event.journal.gatePolicyHash,
    };
    if (isV2Protocol(state.protocolVersion) && (state.publishLadder ?? "none") !== "published") {
      const localGate = evaluateRepairGate(
        assembleProductionGate({
          frozenPolicyHash: state.frozenPolicyHash,
          candidateSha: identitySha,
          publishedSha: null,
          remote,
          frozenBaseSha: state.frozenBaseSha,
          expectedBaseBranch: profile.base,
          source: { runId: input.sourceRunId, prUrl },
          squad: squadCandidate,
          review: reviewGate,
          checkedAt: now(),
          unpublished: true,
          acceptance,
          verificationAssets: verification.assets,
          requiredAssertionIds: verification.requiredAssertionIds,
        }),
      );
      if (!localGate.passed) {
        const gated = handleFailedGate({
          input,
          state,
          cycleN,
          childId,
          against,
          reviewGate,
          projection,
          gate: localGate,
          profile,
        });
        if (gated.done) return gated.outcome;
        state = gated.state;
        packageSourceId = childId;
        continue;
      }
      const publishedOutcome = await publishIfNeeded({
        input,
        deps,
        inspect,
        prUrl,
        profile,
        state,
        cycleN,
        taskId,
        snapshot,
        preflightSha: preflight.sourceSha,
        now,
        bridge,
      });
      if (publishedOutcome.done) return publishedOutcome.outcome;
      state = publishedOutcome.state;
      try {
        remote = await inspect(prUrl);
      } catch (error) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "pr_drift",
          message: error instanceof Error ? error.message : "post-publish inspect failed",
          latestReviewId: childId,
          outerUsed: state.outerUsed,
        });
      }
    }
    const adopted =
      recoverPublishReceipt({
        intendedSha: identitySha,
        receiptSha: state.publishedSha ?? "unknown",
        remoteHead: remote.headSha ?? "unknown",
        inFlight: (state.publishLadder ?? "none") === "intent",
      }).action === "record_verified";
    if (adopted && !state.publishedSha) {
      state = patchState(input.runDir, {
        ...state,
        adoptedExistingRemote: true,
        publishedSha: identitySha,
        lastRemoteHead: remote.headSha?.toLowerCase() ?? state.lastRemoteHead,
      });
    }
    const gate = evaluateRepairGate(
      assembleProductionGate({
        frozenPolicyHash: state.frozenPolicyHash,
        candidateSha: identitySha,
        publishedSha: state.publishedSha,
        remote,
        frozenBaseSha: state.frozenBaseSha,
        expectedBaseBranch: profile.base,
        source: { runId: input.sourceRunId, prUrl },
        squad: squadCandidate,
        review: reviewGate,
        checkedAt: now(),
        adoptedExistingRemote: state.adoptedExistingRemote === true || adopted,
        acceptance,
        verificationAssets: verification.assets,
        requiredAssertionIds: verification.requiredAssertionIds,
      }),
    );
    state = patchCycle(input.runDir, state, cycleN, { phase: "gated" });
    state = patchState(input.runDir, {
      ...state,
      acceptanceCoverage: `${acceptance.verifiedClosedIds.length}/${projection.items.length}`,
      remainingBudget: state.budget
        ? `${state.budget.sourceFixMax - state.budget.sourceFixUsed} source-fix left`
        : `${state.outerMax - state.outerUsed} outer left`,
      recoveryAction: gate.passed
        ? null
        : recoveryActionFor(gate.reasons[0]?.code ?? "findings_open"),
    });
    if (gate.passed) {
      releaseWriterQuietly(profile, input.runId);
      return finish(input, {
        businessResult: "approved",
        reasonCode: null,
        message: "approved",
        latestReviewId: childId,
        outerUsed: state.outerUsed,
      });
    }
    const gated = handleFailedGate({
      input,
      state,
      cycleN,
      childId,
      against,
      reviewGate,
      projection,
      gate,
      profile,
    });
    if (gated.done) return gated.outcome;
    state = gated.state;
    packageSourceId = childId;
  }
  return finish(input, {
    businessResult: state.businessResult ?? "needs_attention",
    reasonCode: state.reasonCode,
    message: state.lastError ?? state.reasonCode ?? "done",
    outerUsed: state.outerUsed,
    latestReviewId: state.latestReviewId ?? null,
  });
}

function handleFailedGate(input: {
  input: { runId: string; runDir: string; sourceRunId: string; out: OutputSink };
  state: RepairState;
  cycleN: number;
  childId: string;
  against: string;
  reviewGate: RepairGateReview;
  projection: AdjudicationProjection;
  gate: RepairGateResult;
  profile: RepairProfile;
}): { done: true; outcome: RepairLoopOutcome } | { done: false; state: RepairState } {
  const stillOpen = input.reviewGate.findings.filter((row) => row.status !== "accepted").length;
  if (isV2Protocol(input.state.protocolVersion)) {
    const openRoot = input.projection.items.find((item) => item.disposition === "still_open");
    let failures = input.state.rootCauseFailures ?? [];
    if (openRoot && input.gate.reasons.every((reason) => reason.code === "findings_open")) {
      failures = recordRootCauseFailure(
        failures,
        openRoot.rootCauseId,
        input.gate.reasons[0]?.evidence ?? "still open",
      );
    }
    const next = patchState(input.input.runDir, {
      ...input.state,
      rootCauseFailures: failures,
      recoveryAction: recoveryActionFor(
        openRoot && shouldEnterDiagnosis(failures, openRoot.rootCauseId)
          ? "same_root_cause"
          : (input.gate.reasons[0]?.code ?? "findings_open"),
      ),
    });
    if (openRoot && shouldEnterDiagnosis(failures, openRoot.rootCauseId)) {
      writeRepairLive(input.input.runDir, { status: "running", phase: "repair-diagnosing" });
      if (input.state.chainId) {
        const diagnosed = consumeLockedRetry(input.state.chainId, "diagnose");
        if (diagnosed.ok) {
          patchState(input.input.runDir, { ...next, budget: diagnosed.budget });
        }
      }
      return {
        done: true,
        outcome: finish(input.input, {
          businessResult: "needs_attention",
          reasonCode: "same_root_cause",
          message: "same root cause still open after two valid source-fix attempts",
          latestReviewId: input.childId,
          outerUsed: next.outerUsed,
        }),
      };
    }
    const canRetry =
      stillOpen > 0 &&
      input.gate.reasons.every((reason) => reason.code === "findings_open") &&
      (next.budget
        ? next.budget.sourceFixUsed < next.budget.sourceFixMax
        : next.outerUsed < next.outerMax);
    if (!canRetry) {
      return {
        done: true,
        outcome: finish(input.input, {
          businessResult: "needs_attention",
          reasonCode: input.gate.reasons[0]?.code ?? "findings_open",
          message: input.gate.reasons[0]?.evidence ?? "repair gate failed",
          latestReviewId: input.childId,
          outerUsed: next.outerUsed,
        }),
      };
    }
    const afterCycle = patchCycle(input.input.runDir, next, input.cycleN, { phase: "closed" });
    const closed = patchState(input.input.runDir, {
      ...afterCycle,
      publishLadder: "none",
      packageSourceRunId: input.childId,
    });
    return { done: false, state: closed };
  }
  const publishedFixes = (input.state.cycles ?? []).filter(
    (row) => row.phase !== "reserved",
  ).length;
  const child = readCliRun(input.childId);
  if (
    publishedFixes >= 2 &&
    stillOpen > 0 &&
    child !== null &&
    child.reviewEvidence?.againstRunId === input.against
  ) {
    writeRepairLive(input.input.runDir, { status: "running", phase: "repair-diagnosing" });
    return {
      done: true,
      outcome: finish(input.input, {
        businessResult: "needs_attention",
        reasonCode: "findings_open",
        message: "same against-id still open after two published fixes",
        latestReviewId: input.childId,
        outerUsed: input.state.outerUsed,
      }),
    };
  }
  const canRetry =
    stillOpen > 0 &&
    input.gate.reasons.every((reason) => reason.code === "findings_open") &&
    input.state.outerUsed < input.state.outerMax;
  if (!canRetry) {
    return {
      done: true,
      outcome: finish(input.input, {
        businessResult: "needs_attention",
        reasonCode: input.gate.reasons[0]?.code ?? "findings_open",
        message: input.gate.reasons[0]?.evidence ?? "repair gate failed",
        latestReviewId: input.childId,
        outerUsed: input.state.outerUsed,
      }),
    };
  }
  const afterCycle = patchCycle(input.input.runDir, input.state, input.cycleN, { phase: "closed" });
  const closed = patchState(input.input.runDir, {
    ...afterCycle,
    publishLadder: "none",
    packageSourceRunId: input.childId,
  });
  return { done: false, state: closed };
}

async function runSupplementReview(input: {
  input: { runId: string; runDir: string; sourceRunId: string; out: OutputSink };
  deps: RepairLoopDeps;
  state: RepairState;
  prUrl: string;
  now: () => string;
}): Promise<
  | { done: true; outcome: RepairLoopOutcome }
  | { done: false; state: RepairState; packageSourceId: string }
> {
  const existingId = input.state.supplementReviewId;
  if (existingId) {
    const existing = readCliRun(existingId);
    if (existing?.reviewEvidence?.complete && !sourceNeedsSupplementReview(existing)) {
      const next = patchState(input.input.runDir, {
        ...input.state,
        packageSourceRunId: existingId,
        priorCompleteReviewId: existingId,
        latestReviewId: existingId,
      });
      return { done: false, state: next, packageSourceId: existingId };
    }
  }
  writeRepairLive(input.input.runDir, { status: "running", phase: "repair-reviewing" });
  input.input.out.progress("repair supplement review");
  const review = input.deps.reviewImpl ?? defaultRepairReviewImpl;
  const childArgId = `ck-review-${randomUUID()}`;
  const argv = [
    input.prUrl,
    "--against",
    input.state.priorCompleteReviewId ?? input.input.sourceRunId,
    "--run-id",
    childArgId,
  ];
  const result = await review(argv, input.input.out);
  const child = readCliRun(result.runId);
  const next = patchState(input.input.runDir, {
    ...input.state,
    supplementReviewId: result.runId,
    latestReviewId: result.runId,
    packageSourceRunId: result.runId,
  });
  appendRepairJournal(input.input.runDir, {
    kind: "supplement_review",
    runId: result.runId,
    at: input.now(),
  });
  if (
    result.incomplete ||
    child === null ||
    sourceNeedsSupplementReview(child) ||
    !canExportRepairPackage(child)
  ) {
    return {
      done: true,
      outcome: finish(input.input, {
        businessResult: "needs_attention",
        reasonCode: "coverage_incomplete",
        message: "source review is incomplete; same-SHA supplement review did not complete",
        latestReviewId: result.runId,
        outerUsed: next.outerUsed,
      }),
    };
  }
  return {
    done: false,
    state: patchState(input.input.runDir, {
      ...next,
      priorCompleteReviewId: result.runId,
    }),
    packageSourceId: result.runId,
  };
}

async function waitForCandidate(
  bridge: SquadBridge,
  taskId: string,
  snapshot: ReturnType<SquadBridge["status"]>,
  runDir: string,
  now: () => string,
  deps: RepairLoopDeps,
  state: RepairState,
): Promise<ReturnType<SquadBridge["status"]>> {
  const sleep = deps.sleep ?? defaultSleep;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const startedAt = nowMs();
  const interval = deps.pollIntervalMs ?? 2_000;
  let current = snapshot;
  while (!deps.abortSignal?.aborted) {
    writeRepairLive(runDir, { status: "running", phase: "repair-squad-repair" });
    if (canRequestPublish(current.event)) return current;
    if (
      current.event.kind === "blocked" ||
      current.event.kind === "failed" ||
      current.event.kind === "stopped"
    ) {
      appendRepairJournal(runDir, {
        kind: "squad.event",
        event: current.event.kind,
        taskId,
        at: now(),
      });
      return current;
    }
    if (
      (state.deadlineAtMs !== null &&
        state.deadlineAtMs !== undefined &&
        nowMs() >= state.deadlineAtMs) ||
      (state.deadlineAtMs == null &&
        state.timeoutMs !== null &&
        nowMs() - startedAt >= state.timeoutMs)
    ) {
      appendRepairJournal(runDir, { kind: "squad.wait.timeout", taskId, at: now() });
      try {
        bridge.stop({ taskId });
      } catch {
        // persist timeout even if stop races
      }
      return {
        ...current,
        event: { ...current.event, kind: "blocked" },
      };
    }
    try {
      await sleep(interval, deps.abortSignal);
    } catch {
      break;
    }
    current = bridge.status({ taskId });
  }
  try {
    bridge.stop({ taskId });
  } catch {
    // already stopping
  }
  return bridge.status({ taskId });
}

function terminalWaitOutcome(
  input: { runId: string; runDir: string; sourceRunId: string; out: OutputSink },
  snapshot: ReturnType<SquadBridge["status"]>,
  state: RepairState,
): RepairLoopOutcome | null {
  if (canRequestPublish(snapshot.event)) return null;
  if (snapshot.event.kind === "stopped") {
    return finish(input, {
      businessResult: "stopped",
      reasonCode: "stopped",
      message: "squad task stopped",
      outerUsed: state.outerUsed,
    });
  }
  if (snapshot.event.kind === "failed") {
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: "squad_failed",
      message: "squad task failed",
      outerUsed: state.outerUsed,
    });
  }
  if (snapshot.event.kind === "blocked") {
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: "squad_blocked",
      message: "squad task blocked or timed out",
      outerUsed: state.outerUsed,
    });
  }
  return finish(input, {
    businessResult: "needs_attention",
    reasonCode: "squad_candidate_invalid",
    message: "squad journal gates incomplete",
    outerUsed: state.outerUsed,
  });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
}

async function publishIfNeeded(input: {
  input: { runId: string; runDir: string; sourceRunId: string; out: OutputSink };
  deps: RepairLoopDeps;
  inspect: (url: string) => Promise<CheckedOutPr>;
  prUrl: string;
  profile: RepairProfile;
  state: RepairState;
  cycleN: number;
  taskId: string;
  snapshot: ReturnType<SquadBridge["status"]>;
  preflightSha: string;
  now: () => string;
  bridge: SquadBridge;
}): Promise<{ done: true; outcome: RepairLoopOutcome } | { done: false; state: RepairState }> {
  const identity: FrozenIntegrateIdentity = {
    repo: input.profile.repo,
    sourceBranch: input.profile.sourceBranch,
    expectedOldSha: (input.state.publishedSha ?? input.preflightSha).toLowerCase(),
    candidateSha: input.snapshot.event.journal.candidateSha.toLowerCase(),
  };
  let state = input.state;
  if ((state.publishLadder ?? "none") === "published") {
    return { done: false, state };
  }
  writeRepairLive(input.input.runDir, { status: "running", phase: "repair-publishing" });
  if (state.publishLadder !== "receipt" && state.publishLadder !== "head") {
    appendRepairJournal(input.input.runDir, {
      kind: "publish_intent",
      sha: identity.candidateSha,
      at: input.now(),
    });
    state = patchState(input.input.runDir, {
      ...state,
      publishLadder: "intent",
      candidateSha: identity.candidateSha,
    });
    const published = await input.bridge.requestPublish({
      taskId: input.taskId,
      identity,
    });
    if (!published.ok) {
      const detail = [published.stage, published.message].filter(Boolean).join(": ");
      return {
        done: true,
        outcome: finish(input.input, {
          businessResult: "needs_attention",
          reasonCode: published.code,
          message: detail ? `${published.code}: ${detail}` : published.code,
          outerUsed: state.outerUsed,
        }),
      };
    }
    state = patchState(input.input.runDir, { ...state, publishLadder: "receipt" });
  }
  const remote = await input.inspect(input.prUrl);
  const recovery = recoverPublishReceipt({
    intendedSha: identity.candidateSha,
    receiptSha:
      state.publishLadder === "receipt" ? identity.candidateSha : (state.publishedSha ?? "unknown"),
    remoteHead: remote.headSha ?? "unknown",
    inFlight: state.publishLadder === "intent",
  });
  if (recovery.action === "record_verified") {
    state = patchState(input.input.runDir, {
      ...state,
      publishLadder: "published",
      publishedSha: identity.candidateSha,
      lastRemoteHead: identity.candidateSha,
      adoptedExistingRemote: true,
    });
    state = patchCycle(input.input.runDir, state, input.cycleN, { phase: "published" });
    return { done: false, state };
  }
  if (recovery.action === "wait_in_flight") {
    return {
      done: true,
      outcome: finish(input.input, {
        businessResult: "needs_attention",
        reasonCode: "pr_drift",
        message: recovery.reason,
        outerUsed: state.outerUsed,
      }),
    };
  }
  if (recovery.action === "block_drift") {
    return {
      done: true,
      outcome: finish(input.input, {
        businessResult: "needs_attention",
        reasonCode: "pr_drift",
        message: recovery.reason,
        outerUsed: state.outerUsed,
      }),
    };
  }
  if (remote.headSha?.toLowerCase() !== identity.candidateSha) {
    return {
      done: true,
      outcome: finish(input.input, {
        businessResult: "needs_attention",
        reasonCode: "pr_drift",
        message: "remote HEAD did not match candidate",
        outerUsed: state.outerUsed,
      }),
    };
  }
  state = patchState(input.input.runDir, {
    ...state,
    publishLadder: "published",
    publishedSha: identity.candidateSha,
    lastRemoteHead: remote.headSha.toLowerCase(),
  });
  state = patchCycle(input.input.runDir, state, input.cycleN, { phase: "published" });
  return { done: false, state };
}

function finish(
  input: { runId: string; runDir: string; sourceRunId: string },
  result: {
    businessResult: RepairLoopOutcome["businessResult"];
    reasonCode: string | null;
    message: string;
    outerUsed?: number;
    latestReviewId?: string | null;
  },
): RepairLoopOutcome {
  const state = readRepairState(input.runDir);
  const outerUsed = result.outerUsed ?? state?.outerUsed ?? 0;
  if (state) {
    writeRepairState(input.runDir, {
      ...state,
      businessResult: result.businessResult,
      reasonCode: result.reasonCode,
      lastError: result.message,
      latestReviewId: result.latestReviewId ?? state.latestReviewId ?? null,
      recoveryAction: result.reasonCode
        ? recoveryActionFor(result.reasonCode)
        : state.recoveryAction,
    });
  }
  writeRepairLive(input.runDir, {
    status: result.businessResult === "stopped" ? "interrupted" : "completed",
    phase: "repair-finalizing",
  });
  const exitCode =
    result.businessResult === "approved"
      ? EXIT.ok
      : result.businessResult === "stopped"
        ? EXIT.interrupted
        : EXIT.runFailed;
  return {
    runId: input.runId,
    sourceRunId: input.sourceRunId,
    status: result.businessResult === "stopped" ? "interrupted" : "completed",
    businessResult: result.businessResult,
    reasonCode: result.reasonCode,
    lastError: result.message,
    outerUsed,
    latestReviewId: result.latestReviewId ?? state?.latestReviewId ?? null,
    exitCode,
  };
}

function patchState(runDir: string, state: RepairState): RepairState {
  writeRepairState(runDir, state);
  return state;
}

function patchCycle(
  runDir: string,
  state: RepairState,
  n: number,
  patch: Partial<NonNullable<RepairState["cycles"]>[number]>,
): RepairState {
  const cycles = [...(state.cycles ?? [])];
  const index = cycles.findIndex((cycle) => cycle.n === n);
  if (index >= 0) cycles[index] = { ...cycles[index], ...patch, n };
  else cycles.push({ n, phase: patch.phase ?? "reserved", ...patch });
  return patchState(runDir, {
    ...state,
    cycles,
    currentSquadTaskId: patch.squadTaskId ?? state.currentSquadTaskId,
  });
}

function toGateReview(
  child: NonNullable<ReturnType<typeof readCliRun>>,
  sha: string,
): RepairGateReview {
  const attempts = child.progress?.attempts ?? [];
  const markdown = readChildReport(child.runId);
  return {
    runId: child.runId,
    incomplete: child.status !== "completed" || child.reviewEvidence?.complete !== true,
    seatsAllSuccess: !attempts.some(
      (attempt) => attempt.status === "failure" || attempt.status === "cancelled",
    ),
    aggregatorComplete: child.status === "completed",
    artifactsOk: child.hasReport && child.hasFindings,
    sha: child.reviewEvidence?.sha ?? sha,
    evidenceComplete: child.reviewEvidence?.evidenceComplete,
    uncoveredIds: child.reviewEvidence?.uncoveredIds ?? [],
    aggregatorVerdict: extractAggregatorVerdict(markdown),
    findings: child.findings,
  };
}

function readChildReport(runId: string): string | null {
  try {
    return readFileSync(join(resolvePaths().runsRoot, runId, "report.md"), "utf8");
  } catch {
    return null;
  }
}

function gateFromSource(
  sourceRunId: string,
  sha: string,
  pr: CheckedOutPr,
  profileBase: string,
  frozenPolicyHash: string | null | undefined,
  frozenBaseSha: string | null | undefined,
) {
  const source = readCliRun(sourceRunId);
  return evaluateRepairGate(
    assembleProductionGate({
      frozenPolicyHash,
      candidateSha: sha,
      publishedSha: sha,
      remote: pr,
      frozenBaseSha,
      expectedBaseBranch: profileBase,
      source: { runId: sourceRunId, prUrl: pr.prUrl },
      squad: null,
      review: source
        ? toGateReview(source, sha)
        : {
            runId: sourceRunId,
            incomplete: true,
            seatsAllSuccess: false,
            aggregatorComplete: false,
            artifactsOk: false,
            sha,
            evidenceComplete: false,
            uncoveredIds: [],
            aggregatorVerdict: null,
            findings: [],
          },
      checkedAt: new Date().toISOString(),
      adoptedExistingRemote: true,
    }),
  );
}

function findCompleteChild(against: string, sha: string): string | null {
  try {
    for (const name of readdirSync(resolvePaths().runsRoot)) {
      if (!name.startsWith("ck-review-")) continue;
      const run = readCliRun(name);
      if (
        run?.reviewEvidence?.againstRunId === against &&
        run.reviewEvidence.complete &&
        run.reviewEvidence.sha?.toLowerCase() === sha.toLowerCase()
      ) {
        return name;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function releaseWriterQuietly(profile: RepairProfile, holderRunId: string): void {
  try {
    releaseWriterLease({ repo: profile.repo, sourceBranch: profile.sourceBranch, holderRunId });
  } catch {
    // keep blocking if extras are alive
  }
}

function expectedRemoteSha(state: RepairState, sourceSha: string): string {
  if (state.publishedSha) return state.publishedSha;
  if (state.candidateSha) return state.candidateSha;
  return sourceSha;
}

type FrozenHistoryLaunch = {
  historyExportPath: string;
  historyExportHash: string;
  previousTaskId: string;
  previousTaskDir: string;
};

function buildSquadDelivery(input: {
  grantHash: string;
  profile: RepairProfile;
  packageBody: RepairPackage;
  state: RepairState;
  preflightSha: string;
  runId: string;
  cycleN: number;
  history: FrozenHistoryLaunch | null;
}): SquadBridgeDelivery {
  return {
    grantHash: input.grantHash,
    repo: input.profile.repo,
    sourceBranch: input.profile.sourceBranch,
    sourceSha: input.packageBody.source.sha,
    expectedOldSha: (input.state.publishedSha ?? input.preflightSha).toLowerCase(),
    remote: "origin",
    originUrl: input.state.frozenOriginUrl ?? undefined,
    pushUrl: input.state.frozenPushUrl ?? input.state.frozenOriginUrl ?? undefined,
    parentRunId: input.runId,
    newRepairChain: input.cycleN === 1,
    previousTaskId: input.history?.previousTaskId,
    previousTaskDir: input.history?.previousTaskDir,
    historyExportPath: input.history?.historyExportPath,
    historyExportHash: input.history?.historyExportHash,
  };
}

function cycleAlreadyLaunched(cycle: RepairCycle | undefined): boolean {
  if (!cycle?.squadTaskDir) return false;
  try {
    const raw = JSON.parse(
      readFileSync(join(cycle.squadTaskDir, "councilkit-bridge.json"), "utf8"),
    ) as { nativeSession?: unknown };
    return typeof raw.nativeSession === "string" && raw.nativeSession.length > 0;
  } catch {
    return false;
  }
}

async function resolveFrozenHistoryLaunch(input: {
  runDir: string;
  runId: string;
  state: RepairState;
  cycle: RepairCycle | undefined;
  previous: { squadTaskId: string; squadTaskDir: string } | null;
  profile: RepairProfile;
  bridge: SquadBridge;
  allowExport: boolean;
}): Promise<FrozenHistoryLaunch> {
  if (!input.previous?.squadTaskId || !input.previous.squadTaskDir) {
    throw errors.runFailed("subsequent squad subtask is missing a frozen previous task");
  }
  const previous = input.previous;
  const ownedRoot = join(resolvePaths().home, "squad-tasks");
  const verify = (path: string, expectedHash?: string): FrozenHistoryLaunch => {
    const loaded = readVerifiedHistoryExport(path, expectedHash);
    if (!loaded.ok) throw errors.runFailed(loaded.reason);
    const owned = assertHistoryOriginsOwned(
      loaded.envelope,
      collectAllowedOrigins(input.state),
      ownedRoot,
      { projectId: input.profile.repo, repairChainId: input.runId },
    );
    if (!owned.ok) throw errors.runFailed(owned.reason);
    return {
      historyExportPath: path,
      historyExportHash: loaded.hash,
      previousTaskId: previous.squadTaskId,
      previousTaskDir: previous.squadTaskDir,
    };
  };
  if (input.cycle?.historyExportPath && input.cycle.historyExportHash) {
    return verify(input.cycle.historyExportPath, input.cycle.historyExportHash);
  }
  const saved = loadPersistedHistoryExport(input.runDir, previous.squadTaskId);
  if (saved) return verify(saved.path, saved.hash);
  if (!input.allowExport || !input.bridge.exportHistory) {
    throw errors.runFailed("subsequent squad task is missing a frozen history export");
  }
  try {
    input.bridge.stop({ taskId: previous.squadTaskId });
  } catch {
    // already stopped
  }
  if ((input.bridge.writerPids?.() ?? []).length > 0) {
    throw errors.runFailed(
      "previous squad writer is still alive; refusing to export or start a new writer",
    );
  }
  const exported = await Promise.resolve(
    input.bridge.exportHistory({
      taskId: previous.squadTaskId,
      allowedOrigins: collectAllowedOrigins(input.state),
      projectId: input.profile.repo,
      repairChainId: input.runId,
    }),
  );
  persistHistoryExport(input.runDir, previous.squadTaskId, exported.envelope);
  const persisted = loadPersistedHistoryExport(input.runDir, previous.squadTaskId);
  if (!persisted) {
    throw errors.runFailed("refusing to start without a persisted history export");
  }
  return verify(persisted.path, persisted.hash);
}

function previousSquadTask(
  state: RepairState,
  cycleN: number,
): { squadTaskId: string; squadTaskDir: string } | null {
  const cycles = [...(state.cycles ?? [])]
    .filter(
      (cycle) =>
        cycle.n < cycleN &&
        typeof cycle.squadTaskId === "string" &&
        typeof cycle.squadTaskDir === "string",
    )
    .sort((a, b) => a.n - b.n);
  const last = cycles.at(-1);
  if (!last?.squadTaskId || !last.squadTaskDir) return null;
  return { squadTaskId: last.squadTaskId, squadTaskDir: last.squadTaskDir };
}

function collectAllowedOrigins(state: RepairState): AllowedHistoryOrigin[] {
  const origins: AllowedHistoryOrigin[] = [];
  for (const cycle of state.cycles ?? []) {
    if (!cycle.squadTaskDir) continue;
    try {
      const raw = JSON.parse(
        readFileSync(join(cycle.squadTaskDir, "councilkit-bridge.json"), "utf8"),
      ) as {
        squadTaskId?: string;
        taskDir?: string;
      };
      if (raw.squadTaskId && raw.taskDir) {
        origins.push({ journalTaskId: raw.squadTaskId, taskDir: raw.taskDir });
      }
    } catch {
      // skip unreadable identity
    }
  }
  return origins;
}

function persistHistoryExport(runDir: string, taskId: string, envelope: unknown): string {
  const parsed = parseHistoryEnvelope(envelope);
  if (!parsed) throw errors.runFailed("refusing to persist an unverified history export");
  const dir = join(runDir, "history");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${taskId}.json`);
  atomicWriteJson(path, parsed);
  atomicWriteFile(join(dir, `${taskId}.sha256`), `${historyEnvelopeHash(parsed)}\n`);
  return path;
}

function loadPersistedHistoryExport(
  runDir: string,
  taskId: string,
): { path: string; hash: string } | null {
  const path = join(runDir, "history", `${taskId}.json`);
  const hashPath = join(runDir, "history", `${taskId}.sha256`);
  if (!existsSync(path) || !existsSync(hashPath)) return null;
  const expected = readFileSync(hashPath, "utf8").trim();
  const loaded = readVerifiedHistoryExport(path, expected);
  if (!loaded.ok) {
    throw errors.runFailed(loaded.reason);
  }
  return { path, hash: loaded.hash };
}

function startedTaskDir(state: RepairState): string | null {
  const cycles = state.cycles ?? [];
  for (let index = cycles.length - 1; index >= 0; index -= 1) {
    const dir = cycles[index]?.squadTaskDir;
    if (dir) return dir;
  }
  return null;
}

function executionIdFor(runId: string, cycleN: number): string {
  return `exec-${runId}-${cycleN}`;
}

function nowMsOrNow(deps: RepairLoopDeps): number {
  return (deps.nowMs ?? Date.now)();
}

function bindExecutionPids(
  runDir: string,
  executionId: string,
  pids: number[],
  nowMs: number,
): void {
  const path = executionRecordPath(runDir, executionId);
  const existing = readExecutionRecord(path);
  if (existing === null) return;
  const allowed = canStartWriter({
    existing,
    writerKnown: pids.length > 0 || existing.pids.length === 0,
    writerAlive: false,
  });
  if (!allowed.ok && allowed.reason === "unknown_writer") {
    throw errors.runFailed("refusing a new writer while a previous writer is unknown");
  }
  writeExecutionRecord(
    path,
    markExecutionStarted(existing, pids.length > 0 ? pids : existing.pids, nowMs),
  );
}

function runIdFromArgv(argv: string[]): string | null {
  const index = argv.indexOf("--run-id");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && value.length > 0 ? value : null;
}

function loadRepairPackage(sourceRunId: string): RepairPackage {
  const run = readCliRun(sourceRunId);
  if (!run) throw new Error("review run not found");
  const runDir = join(resolvePaths().runsRoot, sourceRunId);
  let findingsBytes: string | undefined;
  try {
    findingsBytes = readFileSync(join(runDir, "findings.json"), "utf8");
  } catch {
    findingsBytes = undefined;
  }
  const findingGroups = loadFindingGroups({
    runDir,
    ledger: {
      runId: sourceRunId,
      sha: run.reviewEvidence?.sha ?? null,
      findings: run.findings,
      againstRunId: run.reviewEvidence?.againstRunId ?? null,
    },
    findingsBytes,
  });
  const adjudication = readAdjudicationFile(join(runDir, "adjudication.json"));
  const findings = adjudication
    ? run.findings.map((row) => {
        const frozen = adjudication.items.find((item) => item.assertion.sourceFindingId === row.id);
        return frozen ? { ...row, title: frozen.assertion.invariant } : row;
      })
    : run.findings;
  return buildRepairPackage({
    runId: sourceRunId,
    complete: canExportRepairPackage(run),
    prUrl: run.reviewEvidence?.prUrl ?? null,
    ledger: {
      runId: sourceRunId,
      sha: run.reviewEvidence?.sha ?? null,
      findings,
      againstRunId: run.reviewEvidence?.againstRunId ?? null,
    },
    planLock: run.planLock,
    findingGroups,
  });
}

function loadFrozenGoalContract(
  runDir: string,
  parentRunIds: readonly string[],
): GoalContract | null {
  const local = readGoalContractFile(join(runDir, "goal-contract.json"));
  if (local) return local;
  for (const parentRunId of parentRunIds) {
    const reused = readGoalContractFile(
      join(resolvePaths().runsRoot, parentRunId, "goal-contract.json"),
    );
    if (reused) return reused;
  }
  return null;
}

function readGoalContractFile(path: string): GoalContract | null {
  try {
    return goalContractSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function readAdjudicationFile(path: string): AdjudicationProjection | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AdjudicationProjection;
    return Array.isArray(parsed.items) ? parsed : null;
  } catch {
    return null;
  }
}

function persistAdjudication(
  runDir: string,
  chainId: string | null | undefined,
  input: {
    sourceRunId: string;
    candidateSha: string;
    findings: LedgerFinding[];
    findingGroups: ReturnType<typeof loadFindingGroups>;
  },
): AdjudicationProjection {
  const prior =
    readAdjudicationFile(join(runDir, "adjudication.json")) ??
    (chainId ? loadPriorAdjudicationFromParents(chainId) : null);
  const projection = ingestAdjudication({
    prior,
    sourceRunId: input.sourceRunId,
    candidateSha: input.candidateSha,
    findings: input.findings,
    findingGroups: input.findingGroups,
  });
  atomicWriteJson(join(runDir, "adjudication.json"), projection);
  return projection;
}

function loadPriorAdjudicationFromParents(chainId: string): AdjudicationProjection | null {
  const chain = readRepairChain(chainId);
  if (!chain) return null;
  for (const parentRunId of [...chain.parentRunIds].reverse()) {
    const prior = readAdjudicationFile(
      join(resolvePaths().runsRoot, parentRunId, "adjudication.json"),
    );
    if (prior) return prior;
  }
  return null;
}

function uniqueScope(findings: readonly LedgerFinding[]): string[] {
  return [...new Set(findings.flatMap((row) => row.files))].slice(0, 200);
}

function persistGoalProjection(input: {
  runDir: string;
  contract: GoalContract;
  candidateSha: string | null;
  missingEvidence: string[];
  remainingBudget: string;
}): GoalContract {
  atomicWriteJson(join(input.runDir, "goal-contract.json"), input.contract);
  atomicWriteJson(
    join(input.runDir, "task-card.json"),
    generateTaskCard({
      contract: input.contract,
      candidateSha: input.candidateSha,
      responsibleAssertions: input.contract.acceptance.map((row) => row.assertionId),
      originalCounterexamples: input.contract.acceptance.map((row) => row.trigger),
      rejectedApproaches: [],
      missingEvidence: input.missingEvidence,
      remainingBudget: input.remainingBudget,
    }),
  );
  return input.contract;
}

function bindOfficialExpectedPolicy(
  bridge: SquadBridge,
  taskId: string,
  runDir: string,
  state: RepairState,
): { ok: true; hash: string } | { ok: false; reason: string } {
  if (bridge.readOfficialGatePolicy) {
    const existing = bridge.readOfficialGatePolicy({ taskId });
    if (existing && isFrozenPolicyHash(existing.policyHash)) {
      atomicWriteJson(join(runDir, "official-gate-policy.json"), existing);
      return { ok: true, hash: existing.policyHash };
    }
  }
  if (bridge.freezeOfficialGatePolicy) {
    const frozen = bridge.freezeOfficialGatePolicy({ taskId });
    if (frozen instanceof Promise) {
      return { ok: false, reason: "official policy freeze must be synchronous in this controller" };
    }
    if (!frozen.ok) return frozen;
    atomicWriteJson(join(runDir, "official-gate-policy.json"), frozen.freeze);
    return { ok: true, hash: frozen.freeze.policyHash };
  }
  if (isFrozenPolicyHash(state.frozenPolicyHash)) {
    return { ok: true, hash: state.frozenPolicyHash };
  }
  return {
    ok: false,
    reason:
      "no official squadctl gate policy-freeze record; catalog or candidate hashes are not expected",
  };
}

function bindOfficialPolicyState(
  input: { runId: string; runDir: string; sourceRunId: string },
  state: RepairState,
  hash: string,
): RepairState {
  const next = patchState(input.runDir, { ...state, frozenPolicyHash: hash });
  if (
    !isV2Protocol(next.protocolVersion) ||
    readGoalContractFile(join(input.runDir, "goal-contract.json"))
  ) {
    return next;
  }
  const sourceRun = readCliRun(input.sourceRunId);
  const originalRequest = sourceRun?.title?.trim();
  if (!originalRequest || !next.chainId) return next;
  const missingEvidence: string[] = [];
  const contract = persistGoalProjection({
    runDir: input.runDir,
    contract: buildGoalContract({
      sourceRunId: input.sourceRunId,
      originalRequest,
      goal: originalRequest,
      invariants: [],
      allowedScope: uniqueScope(sourceRun?.findings ?? []),
      acceptance: realAcceptanceMethods(sourceRun?.findings ?? [], missingEvidence),
      chainId: next.chainId,
      frozenPolicyHash: hash,
    }),
    candidateSha: next.candidateSha ?? null,
    missingEvidence,
    remainingBudget: next.remainingBudget ?? "",
  });
  return patchState(input.runDir, {
    ...next,
    contractVersion: contract.version,
    goalSummary: contract.goal,
  });
}

async function materializeIndependentVerification(input: {
  runDir: string;
  contract: GoalContract | null;
  candidateSha: string;
  workspaceCwd: string;
  deadlineAtMs?: number | null;
  nowMs?: number;
  reserve?: () => { ok: true } | { ok: false; reason: string };
}): Promise<{ ok: true; cwd: string | null; executed: boolean } | { ok: false; reason: string }> {
  if (!input.contract) return { ok: true, cwd: null, executed: false };
  const methods = commandMethods(input.contract);
  if (methods.length === 0) return { ok: true, cwd: null, executed: false };
  if (!/^[0-9a-f]{40}$/i.test(input.candidateSha) || input.candidateSha === "0".repeat(40)) {
    return { ok: false, reason: "candidate SHA is unknown; independent verification was not run" };
  }
  const verificationDir = join(input.runDir, "verification");
  mkdirSync(verificationDir, { recursive: true });
  const snapshot = await ensureCandidateSnapshot({
    sourceCwd: input.workspaceCwd,
    candidateSha: input.candidateSha,
    snapshotRoot: join(input.runDir, "candidate-snapshots"),
  });
  if (!snapshot.ok) {
    atomicWriteJson(join(verificationDir, "snapshot-unknown.json"), { reason: snapshot.reason });
    return { ok: true, cwd: null, executed: false };
  }
  const pending: Array<{
    method: (typeof methods)[number];
    testAssetVersion: string;
    cacheKey: string;
    logPath: string;
  }> = [];
  for (const method of methods) {
    const testAssetVersion = hashTestAssetContents([method.trigger]);
    const cacheKey = verificationCacheKey({
      snapshotSha: snapshot.head,
      assertionVersion: method.assertionId,
      testAssetVersion,
    });
    const logPath = join(verificationDir, `${method.assertionId}.log`);
    const cached = receiptFromIsolatedLog({
      assertionId: method.assertionId,
      command: method.trigger,
      cwd: snapshot.cwd,
      snapshotSha: snapshot.head,
      dirtyTree: snapshot.dirtyTree,
      testAssetVersion,
      logPath,
      cacheKey,
    });
    if (cached) continue;
    pending.push({ method, testAssetVersion, cacheKey, logPath });
  }
  if (pending.length === 0) return { ok: true, cwd: snapshot.cwd, executed: false };
  if (
    input.deadlineAtMs !== null &&
    input.deadlineAtMs !== undefined &&
    (input.nowMs ?? Date.now()) >= input.deadlineAtMs
  ) {
    return { ok: false, reason: "chain deadline reached before independent verification" };
  }
  if (input.reserve) {
    const reserved = input.reserve();
    if (!reserved.ok) return { ok: false, reason: reserved.reason };
  }
  for (const item of pending) {
    const result = await runCandidateCommand({
      command: item.method.trigger,
      cwd: snapshot.cwd,
      outputDir: join(input.runDir, "verification-out"),
      tmpDir: join(input.runDir, "verification-tmp"),
    });
    writeCommandLog(item.logPath, {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      snapshotSha: snapshot.head,
      cwd: snapshot.cwd,
      dirtyTree: snapshot.dirtyTree,
      cacheKey: item.cacheKey,
    });
  }
  return { ok: true, cwd: snapshot.cwd, executed: true };
}

function realAcceptanceMethods(
  findings: readonly LedgerFinding[],
  missingEvidence: string[],
): GoalContract["acceptance"] {
  const acceptance: GoalContract["acceptance"] = [];
  for (const row of findings) {
    if (row.status === "accepted") continue;
    const command = row.verification?.command?.trim();
    const locations = row.verification?.locations ?? [];
    if (command) {
      acceptance.push({
        assertionId: assertionIdFor(row.id, 1),
        precondition: row.verification?.evidence || row.text || row.title,
        trigger: command,
        allowedStimuli: [command],
        observation: command,
        environment: "isolated candidate worktree",
        evidenceKind:
          row.verification?.method === "regression_test" ? "regression_test" : "command_receipt",
      });
      continue;
    }
    if (row.verification?.method === "code_trace" && locations.length > 0) {
      acceptance.push({
        assertionId: assertionIdFor(row.id, 1),
        precondition: row.verification.evidence || row.text || row.title,
        trigger: locations.join(","),
        allowedStimuli: [...locations],
        observation: locations.join(","),
        environment: "independent reviewer trace",
        evidenceKind: "code_trace",
      });
      continue;
    }
    missingEvidence.push(row.id);
  }
  return acceptance;
}

function bindVerificationForGate(input: {
  runDir: string;
  contract: GoalContract | null;
  candidateSha: string;
  workspaceCwd: string;
  findings: LedgerFinding[];
}): { assets: VerificationAsset[]; requiredAssertionIds: string[] } {
  const requiredAssertionIds = [
    ...commandMethods(input.contract).map((row) => row.assertionId),
    ...codeTraceMethods(input.contract).map((row) => row.assertionId),
  ];
  const assets: VerificationAsset[] = [];
  for (const method of codeTraceMethods(input.contract)) {
    const collected = codeTraceFromReview(input.findings, method.assertionId, input.candidateSha);
    if (collected) assets.push(collected);
  }
  const commands = commandMethods(input.contract);
  for (const method of commands) {
    const testAssetVersion = hashTestAssetContents([method.trigger]);
    const logPath = join(input.runDir, "verification", `${method.assertionId}.log`);
    const cacheKey = verificationCacheKey({
      snapshotSha: input.candidateSha,
      assertionVersion: method.assertionId,
      testAssetVersion,
    });
    const collected = receiptFromIsolatedLog({
      assertionId: method.assertionId,
      command: method.trigger,
      cwd: input.workspaceCwd,
      snapshotSha: input.candidateSha,
      dirtyTree: false,
      testAssetVersion,
      logPath,
      cacheKey,
    });
    if (collected?.receipts[0]) {
      assets.push({
        ...collected,
        extraProbeManifestVersion: extraProbeManifestVersion([]),
        receipts: collected.receipts.map((row) => ({
          ...row,
          dirtyTree: row.dirtyTree,
        })),
      });
    }
  }
  if (assets.length > 0) {
    persistVerificationAssets(join(input.runDir, "verification-assets.json"), assets);
  }
  return { assets, requiredAssertionIds };
}
