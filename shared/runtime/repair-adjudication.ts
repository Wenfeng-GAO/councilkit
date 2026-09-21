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
  return ingestAdjudication({ ...input, prior: null });
}

/** Persist-and-merge: raw reports append observations; frozen assertions are not rewritten. */
export function ingestAdjudication(input: {
  prior: AdjudicationProjection | null;
  sourceRunId: string;
  candidateSha: string;
  findings: LedgerFinding[];
  findingGroups?: FindingGroupsFile | null;
  kinds?: Partial<Record<string, AdjudicationKind>>;
  aliases?: Array<{ fromId: string; toId: string; evidence: string }>;
  falsified?: Array<{ findingId: string; evidence: string }>;
  outOfScope?: Array<{ findingId: string; blocking: boolean; evidence: string }>;
}): AdjudicationProjection {
  const fromGroups = adjudicationInputsFromGroups(input.findingGroups);
  const aliasMap = new Map(
    [...fromGroups.aliases, ...(input.aliases ?? [])].map((row) => [row.fromId, row]),
  );
  const falsifiedMap = new Map(
    [...fromGroups.falsified, ...(input.falsified ?? [])].map((row) => [row.findingId, row]),
  );
  const outOfScopeMap = new Map((input.outOfScope ?? []).map((row) => [row.findingId, row]));
  const items: AdjudicatedItem[] = [];
  const rawFindingIds = unique([
    ...(input.prior?.rawFindingIds ?? []),
    ...input.findings.map((row) => row.id),
  ]);
  const mapped = new Set<string>();
  const rootCauses = new Set<string>();
  const priorByFinding = new Map<string, AdjudicatedItem[]>();
  for (const item of input.prior?.items ?? []) {
    const list = priorByFinding.get(item.assertion.sourceFindingId) ?? [];
    list.push(item);
    priorByFinding.set(item.assertion.sourceFindingId, list);
  }

  for (const priorItems of priorByFinding.values()) {
    items.push(...priorItems);
    for (const item of priorItems) {
      mapped.add(item.assertion.sourceFindingId);
      rootCauses.add(item.rootCauseId);
    }
  }

  for (const row of input.findings) {
    const priorItems = priorByFinding.get(row.id) ?? [];
    const latest = priorItems[priorItems.length - 1];
    const meaning = assertionMeaning(row);
    if (latest) {
      if (latest.assertion.invariant !== meaning.invariant) {
        const nextVersion =
          Math.max(...priorItems.map((item) => item.assertion.assertionVersion)) + 1;
        const added = itemFromFinding({
          row,
          candidateSha: input.candidateSha,
          version: nextVersion,
          kind: "evidence_conflict",
          findingGroups: input.findingGroups,
          alias: aliasMap.get(row.id),
          falsified: falsifiedMap.get(row.id),
          scoped: outOfScopeMap.get(row.id),
          kinds: input.kinds,
        });
        added.relatedAssertionIds = [latest.assertion.assertionId];
        items.push(added);
        mapped.add(row.id);
        rootCauses.add(added.rootCauseId);
      } else {
        const refreshed = itemFromFinding({
          row,
          candidateSha: input.candidateSha,
          version: latest.assertion.assertionVersion,
          kind: latest.kind,
          findingGroups: input.findingGroups,
          alias: aliasMap.get(row.id),
          falsified: falsifiedMap.get(row.id),
          scoped: outOfScopeMap.get(row.id),
          kinds: input.kinds,
        });
        refreshed.assertion = latest.assertion;
        const idx = items.findIndex(
          (item) => item.assertion.assertionId === latest.assertion.assertionId,
        );
        if (idx >= 0) items[idx] = refreshed;
      }
      continue;
    }
    const added = itemFromFinding({
      row,
      candidateSha: input.candidateSha,
      version: 1,
      kind: input.kinds?.[row.id] ?? "in_scope_omission",
      findingGroups: input.findingGroups,
      alias: aliasMap.get(row.id),
      falsified: falsifiedMap.get(row.id),
      scoped: outOfScopeMap.get(row.id),
      kinds: input.kinds,
    });
    items.push(added);
    mapped.add(row.id);
    if (added.disposition !== "aliased") rootCauses.add(added.rootCauseId);
  }

  const uncoveredSourceIds = rawFindingIds.filter((id) => !mapped.has(id));
  return {
    version: (input.prior?.version ?? 0) + 1,
    sourceRunId: input.sourceRunId,
    candidateSha: input.candidateSha,
    items,
    rawFindingIds,
    uncoveredSourceIds,
    rootCauseIds: [...new Set([...rootCauses, ...(input.prior?.rootCauseIds ?? [])])],
  };
}

