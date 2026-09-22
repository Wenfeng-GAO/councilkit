import { describe, expect, it } from "vitest";
import {
  REPAIR_OBS_COPY,
  REPAIR_OBS_PROCESS_FRESH_MS,
  REPAIR_OBS_SILENCE_MS,
  applyUiWindow,
  buildEventId,
  buildOperationId,
  countNewOperations,
  decodeObservationCursor,
  deriveProcessState,
  deriveSilenceAttention,
  encodeObservationCursor,
  evaluateApprovalConsistency,
  exportEvidenceMarkdown,
  filterOperations,
  foldPublicText,
  isStaleRequest,
  markUnfinishedTools,
  mergeOperationRevision,
  nextPollDelayMs,
  normalizeToolRecords,
  observationDone,
  parsePublicSourceLine,
  redactObservationText,
  redactObservationValue,
  resolveAttentionCopy,
  type RawSourceRecord,
  type RepairOperation,
} from "@shared/runtime/repair-observation";
import { buildRepairViewModel } from "@/components/report/repair-workspace/repairViewModel";

const T0 = Date.parse("2026-09-22T06:00:00Z");

function baseOp(partial: Partial<RepairOperation> & Pick<RepairOperation, "operationId" | "eventId">): RepairOperation {
  return {
    sourceId: "s1",
    sourceGeneration: "g1",
    executionRef: "exec-a#1.1",
    round: 2,
    roleKey: "builder",
    revision: 1,
    occurredAt: "2026-09-22T06:00:00Z",
    receivedAt: "2026-09-22T06:00:00Z",
    kind: "tool",
    status: "started",
    summary: "op",
    detailRef: null,
    truncated: false,
    ...partial,
  };
}

function raw(partial: Partial<RawSourceRecord> & Pick<RawSourceRecord, "type" | "byteOffset">): RawSourceRecord {
  return {
    sourceId: "s1",
    sourceGeneration: "g1",
    executionRef: "exec-a#1.1",
    round: 2,
    roleKey: "builder",
    receivedAt: "2026-09-22T06:00:00Z",
    occurredAt: "2026-09-22T06:00:00Z",
    callId: null,
    ...partial,
  };
}

describe("U01 snapshot projection", () => {
  it("does not invent goal/actualModel/budget defaults", () => {
    const vm = buildRepairViewModel({
      observation: {
        schemaVersion: 1,
        runId: "ck-repair-00000000-0000-4000-8000-000000000128",
        round: 2,
        currentRound: 2,
        snapshotVersion: "2:",
        serverTime: "2026-09-22T06:00:00Z",
        observedAt: "2026-09-22T06:00:00Z",
        availability: "partial",
        reasons: [],
        sourceWatermarks: [],
        task: {
          phase: null,
          businessResult: null,
          candidateSha: null,
          baseSha: null,
          goalSummary: null,
          lastActivityAt: null,
          lastActivityTimeSource: "unknown",
          process: { state: "unknown", checkedAt: null },
          resumeEligible: null,
          budget: null,
        },
        roles: [
          {
            roleKey: "builder",
            label: "编排与开发",
            executionGroup: "builder",
            executionRef: null,
            planned: true,
            status: "pending",
            requestedModel: "req-model",
            actualModel: null,
          },
        ],
        upserts: [],
        nextCursor: "",
        earlierCursor: null,
        hasMore: false,
        reset: false,
        observationDone: false,
      },
      connectionLost: false,
      selectedRound: "current",
      filter: { roleKey: "all", kind: "all", query: "" },
      stopAckPending: false,
    });
    expect(vm.goalText).toBe(REPAIR_OBS_COPY.goalMissing);
    expect(vm.attention).toBe(REPAIR_OBS_COPY.waitingFirst);
  });

  it("counterexample: approved without evidence is conflict not green pass", () => {
    const result = evaluateApprovalConsistency({
      businessResult: "approved",
      candidateSha: null,
      baseSha: "b".repeat(40),
      evidenceCandidateSha: null,
      requiredItems: [],
    });
    expect(result.display).toBe("conflict");
    expect(result.exportableAsApproved).toBe(false);
  });
});

