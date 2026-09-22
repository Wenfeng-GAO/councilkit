import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@shared/runtime/digest";
import {
  type OfficialDeliveryAuthority,
  type OfficialGatePolicyFile,
  type OfficialGatePolicyFreeze,
  type RegisteredPolicyIntent,
  SUPERVISED_REVIEW_VERIFY_POLICY,
  hasSupervisedReviewerAndVerifier,
  hashOfficialGatePolicyFile,
  parseOfficialPolicyFreezeStdout,
  recoverOfficialPolicyFreeze,
} from "@shared/runtime/squad-gate-policy";
import {
  deliveryAuthorityFromProfile,
  deliveryAuthoritySchema,
  squadPrProfileSchema,
} from "@shared/runtime/squad-pr-profile";
import { errors } from "../errors";
import { atomicWriteJson, readFileText } from "../store/atomic-write";

export const CK_POLICY_FREEZE_FILE = "councilkit-policy-freeze.json";
export const CK_POLICY_INTENT_FILE = "councilkit-policy-intent.json";
export const CK_DELIVERY_AUTHORITY_FILE = "delivery-authority.json";
export const CK_PR_PROFILE_FILE = "councilkit-pr-profile.json";

export interface SquadctlExec {
  executable: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function defaultSupervisedPolicy(): OfficialGatePolicyFile {
  return structuredClone(SUPERVISED_REVIEW_VERIFY_POLICY);
}

/** Include delivery_authority only when the frozen profile and authority file match.
 * Missing or drifted files are omitted; this never invents a push grant. */
export function policyWithFrozenDelivery(taskDir: string): OfficialGatePolicyFile {
  const policy = defaultSupervisedPolicy();
  const authority = readMatchingFrozenDelivery(taskDir);
  if (!authority) return policy;
  return { ...policy, delivery_authority: authority };
}

export function readMatchingFrozenDelivery(taskDir: string): OfficialDeliveryAuthority | null {
  const authority = deliveryAuthoritySchema.safeParse(
    readJson(join(taskDir, CK_DELIVERY_AUTHORITY_FILE)),
  );
  const profile = squadPrProfileSchema.safeParse(readJson(join(taskDir, CK_PR_PROFILE_FILE)));
  if (!authority.success || !profile.success) return null;
  const derived = deliveryAuthorityFromProfile(profile.data);
  if (canonicalJson(derived) !== canonicalJson(authority.data)) return null;
  return {
    push: derived.push,
    pr_mutation: derived.pr_mutation,
    remote: derived.remote,
    target_ref: derived.target_ref,
    authority_ref: derived.authority_ref,
  };
}

export function writePolicyIntent(
  taskDir: string,
  policy: OfficialGatePolicyFile,
  extra?: { taskId?: string },
): { policyFile: string; policyFileHash: string } {
  if (!hasSupervisedReviewerAndVerifier(policy)) {
    throw errors.usage("gate policy must include supervised reviewer and verifier");
  }
  mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  const policyFile = join(taskDir, "councilkit-gate-policy.json");
  const body = `${JSON.stringify(policy, null, 2)}\n`;
  writeFileSync(policyFile, body, { encoding: "utf8", mode: 0o600 });
  const policyFileHash = hashOfficialGatePolicyFile(policy);
  atomicWriteJson(join(taskDir, CK_POLICY_INTENT_FILE), {
    taskId: extra?.taskId ?? null,
    policyFileHash,
    required_gates: policy.required_gates,
    independence: policy.independence,
    ...(policy.delivery_authority ? { delivery_authority: policy.delivery_authority } : {}),
  });
  return { policyFile, policyFileHash };
}

export function readRegisteredIntent(
  taskDir: string,
  taskId: string,
): RegisteredPolicyIntent | null {
  const parsed = readJson(join(taskDir, CK_POLICY_INTENT_FILE));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const policyFileHash = typeof row.policyFileHash === "string" ? row.policyFileHash : "";
  if (!/^[a-f0-9]{64}$/.test(policyFileHash)) return null;
  if (!Array.isArray(row.required_gates)) return null;
  if (
    row.independence === null ||
    typeof row.independence !== "object" ||
    Array.isArray(row.independence)
  ) {
    return null;
  }
  const recordedTaskId =
    typeof row.taskId === "string" && row.taskId.length > 0 ? row.taskId : null;
  if (recordedTaskId && recordedTaskId !== taskId) return null;
  const independence = row.independence as RegisteredPolicyIntent["independence"];
  const delivery =
    row.delivery_authority !== null &&
    typeof row.delivery_authority === "object" &&
    Array.isArray(row.delivery_authority) === false
      ? (row.delivery_authority as RegisteredPolicyIntent["delivery_authority"])
      : undefined;
  return {
    policyFileHash,
    taskId,
    taskDir,
    required_gates: row.required_gates as RegisteredPolicyIntent["required_gates"],
    independence,
    ...(delivery ? { delivery_authority: delivery } : {}),
  };
}

export function freezeOfficialGatePolicyWithSquadctl(input: {
  exec: SquadctlExec;
  taskDir: string;
  taskId: string;
  policy: OfficialGatePolicyFile;
  briefFile?: string;
  planFile?: string;
}): { ok: true; freeze: OfficialGatePolicyFreeze } | { ok: false; reason: string } {
  const recovered = recoverWrittenFreeze(input.taskDir, input.taskId, input.policy);
  if (recovered.ok) return recovered;
  const existingIntent = readRegisteredIntent(input.taskDir, input.taskId);
  if (existingIntent) {
    const callerHash = hashOfficialGatePolicyFile(input.policy);
    if (existingIntent.policyFileHash !== callerHash) {
      return {
        ok: false,
        reason: "registered intent does not match caller policy; will not rewrite intent",
      };
    }
  }
  if (readPersistedFreeze(input.taskDir) && !recovered.ok) return recovered;
  const planning = ensurePlanningFrozen(input);
  if (!planning.ok) return planning;
  const { policyFile, policyFileHash } = writePolicyIntent(input.taskDir, input.policy, {
    taskId: input.taskId,
  });
  const frozen = runSquadctl(input.exec, [
    "gate",
    "policy-freeze",
    "--task-dir",
    input.taskDir,
    "--policy-file",
    policyFile,
    "--json",
  ]);
  if (frozen.exitCode !== 0) {
    const recoveredAfterFail = recoverWrittenFreeze(input.taskDir, input.taskId, input.policy);
    if (recoveredAfterFail.ok) return recoveredAfterFail;
    return {
      ok: false,
      reason: `squadctl gate policy-freeze failed: ${frozen.stderr || frozen.stdout || `exit ${frozen.exitCode}`}`,
    };
  }
  const parsed = parseOfficialPolicyFreezeStdout(frozen.stdout, {
    taskId: input.taskId,
    taskDir: input.taskDir,
    policyFileHash,
    policy: input.policy,
  });
  if (!parsed.ok) return parsed;
  persistFreezeRecord(input.taskDir, parsed.freeze);
  return parsed;
}

export function recoverWrittenFreeze(
  taskDir: string,
  taskId: string,
  policy?: OfficialGatePolicyFile,
): { ok: true; freeze: OfficialGatePolicyFreeze } | { ok: false; reason: string } {
  const intent = readRegisteredIntent(taskDir, taskId);
  if (!intent) {
    return { ok: false, reason: "no registered policy intent" };
  }
  if (policy && hashOfficialGatePolicyFile(policy) !== intent.policyFileHash) {
    return { ok: false, reason: "caller policy is not the registered intent" };
  }
  const recorded = readJson(join(taskDir, CK_POLICY_FREEZE_FILE));
  const projection = readJson(join(taskDir, "gate-policy.json"));
  return recoverOfficialPolicyFreeze(recorded, projection, intent);
}

function ensurePlanningFrozen(input: {
  exec: SquadctlExec;
  taskDir: string;
  briefFile?: string;
  planFile?: string;
}): { ok: true } | { ok: false; reason: string } {
  const status = runSquadctl(input.exec, ["status", "--task-dir", input.taskDir, "--json"]);
  const view = parseJson(status.stdout);
  const briefHash =
    view && typeof view === "object" && !Array.isArray(view)
      ? (view as { brief_hash?: unknown }).brief_hash
      : null;
  if (typeof briefHash === "string" && /^[a-f0-9]{64}$/.test(briefHash)) {
    return { ok: true };
  }
  const briefFile = input.briefFile ?? join(input.taskDir, "brief.md");
  const planFile = input.planFile ?? join(input.taskDir, "plan.md");
  if (!existsSync(briefFile) || !existsSync(planFile)) {
    return { ok: false, reason: "brief.md and plan.md must exist before official planning freeze" };
  }
  const epoch =
    view && typeof view === "object" && !Array.isArray(view)
      ? Number((view as { epoch?: unknown }).epoch ?? 0)
      : 0;
  const frozen = runSquadctl(input.exec, [
    "planning",
    "freeze",
    "--task-dir",
    input.taskDir,
    "--brief-file",
    briefFile,
    "--plan-file",
    planFile,
    "--expected-epoch",
    String(Number.isFinite(epoch) ? epoch : 0),
    "--json",
  ]);
  if (frozen.exitCode !== 0) {
    return {
      ok: false,
      reason: `squadctl planning freeze failed: ${frozen.stderr || frozen.stdout || `exit ${frozen.exitCode}`}`,
    };
  }
  return { ok: true };
}

export function persistFreezeRecord(taskDir: string, freeze: OfficialGatePolicyFreeze): void {
  atomicWriteJson(join(taskDir, CK_POLICY_FREEZE_FILE), freeze);
}

export function readPersistedFreeze(taskDir: string): OfficialGatePolicyFreeze | null {
  const parsed = readJson(join(taskDir, CK_POLICY_FREEZE_FILE));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Partial<OfficialGatePolicyFreeze>;
  if (typeof row.policyHash !== "string" || !/^[a-f0-9]{64}$/.test(row.policyHash)) return null;
  return row as OfficialGatePolicyFreeze;
}

function runSquadctl(
  exec: SquadctlExec,
  argv: string[],
): { stdout: string; stderr: string; exitCode: number | null } {
  const result = spawnSync(exec.executable, argv, {
    cwd: exec.cwd,
    env: exec.env ?? process.env,
    encoding: "utf8",
    timeout: 30_000,
    shell: false,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status,
  };
}

function readJson(path: string): unknown {
  const text = readFileText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
