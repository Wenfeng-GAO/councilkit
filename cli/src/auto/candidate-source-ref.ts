import { FULL_COMMIT_SHA } from "@shared/runtime/cli-ledger";
import {
  type FrozenIntegrateIdentity,
  type SquadBridgeFailureCode,
  type SquadJournalRefs,
  canRequestPublish,
  canonicalSha256,
} from "@shared/runtime/squad-bridge-contract";
import {
  type SquadPrProfile,
  headsRef,
  withPinnedCandidateSource,
} from "@shared/runtime/squad-pr-profile";
import { type RunCommand, defaultRunCommand } from "./checkout-pr";
import type { SquadBridgeDelivery } from "./squad-bridge";

const ZERO_OID = "0".repeat(40);
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const PRIVATE_REF_PREFIX = "refs/heads/councilkit/bridge/";
const GIT_TIMEOUT_MS = 15_000;

export type PinCandidateFailureReason =
  | "invalid-task-id"
  | "invalid-sha"
  | "invalid-ref"
  | "candidate-missing"
  | "candidate-not-commit"
  | "expected-old-missing"
  | "expected-old-not-commit"
  | "not-fast-forward"
  | "symbolic-ref"
  | "dangling-ref"
  | "ref-exists-with-different-value"
  | "create-failed";

export type PinCandidateResult =
  | { ok: true; ref: string; sha: string }
  | { ok: false; reason: PinCandidateFailureReason; message: string };

export interface BindPublishableCandidateResult {
  ok: true;
  profile: SquadPrProfile;
  profileHash: string;
  sourceRef: string;
}

export type BindPublishableCandidateFailure = {
  ok: false;
  code: SquadBridgeFailureCode;
  stage: string;
  message: string;
};

export function privateCandidateRef(taskId: string, candidateSha: string): string | null {
  if (!TASK_ID_RE.test(taskId) || !FULL_COMMIT_SHA.test(candidateSha)) return null;
  const ref = `${PRIVATE_REF_PREFIX}${taskId}/${candidateSha.toLowerCase()}`;
  if (ref.length > 11 + 200) return null;
  return ref;
}

export function isPrivateCandidateRef(ref: string): boolean {
  return (
    ref.startsWith(PRIVATE_REF_PREFIX) && /^refs\/heads\/(?!\/)[A-Za-z0-9._/\-]{1,200}$/.test(ref)
  );
}

