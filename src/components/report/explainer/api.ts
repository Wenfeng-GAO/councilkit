import { readCsrfToken } from "@/runtime/bootstrap";
import { CSRF_HEADER_NAME } from "@shared/runtime/contracts";
import type {
  DecisionsFile,
  ExplanationResult,
  FindingDecision,
  FrozenFileContent,
  ReviewExplainerWorkspace,
} from "@shared/runtime/review-explainer/contracts";

export class ExplainerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal: options.signal,
    headers:
      method === "POST"
        ? { [CSRF_HEADER_NAME]: readCsrfToken(), "Content-Type": "application/json" }
        : undefined,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    data?: T;
    error?: { code?: string; message?: string };
  } | null;
  if (!response.ok || body?.ok !== true || body.data === undefined) {
    throw new ExplainerRequestError(
      response.status,
      body?.error?.code ?? "INVALID_RESPONSE",
      body?.error?.message ?? `读取失败（HTTP ${response.status}）`,
    );
  }
  return body.data;
}

function base(runId: string) {
  return `/api/v1/cli-runs/${encodeURIComponent(runId)}/review-explainer`;
}

export const explainerApi = {
  workspace: (runId: string, signal?: AbortSignal) =>
    request<ReviewExplainerWorkspace>(base(runId), { signal }),
  decide: (runId: string, findingId: string, decision: FindingDecision, expectedRevision: number) =>
    request<DecisionsFile>(`${base(runId)}/decisions`, {
      method: "POST",
      body: { findingId, decision, expectedRevision },
    }),
  file: (runId: string, path: string, side: "old" | "new") =>
    request<FrozenFileContent>(`${base(runId)}/files/${encodeURIComponent(path)}?side=${side}`),
  explanation: (runId: string, findingId: string, generate = false) =>
    request<ExplanationResult>(
      `${base(runId)}/explanations/${encodeURIComponent(findingId)}`,
      generate ? { method: "POST", body: {} } : {},
    ),
  repairPackage: (runId: string) => request<unknown>(`${base(runId)}/repair-package`),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}
