import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCliRun } from "@shared/runtime/cli-runs-index";
import {
  type RepairGateReview,
  evaluateRepairGate,
  extractAggregatorVerdict,
} from "@shared/runtime/repair-gate";
import { type RepairPackage, buildRepairPackage } from "@shared/runtime/repair-package";
import { canExportRepairPackage } from "@shared/runtime/review-case";
import {
  type FrozenIntegrateIdentity,
  SQUAD_BRIDGE_CONTRACT_VERSION,
  canRequestPublish,
  parentOuterCycleDelta,
} from "@shared/runtime/squad-bridge-contract";
import { ReviewExit, runReview } from "../commands/review";
import { EXIT, errors } from "../errors";
import type { OutputSink } from "../output";
import { resolvePaths } from "../store/paths";
import type { CheckedOutPr } from "./checkout-pr";
import { inspectPullRequest } from "./checkout-pr";
import { loadFindingGroups } from "./finding-groups";
import { ensureRepairHandoff } from "./repair-handoff";
import { acquireWriterLease, releaseWriterLease } from "./repair-lease";
import {
  type RepairState,
  appendRepairJournal,
  readRepairState,
  writeRepairLive,
  writeRepairState,
} from "./repair-persist";
import { runRepairPreflight, sourceNeedsSupplementReview } from "./repair-preflight";
import { type RepairProfile, createRepairGrant, loadRepairProfile } from "./repair-profile";
import { inspectCwdForRepair, resolveRepairWorkspaceCwd } from "./repair-workspace";
import type { SquadBridge } from "./squad-bridge";
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
  workspaceCwd?: string;
}