export async function pinPrivateCandidateRef(input: {
  repo: string;
  taskId: string;
  candidateSha: string;
  expectedOldSha: string;
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
}): Promise<PinCandidateResult> {
  const run = input.runCommand ?? defaultRunCommand;
  const env = gitEnv(input.env ?? process.env);
  const candidateSha = input.candidateSha.toLowerCase();
  const expectedOldSha = input.expectedOldSha.toLowerCase();
  const ref = privateCandidateRef(input.taskId, candidateSha);
  if (!TASK_ID_RE.test(input.taskId) || !ref) {
    return fail("invalid-task-id", "controller task identity is not a usable private ref");
  }
  if (!FULL_COMMIT_SHA.test(candidateSha) || !FULL_COMMIT_SHA.test(expectedOldSha)) {
    return fail("invalid-sha", "candidate or expected-old SHA is not a full commit object name");
  }
  const format = await git(run, env, input.repo, ["check-ref-format", ref]);
  if (format.exitCode !== 0) {
    return fail("invalid-ref", "private candidate ref failed check-ref-format");
  }

  const candidateType = await objectTypeAtSha(run, env, input.repo, candidateSha);
  if (candidateType === null)
    return fail("candidate-missing", "candidate SHA is absent from the controller object database");
  if (candidateType !== "commit") {
    return fail(
      "candidate-not-commit",
      "candidate SHA exists but is not a commit at that exact name",
    );
  }
  const oldType = await objectTypeAtSha(run, env, input.repo, expectedOldSha);
  if (oldType === null) {
    return fail(
      "expected-old-missing",
      "expected-old SHA is absent from the controller object database",
    );
  }
  if (oldType !== "commit") {
    return fail("expected-old-not-commit", "expected-old SHA exists but is not a commit");
  }
  const ancestor = await git(run, env, input.repo, [
    "merge-base",
    "--is-ancestor",
    expectedOldSha,
    candidateSha,
  ]);
  if (ancestor.exitCode !== 0) {
    return fail("not-fast-forward", "expected-old is not an ancestor of the journal candidate");
  }

  const existing = await inspectLocalRef(run, env, input.repo, ref);
  if (existing.kind === "symbolic") {
    return fail(
      "symbolic-ref",
      "private candidate ref is symbolic; refusing to dereference into a user branch",
    );
  }
  if (existing.kind === "dangling") {
    return fail("dangling-ref", "private candidate ref is dangling");
  }
  if (existing.kind === "object") {
    if (existing.type !== "commit") {
      return fail(
        "ref-exists-with-different-value",
        "private candidate ref exists but is not a commit",
      );
    }
    if (existing.sha !== candidateSha) {
      return fail(
        "ref-exists-with-different-value",
        "private candidate ref already exists with a different value",
      );
    }
    return { ok: true, ref, sha: candidateSha };
  }

  const created = await git(run, env, input.repo, [
    "update-ref",
    "--no-deref",
    ref,
    candidateSha,
    ZERO_OID,
  ]);
  if (created.exitCode !== 0) {
    const raced = await inspectLocalRef(run, env, input.repo, ref);
    if (raced.kind === "object" && raced.type === "commit" && raced.sha === candidateSha) {
      return { ok: true, ref, sha: candidateSha };
    }
    return fail("create-failed", "atomic create of the private candidate ref failed");
  }
  const pinned = await inspectLocalRef(run, env, input.repo, ref);
  if (pinned.kind !== "object" || pinned.type !== "commit" || pinned.sha !== candidateSha) {
    return fail("create-failed", "private candidate ref did not resolve to the candidate commit");
  }
  return { ok: true, ref, sha: candidateSha };
}

export async function bindPublishableCandidateProfile(input: {
  event: { kind: string; journal: SquadJournalRefs };
  identity: FrozenIntegrateIdentity;
  delivery: SquadBridgeDelivery;
  frozenProfile: SquadPrProfile;
  workspaceCwd: string;
  taskId: string;
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
}): Promise<BindPublishableCandidateResult | BindPublishableCandidateFailure> {
  const candidateSha = input.identity.candidateSha.toLowerCase();
  if (
    !canRequestPublish(input.event) ||
    input.event.journal.candidateSha.toLowerCase() !== candidateSha
  ) {
    return {
      ok: false,
      code: "JOURNAL_GATES_INCOMPLETE",
      stage: "journal",
      message: "publishable journal does not bind the requested candidate SHA",
    };
  }
  const drifted = frozenIdentityDrift(input.frozenProfile, input.delivery, input.identity);
  if (drifted) {
    return { ok: false, code: "UNTRUSTED_RECEIPT", stage: "identity", message: drifted };
  }
  const pinned = await pinPrivateCandidateRef({
    repo: input.workspaceCwd,
    taskId: input.taskId,
    candidateSha,
    expectedOldSha: input.identity.expectedOldSha,
    runCommand: input.runCommand,
    env: input.env,
  });
  if (!pinned.ok) {
    return {
      ok: false,
      code: "UNTRUSTED_RECEIPT",
      stage: "pin-candidate",
      message: pinned.message,
    };
  }
  const profile = withPinnedCandidateSource(input.frozenProfile, {
    ref: pinned.ref,
    sha: pinned.sha,
  });
  return {
    ok: true,
    profile,
    profileHash: canonicalSha256(profile),
    sourceRef: pinned.ref,
  };
}

