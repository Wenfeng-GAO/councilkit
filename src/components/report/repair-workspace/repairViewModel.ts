import {
  REPAIR_OBS_COPY,
  type RepairObservation,
  type RepairOperation,
  deriveSilenceAttention,
  evaluateApprovalConsistency,
  filterOperations,
  resolveAttentionCopy,
} from "@shared/runtime/repair-observation";

export type RepairViewModel = {
  goalText: string;
  phaseText: string;
  attention: string | null;
  lastActivityLabel: string;
  processLabel: string;
  connectionLabel: string;
  isHistorical: boolean;
  canStop: boolean;
  canResume: boolean;
  filtered: RepairOperation[];
  emptyReason: "waiting" | "filter" | "none";
};

export function buildRepairViewModel(input: {
  observation: RepairObservation | null;
  connectionLost: boolean;
  selectedRound: number | "current";
  filter: { roleKey: string; kind: string; query: string };
  stopAckPending: boolean;
  evidenceGateConsistent?: boolean;
}): RepairViewModel {
  const obs = input.observation;
  if (!obs) {
    return {
      goalText: REPAIR_OBS_COPY.goalMissing,
      phaseText: "—",
      attention: input.connectionLost ? REPAIR_OBS_COPY.connectionLost : REPAIR_OBS_COPY.waitingFirst,
      lastActivityLabel: "未记录",
      processLabel: REPAIR_OBS_COPY.processUnknown,
      connectionLabel: input.connectionLost ? REPAIR_OBS_COPY.connectionLost : "已连接",
      isHistorical: false,
      canStop: false,
      canResume: false,
      filtered: [],
      emptyReason: "waiting",
    };
  }

  const silence = deriveSilenceAttention({
    nowMs: Date.parse(obs.serverTime),
    lastActivityAt: obs.task.lastActivityAt,
    processState: obs.task.process.state,
  });

  const judged = evaluateApprovalConsistency({
    businessResult: obs.task.businessResult,
    candidateSha: obs.task.candidateSha,
    baseSha: obs.task.baseSha,
    evidenceCandidateSha: obs.task.candidateSha,
    requiredItems:
      input.evidenceGateConsistent === false
        ? [{ status: "insufficient", candidateSha: null }]
        : obs.task.businessResult === "approved"
          ? [{ status: "passed", candidateSha: obs.task.candidateSha }]
          : [],
  });

  const filtered = filterOperations(obs.upserts, input.filter);
  const emptyActive = obs.upserts.length === 0 && obs.task.businessResult === null;
  const gateDisplay =
    obs.task.reasonCode === "candidate_ready_awaiting_gate" && obs.task.businessResult == null
      ? "candidate_pending"
      : input.evidenceGateConsistent === false
        ? "conflict"
        : judged.display;
  const attention = resolveAttentionCopy({
    connectionLost: input.connectionLost,
    display: gateDisplay,
    silence,
    emptyActive,
    stopAckPending:
      obs.task.businessResult === "stopped"
        ? false
        : input.stopAckPending || Boolean(obs.task.stopAckPending),
  });

  const isHistorical = input.selectedRound !== "current" && input.selectedRound !== obs.currentRound;
  const canStop =
    !isHistorical &&
    !input.connectionLost &&
    obs.task.businessResult === null &&
    gateDisplay !== "approved";
  const canResume =
    !isHistorical &&
    !input.connectionLost &&
    obs.task.resumeEligible === true &&
    obs.task.process.state !== "unknown";

  return {
    goalText: obs.task.goalSummary?.trim() || REPAIR_OBS_COPY.goalMissing,
    phaseText: obs.task.phase ?? "—",
    attention,
    lastActivityLabel: obs.task.lastActivityAt ?? "未记录",
    processLabel:
      obs.task.process.state === "alive"
        ? "进程仍在线"
        : obs.task.process.state === "exited"
          ? "进程已退出"
          : REPAIR_OBS_COPY.processUnknown,
    connectionLabel: input.connectionLost ? REPAIR_OBS_COPY.connectionLost : "观察已连接",
    isHistorical,
    canStop,
    canResume,
    filtered,
    emptyReason: emptyActive ? "waiting" : filtered.length === 0 ? "filter" : "none",
  };
}
