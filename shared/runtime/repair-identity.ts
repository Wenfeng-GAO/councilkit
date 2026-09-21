const FULL_SHA = /^[0-9a-f]{40}$/i;

export type KnownFact<T> = { status: "known"; value: T };
export type UnknownFact = { status: "unknown"; reason: string };
export type Fact<T> = KnownFact<T> | UnknownFact;

export function known<T>(value: T): KnownFact<T> {
  return { status: "known", value };
}

export function unknown(reason: string): UnknownFact {
  return { status: "unknown", reason };
}

export function isKnown<T>(fact: Fact<T>): fact is KnownFact<T> {
  return fact.status === "known";
}

export function fullSha(value: string | null | undefined): string | null {
  return typeof value === "string" && FULL_SHA.test(value) ? value.toLowerCase() : null;
}

export interface RepairIdentityFacts {
  sourceSha: Fact<string>;
  candidateSha: string;
  /** null = intentionally not published (local candidate stage). */
  publishedSha: Fact<string | null>;
  remoteHead: Fact<string | null>;
  baseUnchanged: Fact<boolean>;
  prOpen: Fact<boolean>;
  /** Explicit verification that the current remote already is this candidate. */
  adoptedExistingRemote: boolean;
}

export function sourceShaFact(value: string | null | undefined): Fact<string> {
  const sha = fullSha(value);
  return sha
    ? known(sha)
    : unknown(value ? "source sha is not a full commit" : "source sha missing");
}

export function publishedShaFact(
  value: string | null | undefined,
  opts?: { missingMeans: "unknown" | "unpublished" },
): Fact<string | null> {
  if (value === null || value === undefined || value === "") {
    return opts?.missingMeans === "unpublished" ? known(null) : unknown("publish receipt missing");
  }
  if (value === "unknown") return unknown("publish receipt unknown");
  const sha = fullSha(value);
  return sha ? known(sha) : unknown("publish receipt is not a full commit");
}

export function remoteHeadFact(value: string | null | undefined): Fact<string | null> {
  if (value === null || value === undefined || value === "") {
    return unknown("remote HEAD missing");
  }
  const sha = fullSha(value);
  return sha ? known(sha) : unknown("remote HEAD is not a full commit");
}

export function baseUnchangedFact(input: {
  frozenBaseSha?: string | null;
  observedBaseSha?: string | null;
  expectedBaseBranch?: string | null;
  observedBaseBranch?: string | null;
}): Fact<boolean> {
  if (input.expectedBaseBranch && input.observedBaseBranch === undefined) {
    return unknown("base branch not reported");
  }
  if (
    input.expectedBaseBranch &&
    input.observedBaseBranch &&
    input.expectedBaseBranch !== input.observedBaseBranch
  ) {
    return known(false);
  }
  const frozen = fullSha(input.frozenBaseSha ?? null);
  const observed = fullSha(input.observedBaseSha ?? null);
  if (frozen && observed === null) return unknown("observed base SHA missing");
  if (frozen && observed) return known(frozen === observed);
  if (!frozen && observed === null && !input.expectedBaseBranch) {
    return unknown("base identity not frozen");
  }
  return known(true);
}

export function prOpenFact(value: boolean | undefined | null): Fact<boolean> {
  if (value === undefined || value === null) return unknown("PR open state not reported");
  return known(value);
}

export function identityUnknownReasons(facts: RepairIdentityFacts): string[] {
  const reasons: string[] = [];
  if (!isKnown(facts.sourceSha)) reasons.push(`sourceSha:${facts.sourceSha.reason}`);
  if (!isKnown(facts.publishedSha)) reasons.push(`publishedSha:${facts.publishedSha.reason}`);
  if (!isKnown(facts.remoteHead)) reasons.push(`remoteHead:${facts.remoteHead.reason}`);
  if (!isKnown(facts.baseUnchanged)) reasons.push(`base:${facts.baseUnchanged.reason}`);
  if (!isKnown(facts.prOpen)) reasons.push(`prOpen:${facts.prOpen.reason}`);
  return reasons;
}