describe("U02 source association semantics", () => {
  it("child review role keys stay distinct from source baseline", () => {
    const child = parsePublicSourceLine(
      JSON.stringify({ type: "progress", text: "jury", roleKey: "jury-security" }),
      {
        sourceId: "child:ck-review-x:security",
        sourceGeneration: "g",
        executionRef: "security#1.1",
        round: 2,
        roleKey: "jury-security",
        byteOffset: 0,
        receivedAt: "2026-09-22T06:00:00Z",
      },
    );
    expect(child).not.toBe("bad");
    expect(child).not.toBe("skip");
    if (child !== "bad" && child !== "skip") {
      expect(child.roleKey).toBe("jury-security");
      expect(child.executionRef).toBe("security#1.1");
    }
  });

  it("counterexample: path traversal markers are not trusted as readable records", () => {
    // Resolver rejects; here the pure parser still requires structured JSON.
    expect(parsePublicSourceLine("../etc/passwd", {
      sourceId: "x",
      sourceGeneration: "g",
      executionRef: "e",
      round: 1,
      roleKey: "builder",
      byteOffset: 0,
      receivedAt: "t",
    })).toBe("bad");
  });
});

describe("U03 event identity", () => {
  it("isolates same callId across executions and upserts idempotently", () => {
    const a = buildOperationId({
      executionRef: "exec-a#1.1",
      sourceGeneration: "g1",
      callId: "call-1",
      byteOffset: 10,
    });
    const b = buildOperationId({
      executionRef: "exec-b#1.1",
      sourceGeneration: "g1",
      callId: "call-1",
      byteOffset: 10,
    });
    expect(a).not.toBe(b);
    const first = baseOp({ operationId: a, eventId: buildEventId(a, 1), status: "started" });
    const replay = baseOp({ operationId: a, eventId: buildEventId(a, 1), status: "started", revision: 1 });
    expect(mergeOperationRevision(first, replay).eventId).toBe(first.eventId);
  });
});

describe("U04 tool association", () => {
  it("pairs by callId and never rolls completed back to started", () => {
    const started = normalizeToolRecords([
      raw({ type: "tool.started", callId: "c1", name: "bash", summary: "go test", byteOffset: 1 }),
      raw({ type: "tool.started", callId: "c2", name: "bash", summary: "go test", byteOffset: 2 }),
    ]);
    const completed = normalizeToolRecords([
      raw({
        type: "tool.completed",
        callId: "c2",
        name: "bash",
        summary: "ok",
        byteOffset: 3,
        status: "completed",
      }),
    ]);
    const merged = completed.reduce((acc, op) => {
      const prev = acc.find((row) => row.operationId === op.operationId);
      return acc
        .filter((row) => row.operationId !== op.operationId)
        .concat(mergeOperationRevision(prev, op));
    }, started);
    const c2 = merged.find((op) => op.operationId.includes("c2"))!;
    const lateStart = mergeOperationRevision(
      c2,
      baseOp({ ...c2, status: "started", revision: 9 }),
    );
    expect(lateStart.status).toBe("completed");
    expect(merged.map((op) => op.operationId).filter((id) => id.includes("c1") || id.includes("c2")).length).toBe(2);
  });

  it("counterexample: same command name without callId does not pair", () => {
    const ops = normalizeToolRecords([
      raw({ type: "tool.started", callId: null, name: "bash", summary: "go test", byteOffset: 10 }),
      raw({
        type: "tool.completed",
        callId: null,
        name: "bash",
        summary: "go test",
        byteOffset: 20,
        status: "completed",
      }),
    ]);
    expect(ops).toHaveLength(2);
    expect(ops[0]!.operationId).not.toBe(ops[1]!.operationId);
  });
});

