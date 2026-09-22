/** Shared fixture identity locked by TEST-ANALYSIS §3. */

export const PARENT_RUN_ID = "ck-repair-00000000-0000-4000-8000-000000000128";
export const SOURCE_REVIEW_ID = "ck-review-00000000-0000-4000-8000-000000000100";
export const CHILD_REVIEW_ID = "ck-review-00000000-0000-4000-8000-000000000200";
export const SQUAD_RUN_ID = "ck-squad-00000000-0000-4000-8000-000000000300";
export const REVIEW_RUN_ID = "ck-review-00000000-0000-4000-8000-0000000000e2";

export const T0_ISO = "2026-09-22T06:00:00.000Z";
export const T0_MS = Date.parse(T0_ISO);

export const GOAL = "停机中断后恢复会话，并支持安全重试";
export const PR_URL = "https://example.test/acme/repo/pull/42";
export const REPO = "example.test/acme/repo";

export const CANDIDATE_C = "c".repeat(40);
export const BASE_B = "b".repeat(40);
export const OLD_CANDIDATE_A = "a".repeat(40);

export const CURRENT_ROUND = 2;
export const SOURCE_FIX_USED = 2;
export const SOURCE_FIX_MAX = 3;

export const TASK_ID_ROUND1 = "squad-task-round-1";
export const TASK_ID_ROUND2 = "squad-task-round-2";
export const SESSION_BUILDER = "B1";
export const SESSION_REVIEWER = "R1";
export const SESSION_VERIFIER = "V1";

export const EXEC_BUILDER = "exec-builder-shared-b1";
export const EXEC_REVIEWER = "exec-reviewer-r1";
export const EXEC_VERIFIER = "exec-verifier-v1";
export const EXEC_BUILDER_E1 = "exec-builder-e1";
export const EXEC_BUILDER_E2 = "exec-builder-e2";

export const PORT = 43837;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const HOST_HEADER = `127.0.0.1:${PORT}`;

export const TEST_API = "/api/v1/__test__/repair-observation";

export const SECRET_SENTINEL = "SECRET_SENTINEL_ck_e2e_repair_obs_9f3a";
export const PATH_SENTINEL = "PATH_SENTINEL_should_never_leak";
export const XSS_PAYLOAD = '<script>window.__xss_fired=1</script><img src=x onerror="fetch(\'https://evil.example/x\')">';

export type FixtureName =
  | "F0"
  | "F1"
  | "F2"
  | "F3"
  | "F3b"
  | "F4"
  | "F5"
  | "F5b-recoverable"
  | "F5b-budget"
  | "F5b-unknown"
  | "F6"
  | "F6a"
  | "F6b"
  | "F7"
  | "F8"
  | "F8-secret"
  | "F8-private"
  | "F8-xss"
  | "F8-path"
  | "F9"
  | "F-legacy"
  | "F-legacy-empty"
  | "F-child-review"
  | "F-review"
  | "F-squad";