function assertionMeaning(row: LedgerFinding): { invariant: string; trigger: string } {
  return { invariant: row.title, trigger: row.text || row.title };
}

function itemFromFinding(input: {
  row: LedgerFinding;
  candidateSha: string;
  version: number;
  kind: AdjudicationKind;
  findingGroups?: FindingGroupsFile | null;
  alias?: { fromId: string; toId: string; evidence: string };
  falsified?: { findingId: string; evidence: string };
  scoped?: { findingId: string; blocking: boolean; evidence: string };
  kinds?: Partial<Record<string, AdjudicationKind>>;
}): AdjudicatedItem {
  const meaning = assertionMeaning(input.row);
  const assertion: ImmutableAssertion = {
    assertionId: assertionIdFor(input.row.id, input.version),
    assertionVersion: input.version,
    sourceFindingId: input.row.id,
    candidateSha: input.candidateSha,
    invariant: meaning.invariant,
    trigger: meaning.trigger,
    expectedTerminal: "defect absent on candidate",
    evidenceRef: input.row.verification?.evidence ?? input.row.text ?? input.row.title,
  };
  if (input.alias) {
    return {
      assertion,
      kind: "duplicate_alias",
      disposition: "aliased",
      rootCauseId: resolveRootCause(input.alias.toId, input.findingGroups),
      aliasOf: input.alias.toId,
      requiredResponsibility: false,
      blocking: false,
      relatedAssertionIds: [assertionIdFor(input.alias.toId, 1)],
      evidence: input.alias.evidence,
    };
  }
  if (input.falsified) {
    return {
      assertion,
      kind: input.kinds?.[input.row.id] ?? "unverified_hypothesis",
      disposition: "falsified",
      rootCauseId: resolveRootCause(input.row.id, input.findingGroups),
      aliasOf: null,
      requiredResponsibility: true,
      blocking: false,
      relatedAssertionIds: [],
      evidence: input.falsified.evidence,
    };
  }
  if (input.scoped) {
    return {
      assertion,
      kind: "out_of_scope",
      disposition: input.scoped.blocking ? "out_of_scope_blocking" : "out_of_scope_recorded",
      rootCauseId: resolveRootCause(input.row.id, input.findingGroups),
      aliasOf: null,
      requiredResponsibility: input.scoped.blocking,
      blocking: input.scoped.blocking,
      relatedAssertionIds: [],
      evidence: input.scoped.evidence,
    };
  }
  const accepted = input.row.status === "accepted" && Boolean(input.row.acceptedReason?.trim());
  const verified = isFindingVerifiedClosed(input.row, input.candidateSha);
  const notEvaluated = input.row.verification?.outcome === "not_evaluated";
  const required =
    input.row.reviewer !== null &&
    input.row.reviewer !== undefined &&
    input.row.reviewer.length > 0;
  let disposition: AcceptanceDisposition;
  if (verified) disposition = "verified_closed";
  else if (accepted) disposition = "accepted_with_reason";
  else if (notEvaluated && required) disposition = "coverage_gap";
  else if (notEvaluated) disposition = "not_evaluated";
  else disposition = "still_open";
  return {
    assertion,
    kind: input.kind,
    disposition,
    rootCauseId: resolveRootCause(input.row.id, input.findingGroups),
    aliasOf: null,
    requiredResponsibility: required || BLOCKING_SEVERITY.has(input.row.severity),
    blocking:
      BLOCKING_SEVERITY.has(input.row.severity) && disposition !== "verified_closed" && !accepted,
    relatedAssertionIds: [],
    evidence: input.row.verification?.evidence ?? input.row.text ?? input.row.title,
  };
}

export function adjudicationInputsFromGroups(groups: FindingGroupsFile | null | undefined): {
  aliases: Array<{ fromId: string; toId: string; evidence: string }>;
  falsified: Array<{ findingId: string; evidence: string }>;
} {
  const aliases: Array<{ fromId: string; toId: string; evidence: string }> = [];
  const falsified: Array<{ findingId: string; evidence: string }> = [];
  if (!groups) return { aliases, falsified };
  for (const group of groups.groups) {
    for (const alias of group.aliases) {
      aliases.push({ fromId: alias, toId: group.rootCauseId, evidence: group.basis });
    }
    for (const id of group.findingIds) {
      if (id !== group.rootCauseId) {
        aliases.push({ fromId: id, toId: group.rootCauseId, evidence: group.basis });
      }
    }
    if (group.adjudication?.kind === "unsupported" || group.adjudication?.kind === "dismissed") {
      for (const id of group.findingIds) {
        falsified.push({ findingId: id, evidence: group.adjudication.reason });
      }
    }
  }
  return { aliases, falsified };
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