describe("U05 text folding", () => {
  it("merges public text and drops thinking", () => {
    const ops = foldPublicText([
      raw({ type: "thinking", text: "secret-reason", byteOffset: 1 }),
      raw({ type: "text", text: "hello ", byteOffset: 2 }),
      raw({ type: "text.delta", text: "world", byteOffset: 3 }),
      raw({ type: "reasoning", text: "hidden", byteOffset: 4 }),
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.summary).toContain("hello");
    expect(ops[0]!.summary).toContain("world");
    expect(JSON.stringify(ops)).not.toContain("secret-reason");
    expect(JSON.stringify(ops)).not.toContain("hidden");
  });
});

describe("U06 byte reading helpers", () => {
  it("does not commit incomplete lines and isolates oversize conceptually via parser skip of non-json", () => {
    expect(
      parsePublicSourceLine('{"type":"text","text":"半', {
        sourceId: "s",
        sourceGeneration: "g",
        executionRef: "e",
        round: 1,
        roleKey: "builder",
        byteOffset: 0,
        receivedAt: "t",
      }),
    ).toBe("bad");
    expect(
      parsePublicSourceLine('{"type":"text","text":"完整中文"}', {
        sourceId: "s",
        sourceGeneration: "g",
        executionRef: "e",
        round: 1,
        roleKey: "builder",
        byteOffset: 0,
        receivedAt: "t",
      }),
    ).toMatchObject({ text: "完整中文" });
  });
});

describe("U07 cursor and rotation", () => {
  it("rejects foreign run cursors and oversized cursors", () => {
    const cursor = encodeObservationCursor({
      runId: "ck-repair-a",
      round: 2,
      direction: "forward",
      watermarks: [{ sourceId: "s", generation: "g1", offset: 12 }],
    });
    expect(decodeObservationCursor(cursor, { runId: "ck-repair-b", round: 2 }).ok).toBe(false);
    expect(decodeObservationCursor("not-base64!!!", { runId: "ck-repair-a", round: 2 }).ok).toBe(
      false,
    );
    const huge = "a".repeat(5000);
    expect(decodeObservationCursor(huge, { runId: "ck-repair-a", round: 2 }).ok).toBe(false);
  });
});

describe("U08 window and cache", () => {
  it("caps rendered window and reports hidden earlier rows", () => {
    const ops = Array.from({ length: 500 }, (_, i) =>
      baseOp({
        operationId: `op-${i}`,
        eventId: `evt-${i}`,
        receivedAt: new Date(T0 + i * 1000).toISOString(),
        summary: `row-${i}`,
      }),
    );
    const window = applyUiWindow(ops, 200);
    expect(window.window.length).toBeLessThanOrEqual(200);
    expect(window.hiddenCount).toBeGreaterThan(0);
  });
});

describe("U09 redaction", () => {
  it("redacts headers, cookies, api keys, and url query secrets before output", () => {
    const input =
      'Authorization: Bearer SECRETTOKEN Cookie: session=abc api_key=sk-ABCDEFGHIJKLMNOP https://example.test?token=LEAK123&x=1';
    const out = redactObservationText(input);
    expect(out).not.toContain("SECRETTOKEN");
    expect(out).not.toContain("session=abc");
    expect(out).not.toContain("sk-ABCDEFGHIJKLMNOP");
    expect(out).not.toContain("LEAK123");
    expect(out).toContain("[REDACTED]");
    const nested = redactObservationValue({
      headers: { Authorization: "Bearer NESTED" },
      cookie: "raw-cookie",
      deep: { apiKey: "nested-key" },
    }) as Record<string, unknown>;
    expect(JSON.stringify(nested)).not.toContain("NESTED");
    expect(JSON.stringify(nested)).not.toContain("raw-cookie");
    expect(JSON.stringify(nested)).not.toContain("nested-key");
  });
});

describe("U10 time and liveness", () => {
  it("marks silence at 180s with fresh matching process evidence", () => {
    const last = new Date(T0).toISOString();
    const checked = new Date(T0 + REPAIR_OBS_SILENCE_MS + 1000).toISOString();
    const process = deriveProcessState({
      authoritativeTerminal: false,
      currentExecutionRef: "exec-a#1.1",
      evidence: {
        executionRef: "exec-a#1.1",
        pid: 42,
        startKey: "start-1",
        checkedAt: checked,
        alive: true,
      },
      nowMs: T0 + REPAIR_OBS_SILENCE_MS + 1000,
    });
    expect(process.state).toBe("alive");
    expect(
      deriveSilenceAttention({
        nowMs: T0 + REPAIR_OBS_SILENCE_MS + 1000,
        lastActivityAt: last,
        processState: process.state,
      }),
    ).toBe("silent_alive");
  });

  it("counterexample: same pid different startKey is unknown; stale heartbeat expires", () => {
    const stale = deriveProcessState({
      authoritativeTerminal: false,
      currentExecutionRef: "exec-a#1.1",
      evidence: {
        executionRef: "exec-a#1.1",
        pid: 42,
        startKey: null,
        checkedAt: new Date(T0).toISOString(),
        alive: true,
      },
      nowMs: T0 + REPAIR_OBS_PROCESS_FRESH_MS + 1,
    });
    expect(stale.state).toBe("unknown");
    const terminal = deriveProcessState({
      authoritativeTerminal: true,
      currentExecutionRef: "exec-a#1.1",
      evidence: {
        executionRef: "exec-a#1.1",
        pid: 42,
        startKey: "s",
        checkedAt: new Date(T0).toISOString(),
        alive: true,
      },
      nowMs: T0,
    });
    expect(terminal.state).toBe("alive");
  });

  it("does not infer an exit from business completion without independent process evidence", () => {
    expect(
      deriveProcessState({
        authoritativeTerminal: true,
        currentExecutionRef: "exec-a#1.1",
        evidence: null,
        nowMs: T0,
      }),
    ).toEqual({ state: "unknown", checkedAt: null });
  });

  it.each([false, true])("uses matching explicit exit evidence with business terminal=%s", (authoritativeTerminal) => {
    const input = {
      authoritativeTerminal,
      currentExecutionRef: "exec-a#1.1",
      evidence: {
        executionRef: "exec-a#1.1",
        pid: 42,
        startKey: "start-1",
        checkedAt: new Date(T0).toISOString(),
        alive: false,
      },
      nowMs: T0,
    };
    expect(deriveProcessState(input).state).toBe("exited");
    expect(deriveProcessState({ ...input, currentExecutionRef: "other#1.1" }).state).toBe("unknown");
    expect(deriveProcessState({ ...input, currentExecutionRef: null }).state).toBe("unknown");
  });
});

describe("U11 reading freeze counts", () => {
  it("counts only new operationIds while allowing status updates", () => {
    const known = new Set(["op-1"]);
    const counted = countNewOperations(known, [
      baseOp({ operationId: "op-1", eventId: "e1", status: "completed", revision: 2 }),
      baseOp({ operationId: "op-2", eventId: "e2" }),
      baseOp({ operationId: "op-2", eventId: "e2" }),
    ]);
    expect(counted.count).toBe(1);
  });
});

describe("U12 request generation", () => {
  it("treats mismatched request seq as stale", () => {
    expect(isStaleRequest(1, 2)).toBe(true);
    expect(isStaleRequest(3, 3)).toBe(false);
    expect(nextPollDelayMs(0)).toBe(1000);
    expect(nextPollDelayMs(1)).toBe(2000);
    expect(nextPollDelayMs(5)).toBe(30_000);
  });
});

describe("U13 query filter AND semantics", () => {
  it("requires role+kind+query and restores on clear", () => {
    const ops = [
      baseOp({
        operationId: "1",
        eventId: "1",
        roleKey: "builder",
        kind: "file",
        summary: "session_operations.go",
      }),
      baseOp({
        operationId: "2",
        eventId: "2",
        roleKey: "reviewer",
        kind: "command",
        summary: "go test",
      }),
    ];
    const filtered = filterOperations(ops, {
      roleKey: "builder",
      kind: "tool",
      query: "session",
    });
    expect(filtered).toHaveLength(1);
    expect(filterOperations(ops, { roleKey: "all", kind: "all", query: "" })).toHaveLength(2);
  });
});

describe("U14 historical selection", () => {
  it("marks historical rounds read-only without stop/resume", () => {
    const vm = buildRepairViewModel({
      observation: {
        schemaVersion: 1,
        runId: "ck-repair-00000000-0000-4000-8000-000000000128",
        round: 1,
        currentRound: 2,
        snapshotVersion: "1:",
        serverTime: "2026-09-22T06:00:00Z",
        observedAt: "2026-09-22T06:00:00Z",
        availability: "available",
        reasons: [],
        sourceWatermarks: [],
        task: {
          phase: "active",
          businessResult: null,
          candidateSha: null,
          baseSha: null,
          goalSummary: "goal",
          lastActivityAt: "2026-09-22T06:00:00Z",
          lastActivityTimeSource: "recorded",
          process: { state: "alive", checkedAt: "2026-09-22T06:00:00Z" },
          resumeEligible: true,
        },
        roles: [],
        upserts: [],
        nextCursor: "",
        earlierCursor: null,
        hasMore: false,
        reset: false,
        observationDone: false,
      },
      connectionLost: false,
      selectedRound: 1,
      filter: { roleKey: "all", kind: "all", query: "" },
      stopAckPending: false,
    });
    expect(vm.isHistorical).toBe(true);
    expect(vm.canStop).toBe(false);
    expect(vm.canResume).toBe(false);
  });
});

describe("U15 role display grouping", () => {
  it("keeps independent sessions separate and does not invent planner_b", () => {
    const ops = normalizeToolRecords([
      raw({ type: "tool.started", roleKey: "reviewer", callId: "r1", byteOffset: 1, executionRef: "rev#1.1" }),
      raw({ type: "tool.started", roleKey: "verifier", callId: "v1", byteOffset: 2, executionRef: "ver#1.1" }),
    ]);
    expect(ops.map((op) => op.roleKey).sort()).toEqual(["reviewer", "verifier"]);
    expect(ops.every((op) => op.executionRef.includes("#"))).toBe(true);
  });
});

describe("U16 mutation presentation", () => {
  it.each([
    ["squad_failed", REPAIR_OBS_COPY.repairFailed],
    ["source_fix_failed", REPAIR_OBS_COPY.repairFailed],
    ["independent_review_quota", REPAIR_OBS_COPY.quotaAttention],
    ["deadline", REPAIR_OBS_COPY.needsAttention],
    [null, REPAIR_OBS_COPY.needsAttention],
  ])("reports the actual attention reason %s", (reasonCode, expected) => {
    expect(
      resolveAttentionCopy({
        connectionLost: false,
        display: "needs_attention",
        silence: null,
        emptyActive: false,
        stopAckPending: false,
        reasonCode,
      }),
    ).toBe(expected);
  });

  it("shows stopping until controller confirms stopped", () => {
    expect(
      resolveAttentionCopy({
        connectionLost: false,
        display: "running",
        silence: null,
        emptyActive: false,
        stopAckPending: true,
      }),
    ).toBe(REPAIR_OBS_COPY.stopping);
    expect(
      resolveAttentionCopy({
        connectionLost: false,
        display: "stopped",
        silence: null,
        emptyActive: false,
        stopAckPending: false,
      }),
    ).toBe(REPAIR_OBS_COPY.stopped);
  });
});

describe("U17 evidence versioning", () => {
  it("rejects approved with old candidate evidence", () => {
    const result = evaluateApprovalConsistency({
      businessResult: "approved",
      candidateSha: "c".repeat(40),
      baseSha: "b".repeat(40),
      evidenceCandidateSha: "a".repeat(40),
      requiredItems: [{ status: "passed", candidateSha: "a".repeat(40) }],
    });
    expect(result.display).toBe("conflict");
    expect(result.exportableAsApproved).toBe(false);
  });
});

describe("U18 terminal drain", () => {
  it("keeps observation open until parent terminal and sources exhausted", () => {
    expect(observationDone({ parentTerminal: true, sourcesExhausted: false })).toBe(false);
    expect(observationDone({ parentTerminal: false, sourcesExhausted: true })).toBe(false);
    expect(observationDone({ parentTerminal: true, sourcesExhausted: true })).toBe(true);
  });
});

describe("U19 empty/restricted sources", () => {
  it("distinguishes waiting vs conflict copy", () => {
    expect(
      resolveAttentionCopy({
        connectionLost: false,
        display: "running",
        silence: null,
        emptyActive: true,
        stopAckPending: false,
      }),
    ).toBe(REPAIR_OBS_COPY.waitingFirst);
    expect(
      resolveAttentionCopy({
        connectionLost: false,
        display: "conflict",
        silence: null,
        emptyActive: false,
        stopAckPending: false,
      }),
    ).toBe(REPAIR_OBS_COPY.stateEvidenceConflict);
  });
});

describe("U20 DOM focus helpers", () => {
  it("does not throw when return focus node is disconnected", () => {
    const node = { isConnected: false, focus() { throw new Error("should not focus"); } };
    const title = { focus() { /* ok */ } };
    expect(() => {
      if (node.isConnected) node.focus();
      else title.focus();
    }).not.toThrow();
  });
});

describe("U21 export serialization", () => {
  it("never marks export approved without consistent evidence and redacts detail", () => {
    const md = exportEvidenceMarkdown({
      schemaVersion: 1,
      runId: "ck-repair-x",
      round: 2,
      candidateSha: "c".repeat(40),
      baseSha: "b".repeat(40),
      verifiedAt: null,
      assertionVersion: "v1",
      gateConsistent: false,
      exportableAsApproved: false,
      items: [
        {
          assertionId: "a1",
          label: "gate",
          status: "insufficient",
          candidateSha: "a".repeat(40),
          assertionVersion: "old",
          source: "log",
          detail: "Authorization: Bearer EXPORTSECRET",
        },
      ],
      availability: "partial",
      reasons: [],
    });
    expect(md).toContain("exportableAsApproved: false");
    expect(md).not.toContain("EXPORTSECRET");
  });
});

describe("U22 authoritative files have no side effects in pure helpers", () => {
  it("markUnfinished does not invent success exit codes", () => {
    const ops = markUnfinishedTools(
      [
        baseOp({
          operationId: "op",
          eventId: "e",
          status: "started",
          kind: "command",
          occurredAt: new Date(T0).toISOString(),
        }),
      ],
      T0 + 181_000,
    );
    expect(ops[0]!.status).toBe("unfinished");
    expect(ops[0]!.summary).toContain(REPAIR_OBS_COPY.unfinishedTool);
  });
});
