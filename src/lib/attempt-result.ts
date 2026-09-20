import {
  type CliRunAttemptResultResponse,
  cliRunAttemptResultResponseSchema,
} from "@shared/runtime/schemas";

/**
 * B1 durable per-execution result 的浏览器获取层。
 * RuntimeClient 没有该端点的包装，而 client.ts 是冻结边界，所以这里自持
 * 与 RuntimeClient.call(auth:"session") 等价的 fetch 逻辑：同源相对路径、
 * 同源 cookie、envelope + zod 校验，一处契约两边共用。
 */

export class AttemptResultError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AttemptResultError";
  }
}

export interface FetchAttemptResultInput {
  runId: string;
  attemptId: string;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

export async function fetchAttemptResult({
  runId,
  attemptId,
  signal,
  fetchFn = fetch,
}: FetchAttemptResultInput): Promise<CliRunAttemptResultResponse> {
  const path = `/api/v1/cli-runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(
    attemptId,
  )}/result`;
  const response = await fetchFn(path, {
    method: "GET",
    credentials: "same-origin",
    signal: signal ?? null,
  });
  const envelope = (await response.json()) as {
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  };
  if (!response.ok || !envelope.ok) {
    throw new AttemptResultError(
      response.status,
      envelope.error?.code ?? "UNKNOWN",
      envelope.error?.message ?? `HTTP ${response.status}`,
    );
  }
  return cliRunAttemptResultResponseSchema.parse(envelope.data);
}
