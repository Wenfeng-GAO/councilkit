import { createHash } from "node:crypto";
import { type LedgerFinding, isFindingVerifiedClosed } from "./cli-ledger";
import { canonicalJson } from "./digest";
import { type FindingGroupsFile, resolveRootCause } from "./finding-groups";

export const ADJUDICATION_KINDS = [
  "regression_in_change",
  "in_scope_omission",
  "out_of_scope",
  "unverified_hypothesis",
  "duplicate_alias",
  "evidence_conflict",
] as const;
export type AdjudicationKind = (typeof ADJUDICATION_KINDS)[number];

export const ACCEPTANCE_DISPOSITIONS = [
  "still_open",
  "verified_closed",
  "accepted_with_reason",
  "not_evaluated",
  "coverage_gap",
  "aliased",
  "falsified",
  "out_of_scope_blocking",
  "out_of_scope_recorded",
] as const;
export type AcceptanceDisposition = (typeof ACCEPTANCE_DISPOSITIONS)[number];

export interface ImmutableAssertion {
  assertionId: string;
  assertionVersion: number;
  sourceFindingId: string;
  candidateSha: string | null;
  invariant: string;
  trigger: string;
  expectedTerminal: string;
  evidenceRef: string;
}

export interface AdjudicatedItem {
  assertion: ImmutableAssertion;
  kind: AdjudicationKind;
  disposition: AcceptanceDisposition;
  rootCauseId: string;
  aliasOf: string | null;
  requiredResponsibility: boolean;
  blocking: boolean;
  relatedAssertionIds: string[];
  evidence: string;
}

export interface AdjudicationProjection {
  version: number;
  sourceRunId: string;
  candidateSha: string;
  items: AdjudicatedItem[];
  rawFindingIds: string[];
  uncoveredSourceIds: string[];
  rootCauseIds: string[];
}

export interface GateAcceptanceView {
  openIds: string[];
  coverageGaps: string[];
  blockingOutOfScope: string[];
  notEvaluatedIds: string[];
  verifiedClosedIds: string[];
  falsifiedIds: string[];
  conflict: boolean;
}

const BLOCKING_SEVERITY = new Set(["critical", "major"]);

export function assertionIdFor(findingId: string, version: number): string {
  return `A-${findingId}-v${version}`;
}

export function projectAdjudication(input: {
  sourceRunId: string;
  candidateSha: string;
  findings: LedgerFinding[];
  findingGroups?: FindingGroupsFile | null;
  kinds?: Partial<Record<string, AdjudicationKind>>;
  aliases?: Array<{ fromId: string; toId: string; evidence: string }>;
  falsified?: Array<{ findingId: string; evidence: string }>;
  outOfScope?: Array<{ findingId: string; blocking: boolean; evidence: string }>;
}): AdjudicationProjection {
  const aliasMap = new Map((input.aliases ?? []).map((row) => [row.fromId, row]));
  const falsifiedMap = new Map((input.falsified ?? []).map((row) => [row.findingId, row]));
  const outOfScopeMap = new Map((input.outOfScope ?? []).map((row) => [row.findingId, row]));
  const items: AdjudicatedItem[] = [];
  const rawFindingIds = input.findings.map((row) => row.id);
  const mapped = new Set<string>();
  const rootCauses = new Set<string>();

  for (const row of input.findings) {
    const alias = aliasMap.get(row.id);
    const assertion: ImmutableAssertion = {
      assertionId: assertionIdFor(row.id, 1),
      assertionVersion: 1,
      sourceFindingId: row.id,
      candidateSha: input.candidateSha,
      invariant: row.title,
      trigger: row.text || row.title,
      expectedTerminal: "defect absent on candidate",
      evidenceRef: row.verification?.evidence ?? row.text ?? row.title,
    };
    if (alias) {
      items.push({
        assertion,
        kind: "duplicate_alias",
        disposition: "aliased",
        rootCauseId: resolveRootCause(alias.toId, input.findingGroups),
        aliasOf: alias.toId,
        requiredResponsibility: false,
        blocking: false,
        relatedAssertionIds: [assertionIdFor(alias.toId, 1)],
        evidence: alias.evidence,
      });
      mapped.add(row.id);
      continue;
    }
    const falsified = falsifiedMap.get(row.id);
    if (falsified) {
      items.push({
        assertion,
        kind: input.kinds?.[row.id] ?? "unverified_hypothesis",
        disposition: "falsified",
        rootCauseId: resolveRootCause(row.id, input.findingGroups),
        aliasOf: null,
        requiredResponsibility: true,
        blocking: false,
        relatedAssertionIds: [],
        evidence: falsified.evidence,
      });
      mapped.add(row.id);
      continue;
    }
    const scoped = outOfScopeMap.get(row.id);
    if (scoped) {
      items.push({
        assertion,
        kind: "out_of_scope",
        disposition: scoped.blocking ? "out_of_scope_blocking" : "out_of_scope_recorded",
        rootCauseId: resolveRootCause(row.id, input.findingGroups),
        aliasOf: null,
        requiredResponsibility: scoped.blocking,
        blocking: scoped.blocking,
        relatedAssertionIds: [],
        evidence: scoped.evidence,
      });
      mapped.add(row.id);
      continue;
    }
    const accepted = row.status === "accepted" && Boolean(row.acceptedReason?.trim());
    const verified = isFindingVerifiedClosed(row, input.candidateSha);
    const notEvaluated = row.verification?.outcome === "not_evaluated";
    const required = row.reviewer !== null && row.reviewer !== undefined && row.reviewer.length > 0;
    let disposition: AcceptanceDisposition;
    if (verified) disposition = "verified_closed";
    else if (accepted) disposition = "accepted_with_reason";
    else if (notEvaluated && required) disposition = "coverage_gap";
    else if (notEvaluated) disposition = "not_evaluated";
    else disposition = "still_open";
    const rootCauseId = resolveRootCause(row.id, input.findingGroups);
    rootCauses.add(rootCauseId);
    items.push({
      assertion,
      kind: input.kinds?.[row.id] ?? "in_scope_omission",
      disposition,
      rootCauseId,
      aliasOf: null,
      requiredResponsibility: required || BLOCKING_SEVERITY.has(row.severity),
      blocking:
        BLOCKING_SEVERITY.has(row.severity) && disposition !== "verified_closed" && !accepted,
      relatedAssertionIds: [],
      evidence: row.verification?.evidence ?? row.text ?? row.title,
    });
    mapped.add(row.id);
  }

  const uncoveredSourceIds = rawFindingIds.filter((id) => !mapped.has(id));
  return {
    version: 1,
    sourceRunId: input.sourceRunId,
    candidateSha: input.candidateSha,
    items,
    rawFindingIds,
    uncoveredSourceIds,
    rootCauseIds: [...rootCauses],
  };
}

