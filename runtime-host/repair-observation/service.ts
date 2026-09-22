/**
 * Repair observation service — read-only projection over trusted sources.
 * Cache writes (optional) go only to COUNCILKIT_HOME/observation-cache/.
 * Failures never affect repair execution.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCouncilkitHome } from "@shared/runtime/cli-home";
import {
  REPAIR_OBS_DETAIL_CHUNK,
  REPAIR_OBS_PAGE_LIMIT,
  REPAIR_OBS_SCHEMA_VERSION,
  type RepairEvidence,
  type RepairEventDetail,
  type RepairObservation,
  type RepairOperation,
  type RepairRole,
  buildOperationId,
  decodeObservationCursor,
  deriveProcessState,
  encodeObservationCursor,
  evaluateApprovalConsistency,
  executionGroupForRole,
  exportEvidenceMarkdown,
  observationDone,
  redactObservationText,
  redactObservationValue,
  repairEvidenceSchema,
  repairEventDetailSchema,
  repairObservationSchema,
  roleLabel,
} from "@shared/runtime/repair-observation";
import { normalizeRecords } from "./normalizer";
import { type TrustedSource, resolveTrustedSources } from "./resolver";
import { readDetailChunk, readSourceWindow } from "./source-reader";

export type ObservationServiceOptions = {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
};

function clampLimit(raw: string | null): number {
  if (raw === null || raw.length === 0) return REPAIR_OBS_PAGE_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return REPAIR_OBS_PAGE_LIMIT;
  return Math.min(n, REPAIR_OBS_PAGE_LIMIT);
}

function parseRound(raw: string | null): number | "current" {
  if (raw === null || raw === "" || raw === "current") return "current";
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return "current";
  return n;
}

function tryWriteCache(env: NodeJS.ProcessEnv, key: string, value: unknown): void {
  try {
    const root = join(resolveCouncilkitHome(env), "observation-cache");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, `${key}.json`), JSON.stringify(value), { mode: 0o600 });
  } catch {
    // Cache failure must not affect observation correctness or repair execution.
  }
}

function readProcessEvidence(
  sources: TrustedSource[],
  state: ReturnType<typeof resolveTrustedSources>["state"],
): {
  evidence: {
    executionRef: string | null;
    pid: number | null;
    startKey: string | null;
    checkedAt: string | null;
    alive: boolean;
  } | null;
  currentExecutionRef: string | null;
} {
  const currentExecutionRef = sources.find((s) => s.kind === "orchestrator_log")?.executionRef ?? null;
  const exec = state?.executions?.find((e) => e.state === "running") ?? state?.executions?.at(-1);
  const metaSource = sources.find((s) => s.kind === "adapter_meta");
  if (!exec && !metaSource) {
    return { evidence: null, currentExecutionRef };
  }
  let startKey: string | null = null;
  let checkedAt: string | null = null;
  let alive = exec?.state === "running";
  let pid = exec?.pids[0] ?? null;
  let executionRef = currentExecutionRef;
  if (metaSource) {
    try {
      const meta = JSON.parse(readFileSync(metaSource.path, "utf8")) as Record<string, unknown>;
      const nested =
        meta.process !== null && typeof meta.process === "object" && !Array.isArray(meta.process)
          ? (meta.process as Record<string, unknown>)
          : null;
      const start = typeof meta.startKey === "string" ? meta.startKey : nested?.startKey;
      if (typeof start === "string") startKey = start;
      if (typeof meta.checkedAt === "string") checkedAt = meta.checkedAt;
      else if (typeof nested?.checkedAt === "string") checkedAt = nested.checkedAt;
      if (typeof meta.alive === "boolean") alive = meta.alive;
      if (typeof meta.pid === "number") pid = meta.pid;
      else if (typeof nested?.pid === "number") pid = nested.pid;
      else if (typeof meta.orchestratorPid === "number") pid = meta.orchestratorPid;
      if (typeof meta.executionRef === "string") executionRef = meta.executionRef;
      else if (typeof meta.executionId === "string" && currentExecutionRef) executionRef = currentExecutionRef;
    } catch {
      // ignore
    }
  }
  return {
    evidence: {
      executionRef,
      pid,
      startKey,
      checkedAt: checkedAt ?? (exec?.startedAtMs ? new Date(exec.startedAtMs).toISOString() : null),
      alive,
    },
    currentExecutionRef,
  };
}

function mapEvidenceStatus(status: string | undefined): RepairEvidence["items"][number]["status"] {
  if (status === "passed" || status === "failed" || status === "pending") return status;
  if (status === "insufficient" || status === "evidence_insufficient") return "insufficient";
  return "pending";
}

function plannedRoles(sources: TrustedSource[], adapterPath: string | null): RepairRole[] {
  const byKey = new Map<string, RepairRole>();
  // Default builder group when any builder source exists.
  const hasBuilder = sources.some((s) => s.roleKey === "builder" || executionGroupForRole(s.roleKey) === "builder");
  if (hasBuilder) {
    byKey.set("builder", {
      roleKey: "builder",
      label: roleLabel("builder"),
      executionGroup: "builder",
      executionRef: sources.find((s) => executionGroupForRole(s.roleKey) === "builder")?.executionRef ?? null,
      planned: true,
      status: "active",
      requestedModel: null,
      actualModel: null,
    });
  }
  for (const source of sources) {
    if (source.roleKey === "builder") continue;
    if (byKey.has(source.roleKey)) continue;
    byKey.set(source.roleKey, {
      roleKey: source.roleKey,
      label: roleLabel(source.roleKey),
      executionGroup: executionGroupForRole(source.roleKey),
      executionRef: source.executionRef,
      planned: source.planned,
      status: source.kind === "child_review_live" ? "active" : "pending",
      requestedModel: null,
      actualModel: null,
    });
  }
  if (adapterPath) {
    try {
      const meta = JSON.parse(readFileSync(adapterPath, "utf8")) as {
        roles?: Array<{
          roleKey: string;
          status?: string;
          requestedModel?: string | null;
          actualModel?: string | null;
          planned?: boolean;
          executionRef?: string | null;
        }>;
      };
      for (const role of meta.roles ?? []) {
        if (!role.planned && !byKey.has(role.roleKey)) continue;
        const existing = byKey.get(role.roleKey);
        byKey.set(role.roleKey, {
          roleKey: role.roleKey,
          label: roleLabel(role.roleKey),
          executionGroup: executionGroupForRole(role.roleKey),
          executionRef: role.executionRef ?? existing?.executionRef ?? null,
          planned: role.planned ?? true,
          status:
            role.status === "pending" ||
            role.status === "active" ||
            role.status === "ended" ||
            role.status === "failed" ||
            role.status === "unknown"
              ? role.status
              : (existing?.status ?? "pending"),
          requestedModel: role.requestedModel ?? null,
          actualModel: role.actualModel ?? null,
        });
      }
    } catch {
      // ignore
    }
  }
  return [...byKey.values()];
}

export function createRepairObservationService(options: ObservationServiceOptions = {}) {
  const nowFn = options.now ?? (() => new Date());
  const env = options.env ?? process.env;

  function getObservation(input: {
    runId: string;
    roundRaw: string | null;
    cursorRaw: string | null;
    limitRaw: string | null;
  }): RepairObservation {
    const now = nowFn();
    const roundSel = parseRound(input.roundRaw);
    const resolved = resolveTrustedSources(input.runId, roundSel, env);
    const round = roundSel === "current" ? resolved.currentRound : roundSel;
    const decoded = decodeObservationCursor(input.cursorRaw, { runId: input.runId, round });
    const limit = clampLimit(input.limitRaw);
    const reasons = [...resolved.reasons];
    let reset = false;
    if (!decoded.ok) {
      reset = true;
      reasons.push(decoded.reason);
    }

    const upserts: RepairOperation[] = [];
    const watermarks: RepairObservation["sourceWatermarks"] = [];
    let hasMore = false;
    let earlierCursor: string | null = null;
    let sourcesExhausted = true;
    let anyRecords = false;

    for (const source of resolved.sources) {
      if (source.kind === "evidence" || source.kind === "adapter_meta") continue;
      const prev = decoded.ok
        ? decoded.cursor.watermarks.find((w) => w.sourceId === source.sourceId)
        : undefined;
      const read = readSourceWindow({
        path: source.path,
        sourceId: source.sourceId,
        executionRef: source.executionRef,
        round: source.round,
        roleKey: source.roleKey,
        expectedGeneration: prev?.generation ?? null,
        fromOffset: reset ? null : (prev?.offset ?? null),
        receivedAt: now.toISOString(),
        limitRecords: limit,
        direction: decoded.ok && !reset ? decoded.cursor.direction : "forward",
      });
      if (read.reset) reset = true;
      if (read.unreadable) reasons.push("来源权限不足，部分记录不可读");
      if (read.partialBadLines > 0) {
        reasons.push(`坏行已跳过 ${read.partialBadLines} 条，后续记录继续`);
      }
      if (read.isolatedOversize > 0) {
        reasons.push(`${source.sourceId}: isolated ${read.isolatedOversize} oversize lines`);
      }
      const ops = normalizeRecords(read.records, read.generation, now.getTime());
      for (const op of ops) {
        if (upserts.length >= limit) {
          hasMore = true;
          break;
        }
        upserts.push(op);
      }
      if (ops.length > 0) anyRecords = true;
      if (!read.exhausted) sourcesExhausted = false;
      watermarks.push({
        sourceId: source.sourceId,
        generation: read.generation,
        cursor: encodeObservationCursor({
          runId: input.runId,
          round,
          direction: "forward",
          watermarks: [{ sourceId: source.sourceId, generation: read.generation, offset: read.nextOffset }],
        }),
      });
      if (read.nextOffset > 0) {
        earlierCursor = encodeObservationCursor({
          runId: input.runId,
          round,
          direction: "earlier",
          watermarks: [{ sourceId: source.sourceId, generation: read.generation, offset: read.nextOffset }],
        });
      }
    }

    const { evidence, currentExecutionRef } = readProcessEvidence(resolved.sources, resolved.state);
    const terminal = resolved.state?.businessResult !== null && resolved.state?.businessResult !== undefined;
    const process = deriveProcessState({
      authoritativeTerminal: Boolean(terminal),
      currentExecutionRef,
      evidence,
      nowMs: now.getTime(),
    });

    const lastActivityAt =
      upserts.reduce<string | null>((acc, op) => {
        const t = op.occurredAt ?? op.receivedAt;
        if (!acc || t > acc) return t;
        return acc;
      }, null) ?? null;

    const adapter = resolved.sources.find((s) => s.kind === "adapter_meta")?.path ?? null;
    const roles = plannedRoles(resolved.sources, adapter);

    // Activity status from ops
    for (const role of roles) {
      const roleOps = upserts.filter(
        (op) => op.roleKey === role.roleKey || executionGroupForRole(op.roleKey) === role.executionGroup,
      );
      if (roleOps.some((op) => op.status === "failed")) role.status = "failed";
      else if (roleOps.some((op) => op.status === "started" || op.status === "unfinished")) role.status = "active";
      else if (roleOps.length > 0 && roleOps.every((op) => op.status === "completed" || op.status === "failed")) {
        role.status = "ended";
      }
    }

    const parentTerminal = terminal || false;
    const done = observationDone({
      parentTerminal,
      sourcesExhausted:
        (sourcesExhausted && anyRecords) || (parentTerminal && resolved.sources.length === 0),
    });

    const sourceFixUsed = resolved.state?.budget?.sourceFixUsed ?? resolved.state?.outerUsed;
    const sourceFixMax = resolved.state?.budget?.sourceFixMax ?? resolved.state?.outerMax;
    const budget =
      sourceFixUsed !== undefined || sourceFixMax !== undefined
        ? {
            sourceFixUsed: sourceFixUsed ?? null,
            sourceFixMax: sourceFixMax ?? null,
            tokenUsageComplete: resolved.state?.budget?.tokenUsed == null ? null : true,
          }
        : null;

    const observation: RepairObservation = {
      schemaVersion: REPAIR_OBS_SCHEMA_VERSION,
      runId: input.runId,
      round,
      currentRound: resolved.currentRound,
      snapshotVersion: createHash("sha256")
        .update(`${round}:${watermarks.map((w) => `${w.sourceId}:${w.generation}`).join("|")}`)
        .digest("hex")
        .slice(0, 32),
      serverTime: now.toISOString(),
      observedAt: now.toISOString(),
      availability: resolved.availability,
      reasons: reasons.map((r) => redactObservationText(r)),
      sourceWatermarks: watermarks,
      task: {
        phase: resolved.state?.cycles?.find((c) => c.n === round)?.phase ?? null,
        businessResult: resolved.state?.businessResult ?? null,
        reasonCode: resolved.state?.reasonCode ?? null,
        candidateSha: resolved.state?.candidateSha ?? null,
        baseSha: resolved.state?.frozenBaseSha ?? null,
        goalSummary: resolved.state?.goalSummary ?? null,
        lastActivityAt,
        lastActivityTimeSource: lastActivityAt
          ? upserts.some((o) => o.occurredAt)
            ? "recorded"
            : "observed_live"
          : "unknown",
        process: {
          state: process.state,
          checkedAt: process.checkedAt,
          startKey: evidence?.startKey ?? null,
        },
        resumeEligible: resolved.state?.resumeEligible ?? null,
        budget,
        protocolVersion: resolved.state?.protocolVersion ?? null,
        stopAckPending: false,
      },
      roles,
      upserts: redactObservationValue(upserts) as RepairOperation[],
      nextCursor: encodeObservationCursor({
        runId: input.runId,
        round,
        direction: "forward",
        watermarks: watermarks.map((w) => {
          const inner = decodeObservationCursor(w.cursor, { runId: input.runId, round });
          const mark = inner.ok ? inner.cursor.watermarks[0] : null;
          return {
            sourceId: w.sourceId,
            generation: w.generation,
            offset: mark?.offset ?? 0,
          };
        }),
      }),
      earlierCursor,
      hasMore,
      reset,
      observationDone: done,
    };

    tryWriteCache(env, `obs-${input.runId}-${round}`, {
      snapshotVersion: observation.snapshotVersion,
      at: observation.observedAt,
    });

    return repairObservationSchema.parse(observation);
  }

  function getEventDetail(input: {
    runId: string;
    eventId: string;
    cursorRaw: string | null;
  }): RepairEventDetail {
    const obs = getObservation({
      runId: input.runId,
      roundRaw: "current",
      cursorRaw: null,
      limitRaw: String(REPAIR_OBS_PAGE_LIMIT),
    });
    const op = obs.upserts.find((row) => row.eventId === input.eventId);
    if (!op) {
      return repairEventDetailSchema.parse({
        schemaVersion: REPAIR_OBS_SCHEMA_VERSION,
        eventId: input.eventId,
        operation: {
          eventId: input.eventId,
          sourceId: "missing",
          sourceGeneration: "missing",
          executionRef: "missing",
          round: obs.round,
          roleKey: "unknown",
          operationId: buildOperationId({
            executionRef: "missing",
            sourceGeneration: "missing",
            callId: null,
            byteOffset: 0,
          }),
          revision: 0,
          occurredAt: null,
          receivedAt: obs.serverTime,
          kind: "state",
          status: "unknown",
          summary: "事件不可用",
          detailRef: null,
          truncated: false,
        },
        body: "",
        truncated: false,
        nextCursor: null,
        availability: "unavailable",
        reasons: ["event not found"],
      });
    }

    const resolved = resolveTrustedSources(input.runId, obs.round, env);
    const source = resolved.sources.find((s) => s.sourceId === op.sourceId);
    let body = op.summary;
    let truncated = false;
    let nextCursor: string | null = null;
    if (source && op.detailRef) {
      const cursorOffset = Number.parseInt(input.cursorRaw ?? "0", 10) || 0;
      // Recover byte offset from operationId when callId was offset-based.
      const offMatch = /\|off:(\d+)/.exec(op.operationId);
      const byteOffset = offMatch ? Number.parseInt(offMatch[1]!, 10) : 0;
      const chunk = readDetailChunk({
        path: source.path,
        byteOffset,
        cursorOffset,
        chunkSize: REPAIR_OBS_DETAIL_CHUNK,
      });
      body = chunk.body || op.summary;
      truncated = chunk.truncated;
      nextCursor = chunk.nextCursor;
    }

    return repairEventDetailSchema.parse({
      schemaVersion: REPAIR_OBS_SCHEMA_VERSION,
      eventId: input.eventId,
      operation: op,
      body: redactObservationText(body).slice(0, REPAIR_OBS_DETAIL_CHUNK),
      truncated,
      nextCursor,
      availability: "available",
      reasons: [],
    });
  }

  function getEvidence(input: { runId: string; roundRaw: string | null }): RepairEvidence {
    const roundSel = parseRound(input.roundRaw);
    const resolved = resolveTrustedSources(input.runId, roundSel, env);
    const round = roundSel === "current" ? resolved.currentRound : roundSel;
    const evidenceSource = resolved.sources.find((s) => s.kind === "evidence");
    let items: RepairEvidence["items"] = [];
    let assertionVersion: string | null = null;
    let verifiedAt: string | null = null;
    let evidenceCandidateSha: string | null = null;
    const reasons = [...resolved.reasons];

    if (evidenceSource) {
      try {
        const raw = JSON.parse(readFileSync(evidenceSource.path, "utf8")) as {
          assertionVersion?: string;
          verifiedAt?: string;
          candidateSha?: string;
          items?: RepairEvidence["items"];
          assertions?: Array<{
            id?: string;
            assertionId?: string;
            title?: string;
            label?: string;
            status?: string;
            source?: string;
            detail?: string;
          }>;
        };
        assertionVersion = raw.assertionVersion ?? null;
        verifiedAt = raw.verifiedAt ?? null;
        evidenceCandidateSha = raw.candidateSha ?? null;
        const rows = raw.items ?? raw.assertions ?? [];
        items = rows.map((item) => ({
          assertionId: ("assertionId" in item && item.assertionId) || ("id" in item && item.id) || "assertion",
          label: ("label" in item && item.label) || ("title" in item && item.title) || "断言",
          status: mapEvidenceStatus("status" in item ? item.status : undefined),
          candidateSha: raw.candidateSha ?? null,
          assertionVersion,
          source: item.source ?? null,
          detail: item.detail ? redactObservationText(item.detail) : null,
        }));
      } catch {
        reasons.push("evidence file unreadable");
      }
    } else {
      reasons.push("evidence unavailable");
    }

    const consistency = evaluateApprovalConsistency({
      businessResult: resolved.state?.businessResult ?? null,
      candidateSha: resolved.state?.candidateSha ?? null,
      baseSha: resolved.state?.frozenBaseSha ?? null,
      evidenceCandidateSha,
      requiredItems: items,
    });

    return repairEvidenceSchema.parse({
      schemaVersion: REPAIR_OBS_SCHEMA_VERSION,
      runId: input.runId,
      round,
      candidateSha: resolved.state?.candidateSha ?? null,
      baseSha: resolved.state?.frozenBaseSha ?? null,
      verifiedAt,
      assertionVersion,
      gateConsistent: consistency.gateConsistent,
      exportableAsApproved: consistency.exportableAsApproved,
      items,
      availability: evidenceSource ? (reasons.length > 0 ? "partial" : "available") : "unavailable",
      reasons,
    });
  }

  function exportEvidence(input: {
    runId: string;
    roundRaw: string | null;
    format: "json" | "md";
  }): { contentType: string; body: string; filename: string } {
    const evidence = getEvidence(input);
    if (input.format === "md") {
      return {
        contentType: "text/markdown; charset=utf-8",
        body: exportEvidenceMarkdown(evidence),
        filename: `${input.runId}-evidence-r${evidence.round}.md`,
      };
    }
    return {
      contentType: "application/json; charset=utf-8",
      body: `${JSON.stringify(redactObservationValue(evidence), null, 2)}\n`,
      filename: `${input.runId}-evidence-r${evidence.round}.json`,
    };
  }

  return { getObservation, getEventDetail, getEvidence, exportEvidence };
}

export type RepairObservationService = ReturnType<typeof createRepairObservationService>;