const POLICY = "gate-policy-1";

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
  let workspaceCwd: string;
  try {
    workspaceCwd = resolveRepairWorkspaceCwd({
      explicit: deps.workspaceCwd,
      frozen: state.workspaceCwd,
      sourceRunId: input.sourceRunId,
      runId: input.runId,
    });
  } catch (error) {
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: "pr_drift",
      message: error instanceof Error ? error.message : "workspace rejected",
    });
  }
  const bridge = deps.bridge ?? new SquadctlBridge({ workspaceCwd });
  const profile = loadRepairProfile(input.profileName);
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
  const grant = createRepairGrant(profile);
  writeFileSync(join(input.runDir, "repair-grant.json"), `${JSON.stringify(grant, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  state = patchState(input.runDir, {
    ...state,
    prUrl,
    workspaceCwd,
    grantId: grant.grantId,
    grantHash: grant.grantHash,
    profileHash: profile.integrityHash,
    frozenBaseSha: state.frozenBaseSha ?? pr.baseSha ?? null,
    priorCompleteReviewId: state.priorCompleteReviewId ?? input.sourceRunId,
  });
  const published = Boolean(state.publishedSha);
  const preflight = runRepairPreflight({
    sourceRunId: state.packageSourceRunId ?? input.sourceRunId,
    profile,
    pr,
    bridgeVersion: deps.bridge ? SQUAD_BRIDGE_CONTRACT_VERSION : probe.version,
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
    const gate = gateFromSource(packageSourceId, preflight.sourceSha, pr);
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
      appendRepairJournal(input.runDir, { kind: "outer_cycle.intent", n: cycleN, at: now() });
      const cycles = [...(state.cycles ?? []), { n: cycleN, phase: "reserved" as const }];
      state = patchState(input.runDir, {
        ...state,
        casVersion: state.casVersion + 1,
        outerUsed: state.outerUsed + 1,
        cycles,
      });
    }
    const cycle = state.cycles?.find((row) => row.n === cycleN);
    let taskId = cycle?.squadTaskId ?? null;
    if (cycle?.phase === "reviewed" || cycle?.phase === "published") {
      taskId = cycle.squadTaskId ?? taskId;
    } else if (taskId && cycle?.phase === "active") {
      writeRepairLive(input.runDir, { status: "running", phase: "repair-squad-repair" });
      input.out.progress(`repair outer ${cycleN}/${state.outerMax}`);
      let snapshot = bridge.resume({ taskId });
      snapshot = await waitForCandidate(bridge, taskId, snapshot, input.runDir, now);
      if (!canRequestPublish(snapshot.event)) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "squad_candidate_invalid",
          message: "squad journal gates incomplete",
          outerUsed: state.outerUsed,
        });
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
      const started = bridge.start({
        requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
        packageFields: {},
        handoffPath: handoff.path,
        baseSha: packageBody.source.sha,
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
      if (bridge.prepare) {
        await bridge.prepare({
          taskId: started.taskId,
          baseSha: packageBody.source.sha,
          packagePath: handoff.path,
        });
      }
      taskId = started.taskId;
      state = patchCycle(input.runDir, state, cycleN, {
        phase: "active",
        squadTaskId: started.taskId,
      });
      let snapshot = bridge.status({ taskId: started.taskId });
      snapshot = await waitForCandidate(bridge, started.taskId, snapshot, input.runDir, now);
      if (parentOuterCycleDelta({ kind: "candidate.fix" }) !== 0) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "verdict_contradiction",
          message: "inner fix must not consume parent budget",
        });
      }
      if (!canRequestPublish(snapshot.event)) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "squad_candidate_invalid",
          message: "squad journal gates incomplete",
          outerUsed: state.outerUsed,
        });
      }
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
    if (!taskId) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "squad_candidate_invalid",
        message: "squad task missing after resume",
        outerUsed: state.outerUsed,
      });
    }
    const identitySha = (
      state.candidateSha ??
      state.publishedSha ??
      preflight.sourceSha
    ).toLowerCase();
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
    const gate = evaluateRepairGate({
      source: { runId: input.sourceRunId, prUrl, sha: identitySha },
      candidateSha: identitySha,
      publishedSha: state.publishedSha ?? identitySha,
      remoteHead: remote.headSha?.toLowerCase() ?? null,
      baseUnchanged:
        remote.baseBranch === profile.base &&
        (state.frozenBaseSha === null ||
          state.frozenBaseSha === undefined ||
          !remote.baseSha ||
          remote.baseSha.toLowerCase() === state.frozenBaseSha.toLowerCase()),
      prOpen: remote.prOpen !== false,
      squad: {
        taskId,
        invalidated: snapshot.event.journal.invalidated,
        independentReview: snapshot.event.journal.independentReview,
        independentVerify: snapshot.event.journal.independentVerify,
        requiredGatesPassed: snapshot.event.journal.requiredGatesPassed,
        sha: snapshot.event.journal.candidateSha,
        gatePolicyHash: snapshot.event.journal.gatePolicyHash,
      },
      review: reviewGate,
      policyHash: POLICY,
      checkedAt: now(),
    });
    state = patchCycle(input.runDir, state, cycleN, { phase: "gated" });
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
    const stillOpen = reviewGate.findings.filter((row) => row.status !== "accepted").length;
    const publishedFixes = (state.cycles ?? []).filter((row) => row.phase !== "reserved").length;
    if (publishedFixes >= 2 && stillOpen > 0 && sameAgainstStillOpen(child, against)) {
      writeRepairLive(input.runDir, { status: "running", phase: "repair-diagnosing" });
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: "findings_open",
        message: "same against-id still open after two published fixes",
        latestReviewId: childId,
        outerUsed: state.outerUsed,
      });
    }
    const canRetry =
      stillOpen > 0 &&
      gate.reasons.every((reason) => reason.code === "findings_open") &&
      state.outerUsed < state.outerMax;
    if (!canRetry) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: gate.reasons[0]?.code ?? "findings_open",
        message: gate.reasons[0]?.evidence ?? "repair gate failed",
        latestReviewId: childId,
        outerUsed: state.outerUsed,
      });
    }
    state = patchCycle(input.runDir, state, cycleN, { phase: "closed" });
    state = patchState(input.runDir, {
      ...state,
      publishLadder: "none",
      packageSourceRunId: childId,
    });
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
): Promise<ReturnType<SquadBridge["status"]>> {
  let inner = 0;
  let current = snapshot;
  while (!canRequestPublish(current.event) && inner < 3) {
    inner += 1;
    appendRepairJournal(runDir, { kind: "candidate.fix", n: inner, at: now() });
    current = bridge.status({ taskId });
  }
  return current;
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
    const published = input.bridge.requestPublish({ taskId: input.taskId, identity });
    if (!published.ok) {
      return {
        done: true,
        outcome: finish(input.input, {
          businessResult: "needs_attention",
          reasonCode: published.code,
          message: published.code,
          outerUsed: state.outerUsed,
        }),
      };
    }
    state = patchState(input.input.runDir, { ...state, publishLadder: "receipt" });
  }
  const remote = await input.inspect(input.prUrl);
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

function gateFromSource(sourceRunId: string, sha: string, pr: CheckedOutPr) {
  const source = readCliRun(sourceRunId);
  return evaluateRepairGate({
    source: { runId: sourceRunId, prUrl: pr.prUrl, sha },
    candidateSha: sha,
    publishedSha: sha,
    remoteHead: pr.headSha ?? sha,
    baseUnchanged: true,
    prOpen: pr.prOpen !== false,
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
    policyHash: POLICY,
    checkedAt: new Date().toISOString(),
  });
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

function sameAgainstStillOpen(
  child: NonNullable<ReturnType<typeof readCliRun>>,
  against: string,
): boolean {
  return child.reviewEvidence?.againstRunId === against;
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

function startedTaskDir(state: RepairState): string | null {
  const last = state.cycles?.at(-1);
  return last?.squadTaskId ? last.squadTaskId : null;
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
  return buildRepairPackage({
    runId: sourceRunId,
    complete: canExportRepairPackage(run),
    prUrl: run.reviewEvidence?.prUrl ?? null,
    ledger: {
      runId: sourceRunId,
      sha: run.reviewEvidence?.sha ?? null,
      findings: run.findings,
      againstRunId: run.reviewEvidence?.againstRunId ?? null,
    },
    planLock: run.planLock,
    findingGroups,
  });
}
