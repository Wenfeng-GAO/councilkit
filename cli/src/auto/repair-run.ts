import { randomUUID } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCliRun } from "@shared/runtime/cli-runs-index";
import { type RepairGateReview, evaluateRepairGate } from "@shared/runtime/repair-gate";
import {
  type FrozenIntegrateIdentity,
  SQUAD_BRIDGE_CONTRACT_VERSION,
  canRequestPublish,
  parentOuterCycleDelta,
} from "@shared/runtime/squad-bridge-contract";
import { EXIT } from "../errors";
import type { OutputSink } from "../output";
import { resolvePaths } from "../store/paths";
import type { CheckedOutPr } from "./checkout-pr";
import { inspectPullRequest } from "./checkout-pr";
import { createRepairHandoff } from "./repair-handoff";
import { acquireWriterLease, releaseWriterLease } from "./repair-lease";
import {
  type RepairState,
  appendRepairJournal,
  readRepairState,
  writeRepairLive,
  writeRepairState,
} from "./repair-persist";
import { runRepairPreflight } from "./repair-preflight";
import { type RepairProfile, createRepairGrant, loadRepairProfile } from "./repair-profile";
import type { SquadBridge } from "./squad-bridge";
import { FakeSquadBridge } from "./squad-bridge";

export interface RepairLoopOutcome {
  runId: string;
  sourceRunId: string;
  status: "completed" | "interrupted";
  businessResult: "approved" | "needs_attention" | "stopped";
  reasonCode: string | null;
  outerUsed: number;
  latestReviewId: string | null;
  exitCode: number;
}

