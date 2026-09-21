import {
  authorizeBudgetAppend,
  bootstrapChain,
  canOpenSourceFix,
  consumeRetry,
  consumeSourceFix,
  inheritChain,
  newRepairBudget,
  writeCutoffMs,
} from "@shared/runtime/repair-chain";
import {
  canStartWriter,
  countsAsSourceFixDispatch,
  createExecutionIntent,
  enforceDeadline,
  finishExecution,
  isInfrastructureRecovery,
  markExecutionStarted,
  replayExecution,
  takeOverExecution,
} from "@shared/runtime/repair-execution";
import { recoverPublishReceipt } from "@shared/runtime/repair-publish";
import { describe, expect, it } from "vitest";

const FINGERPRINT = "c".repeat(64);
const SHA = "d".repeat(40);

describe("repair chain budget", () => {
  it("inherits used budget onto a new parent run without resetting", () => {
    const first = bootstrapChain({
      repo: "github.com/acme/repo",
      prUrl: "https://github.com/acme/repo/pull/1",
      goalFingerprint: FINGERPRINT,
      parentRunId: "ck-repair-1",
      budget: consumeSourceFix(newRepairBudget({}, 0)),
    });
    expect(first.budget.sourceFixUsed).toBe(1);
    const inherited = inheritChain(first, "ck-repair-2");
    expect(inherited.budget.sourceFixUsed).toBe(1);
    expect(inherited.parentRunIds).toEqual(["ck-repair-1", "ck-repair-2"]);
  });

  it("refuses a new source-fix after write cutoff while allowing final review time", () => {
    const budget = newRepairBudget({ startedAtMs: 0, deadlineMs: 120, reservedFinalMs: 40 }, 0);
    expect(writeCutoffMs(budget)).toBe(80);
    expect(canOpenSourceFix(budget, 80).ok).toBe(false);
    expect(canOpenSourceFix(budget, 79).ok).toBe(true);
  });

  it("does not implicitly add diagnose or swap chains when exhausted", () => {
    const budget = consumeSourceFix(
      consumeSourceFix(consumeSourceFix(newRepairBudget({ sourceFixMax: 3 }, 0))),
    );
    expect(canOpenSourceFix(budget, 0)).toEqual({ ok: false, reason: "source_fix_exhausted" });
    const diagnose = consumeRetry(budget, "diagnose");
    expect(diagnose.ok).toBe(true);
    const appended = authorizeBudgetAppend(budget, { sourceFixMax: 5 });
    expect(appended.sourceFixUsed).toBe(3);
    expect(appended.sourceFixMax).toBe(5);
  });
});

describe("idempotent execution", () => {
  it("replays the same execution id instead of starting a second writer", () => {
    const intent = createExecutionIntent({
      executionId: "exec-1",
      kind: "source_fix",
      chainId: "ck-chain-1",
      parentRunId: "ck-repair-1",
      inputSha: SHA,
      contractVersion: 1,
      deadlineAtMs: 1000,
    });
    const started = markExecutionStarted(intent, [42], 10);
    const replay = replayExecution(started, intent);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.execution.state).toBe("started");
  });

  it("counts a no-commit exit as a source-fix dispatch", () => {
    const intent = createExecutionIntent({
      executionId: "exec-2",
      kind: "source_fix",
      chainId: "ck-chain-1",
      parentRunId: "ck-repair-1",
      inputSha: SHA,
      contractVersion: 1,
      deadlineAtMs: 1000,
    });
    expect(countsAsSourceFixDispatch(intent)).toBe(true);
    const finished = finishExecution(intent, "no_commit", 20);
    expect(countsAsSourceFixDispatch(finished)).toBe(true);
  });

  it("allows starting an intent that has not yet recorded a process", () => {
    const intent = createExecutionIntent({
      executionId: "exec-intent",
      kind: "source_fix",
      chainId: "ck-chain-1",
      parentRunId: "ck-repair-1",
      inputSha: SHA,
      contractVersion: 1,
      deadlineAtMs: 1000,
    });
    expect(canStartWriter({ existing: intent, writerKnown: false, writerAlive: false })).toEqual({
      ok: true,
    });
  });

  it("refuses a new writer when the previous writer is unknown, and allows takeover of a known one", () => {
    const running = markExecutionStarted(
      createExecutionIntent({
        executionId: "exec-3",
        kind: "source_fix",
        chainId: "ck-chain-1",
        parentRunId: "ck-repair-1",
        inputSha: SHA,
        contractVersion: 1,
        deadlineAtMs: 1000,
      }),
      [7],
      5,
    );
    expect(canStartWriter({ existing: running, writerKnown: false, writerAlive: false })).toEqual({
      ok: false,
      reason: "unknown_writer",
    });
    const takeover = takeOverExecution(running, [9], 15);
    expect(takeover.state).toBe("running");
    expect(takeover.pids).toEqual([9]);
  });

  it("does not treat a valid source failure plus a new edit as free recovery", () => {
    expect(
      isInfrastructureRecovery({ hadValidSourceFailure: true, isRestartSameExecutionId: false }),
    ).toBe(false);
    expect(
      isInfrastructureRecovery({ hadValidSourceFailure: false, isRestartSameExecutionId: true }),
    ).toBe(true);
  });

  it("enforces deadline after the cutoff even if the parent loop is gone", () => {
    const running = markExecutionStarted(
      createExecutionIntent({
        executionId: "exec-4",
        kind: "source_fix",
        chainId: "ck-chain-1",
        parentRunId: "ck-repair-1",
        inputSha: SHA,
        contractVersion: 1,
        deadlineAtMs: 50,
      }),
      [11],
      1,
    );
    const due = enforceDeadline(running, 50);
    expect(due.due).toBe(true);
    expect(due.execution.state).toBe("started");
  });
});

describe("publish receipt recovery", () => {
  it("records verification when the remote already matches after a lost receipt", () => {
    expect(
      recoverPublishReceipt({
        intendedSha: SHA,
        receiptSha: "unknown",
        remoteHead: SHA,
        inFlight: false,
      }).action,
    ).toBe("record_verified");
  });

  it("blocks drift instead of overwriting", () => {
    expect(
      recoverPublishReceipt({
        intendedSha: SHA,
        receiptSha: SHA,
        remoteHead: "e".repeat(40),
        inFlight: false,
      }).action,
    ).toBe("block_drift");
  });

  it("waits rather than republishing when work may still be in flight", () => {
    expect(
      recoverPublishReceipt({
        intendedSha: SHA,
        receiptSha: "unknown",
        remoteHead: "unknown",
        inFlight: true,
      }).action,
    ).toBe("wait_in_flight");
  });
});