export function frozenIdentityDrift(
  profile: SquadPrProfile,
  delivery: SquadBridgeDelivery,
  identity: FrozenIntegrateIdentity,
): string | null {
  const sourceRef = headsRef(delivery.sourceBranch);
  const expectedOld = delivery.expectedOldSha.toLowerCase();
  const requestedOld = identity.expectedOldSha.toLowerCase();
  if (delivery.repo !== identity.repo)
    return "frozen repo does not match the requested publish identity";
  if (headsRef(identity.sourceBranch) !== sourceRef) {
    return "frozen source branch does not match the requested publish identity";
  }
  if (expectedOld !== requestedOld) {
    return "frozen expected-old SHA does not match the requested publish identity";
  }
  if (identity.remote && identity.remote !== delivery.remote) {
    return "frozen remote does not match the requested publish identity";
  }
  if (identity.remoteRef && identity.remoteRef !== sourceRef) {
    return "frozen target ref does not match the requested publish identity";
  }
  if (profile.integration.base_ref !== sourceRef) return "frozen integration.base_ref drifted";
  if (profile.integration.base_sha !== expectedOld) return "frozen integration.base_sha drifted";
  if (profile.integration.cas !== "expected-old-ref" || profile.integration.ff_only !== true) {
    return "frozen integration CAS/ff contract drifted";
  }
  if (profile.target.remote !== delivery.remote) return "frozen target.remote drifted";
  if (profile.target.ref !== sourceRef) return "frozen target.ref drifted";
  if (profile.target.sha !== expectedOld) return "frozen target.sha drifted";
  if (profile.target.conflict !== "none") return "frozen target.conflict drifted";
  if (profile.authorization.authority_ref !== delivery.grantHash.toLowerCase()) {
    return "frozen authorization grant drifted";
  }
  if (profile.authorization.push !== true || profile.authorization.pr_mutation !== false) {
    return "frozen authorization grant drifted";
  }
  if (profile.delivery.mode !== "source-branch-ready") return "frozen delivery mode drifted";
  return null;
}

function fail(reason: PinCandidateFailureReason, message: string): PinCandidateResult {
  return { ok: false, reason, message };
}

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const {
    GIT_DIR: _gitDir,
    GIT_WORK_TREE: _gitWorkTree,
    GIT_COMMON_DIR: _gitCommonDir,
    GIT_OBJECT_DIRECTORY: _gitObjectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: _gitAlternate,
    ...next
  } = env;
  return next;
}

async function git(
  run: RunCommand,
  env: NodeJS.ProcessEnv,
  cwd: string,
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return run({ executable: "git", argv, cwd, env, timeoutMs: GIT_TIMEOUT_MS });
}

async function objectTypeAtSha(
  run: RunCommand,
  env: NodeJS.ProcessEnv,
  repo: string,
  sha: string,
): Promise<string | null> {
  const parsed = await git(run, env, repo, ["rev-parse", "--verify", "--end-of-options", sha]);
  const resolved = parsed.stdout.trim().toLowerCase();
  if (parsed.exitCode !== 0 || resolved !== sha) return null;
  const typed = await git(run, env, repo, ["cat-file", "-t", sha]);
  if (typed.exitCode !== 0) return null;
  const kind = typed.stdout.trim();
  return kind.length > 0 ? kind : null;
}

async function inspectLocalRef(
  run: RunCommand,
  env: NodeJS.ProcessEnv,
  repo: string,
  ref: string,
): Promise<
  | { kind: "missing" }
  | { kind: "symbolic"; target: string }
  | { kind: "dangling"; sha: string }
  | { kind: "object"; sha: string; type: string }
> {
  const symbolic = await git(run, env, repo, ["symbolic-ref", "--quiet", "--", ref]);
  if (symbolic.exitCode === 0) {
    const target = symbolic.stdout.trim();
    return { kind: "symbolic", target };
  }
  const parsed = await git(run, env, repo, ["rev-parse", "--verify", "--end-of-options", ref]);
  const sha = parsed.stdout.trim().toLowerCase();
  if (parsed.exitCode !== 0 || !FULL_COMMIT_SHA.test(sha)) return { kind: "missing" };
  const confirmed = await objectTypeAtSha(run, env, repo, sha);
  if (confirmed === null) return { kind: "dangling", sha };
  return { kind: "object", sha, type: confirmed };
}