export interface RepairLoopDeps {
  bridge?: SquadBridge;
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
  const bridge = deps.bridge ?? new FakeSquadBridge({ version: SQUAD_BRIDGE_CONTRACT_VERSION });
  const profile = loadRepairProfile(input.profileName);
  let state = readRepairState(input.runDir);
  if (state === null) {
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: "councilkit_incomplete",
      message: "repair state missing",
    });
  }
  const source = readCliRun(input.sourceRunId);
  const prUrl = source?.reviewEvidence?.prUrl ?? profile.prUrl;
  const inspect = deps.inspectPr ?? ((url: string) => inspectPullRequest(url));
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
  const preflight = runRepairPreflight({
    sourceRunId: input.sourceRunId,
    profile,
    pr,
    bridgeVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
    historyCount: state.historyCount ?? null,
    parentOuterUsed: state.outerUsed,
    workspaceCwd: deps.workspaceCwd,
  });
  if (!preflight.ok) {
    return finish(input, {
      businessResult: "needs_attention",
      reasonCode: preflight.reasonCode,
      message: preflight.message,
    });
  }
  if (preflight.openFindingIds.length === 0) {
    const gate = gateFromSource(input.sourceRunId, preflight.sourceSha, pr);
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
  const grant = createRepairGrant(profile);
  writeFileSync(join(input.runDir, "repair-grant.json"), `${JSON.stringify(grant, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  acquireWriterLease({
    repo: profile.repo,
    sourceBranch: profile.sourceBranch,
    holderKind: "repair",
    holderRunId: input.runId,
    pid: process.pid,
  });
  state = patchState(input.runDir, {
    ...state,
    prUrl,
    grantId: grant.grantId,
    grantHash: grant.grantHash,
    profileHash: profile.integrityHash,
    priorCompleteReviewId: state.priorCompleteReviewId ?? input.sourceRunId,
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
    writeRepairLive(input.runDir, { status: "running", phase: "repair-squad-repair" });
    input.out.progress(`repair outer ${cycleN}/${state.outerMax}`);
    const handoff = createRepairHandoff({
      runId: input.runId,
      cycle: cycleN,
      body: { from: input.sourceRunId, cycle: cycleN },
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
    });
    if (!started.ok) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: started.code,
        message: started.code,
        outerUsed: state.outerUsed,
      });
    }
    state = patchCycle(input.runDir, state, cycleN, {
      phase: "active",
      squadTaskId: started.taskId,
    });
    let snapshot = bridge.status({ taskId: started.taskId });
    let inner = 0;
    while (!canRequestPublish(snapshot.event) && inner < 3) {
      inner += 1;
      appendRepairJournal(input.runDir, { kind: "candidate.fix", n: inner, at: now() });
      snapshot = bridge.status({ taskId: started.taskId });
    }
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
    const identity: FrozenIntegrateIdentity = {
      repo: profile.repo,
      sourceBranch: profile.sourceBranch,
      expectedOldSha: (state.publishedSha ?? preflight.sourceSha).toLowerCase(),
      candidateSha: snapshot.event.journal.candidateSha.toLowerCase(),
    };
    if ((state.publishLadder ?? "none") !== "published") {
      writeRepairLive(input.runDir, { status: "running", phase: "repair-publishing" });
      if (state.publishLadder !== "receipt" && state.publishLadder !== "head") {
        appendRepairJournal(input.runDir, {
          kind: "publish_intent",
          sha: identity.candidateSha,
          at: now(),
        });
        state = patchState(input.runDir, {
          ...state,
          publishLadder: "intent",
          candidateSha: identity.candidateSha,
        });
        const published = bridge.requestPublish({ taskId: started.taskId, identity });
        if (!published.ok) {
          return finish(input, {
            businessResult: "needs_attention",
            reasonCode: published.code,
            message: published.code,
            outerUsed: state.outerUsed,
          });
        }
        state = patchState(input.runDir, { ...state, publishLadder: "receipt" });
      }
      const remote = await inspect(prUrl);
      if (remote.headSha?.toLowerCase() !== identity.candidateSha) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "pr_drift",
          message: "remote HEAD did not match candidate",
          outerUsed: state.outerUsed,
        });
      }
      state = patchState(input.runDir, {
        ...state,
        publishLadder: "published",
        publishedSha: identity.candidateSha,
        lastRemoteHead: remote.headSha.toLowerCase(),
      });
      state = patchCycle(input.runDir, state, cycleN, { phase: "published" });
    }
    const against = state.priorCompleteReviewId ?? input.sourceRunId;
    const existingChild = findCompleteChild(against, identity.candidateSha);
    let childId = existingChild;
    if (childId === null) {
      writeRepairLive(input.runDir, { status: "running", phase: "repair-reviewing" });
      const review = deps.reviewImpl;
      if (!review) {
        return finish(input, {
          businessResult: "needs_attention",
          reasonCode: "councilkit_incomplete",
          message: "review implementation missing",
          outerUsed: state.outerUsed,
        });
      }
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
    const reviewGate = toGateReview(child, identity.candidateSha);
    const gate = evaluateRepairGate({
      source: { runId: input.sourceRunId, prUrl, sha: identity.candidateSha },
      candidateSha: identity.candidateSha,
      publishedSha: state.publishedSha ?? identity.candidateSha,
      remoteHead: identity.candidateSha,
      baseUnchanged: true,
      prOpen: true,
      squad: {
        taskId: started.taskId,
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
    const publishedFixes = (state.cycles ?? []).filter(
      (cycle) => cycle.phase !== "reserved",
    ).length;
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
    state = patchCycle(input.runDir, state, cycleN, { phase: "closed" });
    state = patchState(input.runDir, { ...state, publishLadder: "none" });
    if (state.outerUsed >= state.outerMax) {
      return finish(input, {
        businessResult: "needs_attention",
        reasonCode: gate.reasons[0]?.code ?? "findings_open",
        message: gate.reasons[0]?.evidence ?? "budget exhausted",
        latestReviewId: childId,
        outerUsed: state.outerUsed,
      });
    }
  }
  return finish(input, {
    businessResult: state.businessResult ?? "needs_attention",
    reasonCode: state.reasonCode,
    message: state.reasonCode ?? "done",
    outerUsed: state.outerUsed,
    latestReviewId: state.latestReviewId ?? null,
  });
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
  return {
    runId: child.runId,
    incomplete: child.status !== "completed" || child.reviewEvidence?.complete !== true,
    seatsAllSuccess: true,
    aggregatorComplete: true,
    artifactsOk: child.hasReport && child.hasFindings,
    sha: child.reviewEvidence?.sha ?? sha,
    evidenceComplete: child.reviewEvidence?.evidenceComplete,
    uncoveredIds: child.reviewEvidence?.uncoveredIds ?? [],
    aggregatorVerdict: "approve",
    findings: child.findings,
  };
}

function gateFromSource(sourceRunId: string, sha: string, pr: CheckedOutPr) {
  const source = readCliRun(sourceRunId);
  return evaluateRepairGate({
    source: { runId: sourceRunId, prUrl: pr.prUrl, sha },
    candidateSha: sha,
    publishedSha: sha,
    remoteHead: pr.headSha ?? sha,
    baseUnchanged: true,
    prOpen: true,
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