/** New counter-example keeps the closed assertion; does not rewrite E1. */
export function appendCounterExample(
  projection: AdjudicationProjection,
  input: {
    fromAssertionId: string;
    newFindingId: string;
    evidence: string;
    invariant: string;
  },
): AdjudicationProjection {
  const prior = projection.items.find(
    (item) => item.assertion.assertionId === input.fromAssertionId,
  );
  if (!prior) return projection;
  const nextVersion = prior.assertion.assertionVersion + 1;
  const added: AdjudicatedItem = {
    assertion: {
      assertionId: assertionIdFor(input.newFindingId, nextVersion),
      assertionVersion: nextVersion,
      sourceFindingId: input.newFindingId,
      candidateSha: projection.candidateSha,
      invariant: input.invariant,
      trigger: input.evidence,
      expectedTerminal: "defect absent on candidate",
      evidenceRef: input.evidence,
    },
    kind: "evidence_conflict",
    disposition: "still_open",
    rootCauseId: prior.rootCauseId,
    aliasOf: null,
    requiredResponsibility: true,
    blocking: true,
    relatedAssertionIds: [prior.assertion.assertionId],
    evidence: input.evidence,
  };
  return {
    ...projection,
    version: projection.version + 1,
    items: [...projection.items, added],
    rawFindingIds: unique([...projection.rawFindingIds, input.newFindingId]),
  };
}

export function gateAcceptanceView(projection: AdjudicationProjection): GateAcceptanceView {
  const openIds: string[] = [];
  const coverageGaps: string[] = [];
  const blockingOutOfScope: string[] = [];
  const notEvaluatedIds: string[] = [];
  const verifiedClosedIds: string[] = [];
  const falsifiedIds: string[] = [];
  for (const item of projection.items) {
    const id = item.assertion.sourceFindingId;
    switch (item.disposition) {
      case "verified_closed":
      case "accepted_with_reason":
      case "aliased":
      case "falsified":
      case "out_of_scope_recorded":
        if (item.disposition === "verified_closed") verifiedClosedIds.push(id);
        if (item.disposition === "falsified") falsifiedIds.push(id);
        break;
      case "not_evaluated":
        notEvaluatedIds.push(id);
        break;
      case "coverage_gap":
        coverageGaps.push(id);
        break;
      case "out_of_scope_blocking":
        blockingOutOfScope.push(id);
        break;
      case "still_open":
        openIds.push(id);
        break;
    }
  }
  return {
    openIds,
    coverageGaps: [...coverageGaps, ...projection.uncoveredSourceIds],
    blockingOutOfScope,
    notEvaluatedIds,
    verifiedClosedIds,
    falsifiedIds,
    conflict: false,
  };
}

export function notEvaluatedIsNotCounterEvidence(view: GateAcceptanceView): boolean {
  return view.notEvaluatedIds.length > 0 && view.openIds.length === 0 && !view.conflict;
}

export function adjudicationDigest(projection: AdjudicationProjection): string {
  return createHash("sha256").update(canonicalJson(projection)).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
