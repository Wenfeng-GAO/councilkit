import { CSRF_HEADER_NAME } from "@shared/runtime/contracts";
import {
  type AckRequest,
  type AckResponse,
  type ClaudeRoute,
  type CliRunAttemptLiveResponse,
  type CliRunDetailResponse,
  type CliRunsListResponse,
  type CloseScopeResponse,
  type ControllerRequest,
  type CreateScopeRequest,
  type CreateScopeResponse,
  type DiagnosticsResponse,
  type ExecuteRequest,
  type ExecuteResponse,
  type ExecutionProfileDto,
  type ExecutionStatus,
  type HealthResponse,
  type InstallationDto,
  type InstallationsResponse,
  type ModelCatalogResponse,
  type ResolveProfileRequest,
  type ResolveProfileResponse,
  type ScopeStatus,
  type TakeoverControllerResponse,
  ackResponseSchema,
  cliRunAttemptLiveResponseSchema,
  cliRunDetailResponseSchema,
  cliRunsListResponseSchema,
  closeScopeResponseSchema,
  createScopeResponseSchema,
  diagnosticsResponseSchema,
  executeResponseSchema,
  executionStatusSchema,
  healthResponseSchema,
  installationDtoSchema,
  installationsResponseSchema,
  modelCatalogResponseSchema,
  resolveProfileResponseSchema,
  scopeStatusSchema,
  takeoverControllerResponseSchema,
} from "@shared/runtime/schemas";
import { z } from "zod";

/**
 * Runtime Client (U5): the browser's only channel to the Runtime Host.
 * Same-origin by default; mutations carry the injected CSRF capability
 * header and rely on the HttpOnly session cookie. Requests and responses are
 * validated with the same zod schemas the Host uses — one contract, both
 * sides.
 */

export interface RuntimeClientConfig {
  /** Origin of the Runtime Host; empty string = same origin (production). */
  baseUrl: string;
  /** CSRF capability from the bootstrap-injected meta tag. */
  csrfToken: string;
  /** Extra headers (tests inject the session cookie; browsers rely on it implicitly). */
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
}

/**
 * Shared optional request params for Host calls. `signal` aborts the HTTP
 * request itself (create/prewarm/execute/ACK...), not only the event-stream
 * reader. Trailing-only, so existing single-arg call sites stay compatible.
 */
export interface RuntimeRequestOptions {
  signal?: AbortSignal;
}

export class RuntimeClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeClientError";
  }
}

export class RuntimeClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: RuntimeClientConfig) {
    this.fetchFn = config.fetchFn ?? ((input, init) => fetch(input, init));
  }

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`;
  }

  private headers(kind: "session" | "mutation"): Record<string, string> {
    return {
      ...(kind === "mutation"
        ? { [CSRF_HEADER_NAME]: this.config.csrfToken, "Content-Type": "application/json" }
        : {}),
      ...(this.config.headers ?? {}),
    };
  }

  private async call<S extends z.ZodType>(
    method: string,
    path: string,
    options: { body?: unknown; schema: S; auth?: "session" | "mutation"; signal?: AbortSignal },
  ): Promise<z.infer<S>> {
    const auth = options.auth ?? "mutation";
    const response = await this.fetchFn(this.url(path), {
      method,
      headers: this.headers(auth),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal ?? null,
    });
    const envelope = (await response.json()) as {
      ok: boolean;
      data?: unknown;
      error?: { code: string; message: string };
    };
    if (!response.ok || !envelope.ok) {
      throw new RuntimeClientError(
        response.status,
        envelope.error?.code ?? "UNKNOWN",
        envelope.error?.message ?? `HTTP ${response.status}`,
      );
    }
    return options.schema.parse(envelope.data);
  }

  health(): Promise<HealthResponse> {
    return this.call("GET", "/api/v1/health", { schema: healthResponseSchema, auth: "session" });
  }

  /** S6: sanitized same-machine diagnostics bundle (session read; Settings is
   * the only consumer). The schema parse runs before the page serializes the
   * data into the downloaded file — validation and download are two steps. */
  diagnostics(): Promise<DiagnosticsResponse> {
    return this.call("GET", "/api/v1/diagnostics", {
      schema: diagnosticsResponseSchema,
      auth: "session",
    });
  }

  listCliRuns(): Promise<CliRunsListResponse> {
    return this.call("GET", "/api/v1/cli-runs", {
      schema: cliRunsListResponseSchema,
      auth: "session",
    });
  }

  getCliRun(runId: string): Promise<CliRunDetailResponse> {
    return this.call("GET", `/api/v1/cli-runs/${encodeURIComponent(runId)}`, {
      schema: cliRunDetailResponseSchema,
      auth: "session",
    });
  }

  getCliRunAttemptLive(
    runId: string,
    attemptId: string,
    afterSeq = 0,
  ): Promise<CliRunAttemptLiveResponse> {
    const query = new URLSearchParams({ afterSeq: String(afterSeq) });
    return this.call(
      "GET",
      `/api/v1/cli-runs/${encodeURIComponent(runId)}/attempts/${encodeURIComponent(attemptId)}/live?${query}`,
      { schema: cliRunAttemptLiveResponseSchema, auth: "session" },
    );
  }

  listInstallations(): Promise<InstallationsResponse> {
    return this.call("GET", "/api/v1/installations", {
      schema: installationsResponseSchema,
      auth: "session",
    });
  }

  /** Revalidation is read-only metadata work on the Host: session-level auth,
   * no CSRF mutation header. */
  revalidateInstallation(installationId: string): Promise<InstallationDto> {
    return this.call("POST", `/api/v1/installations/${installationId}/revalidate`, {
      schema: installationDtoSchema,
      auth: "session",
    });
  }

  profileReadiness(
    profile: ExecutionProfileDto,
    modelId: string,
    options?: { refresh?: boolean },
  ): Promise<ResolveProfileResponse> {
    const body: ResolveProfileRequest = { profile, modelId };
    const path = options?.refresh
      ? "/api/v1/profiles/readiness?refresh=1"
      : "/api/v1/profiles/readiness";
    return this.call("POST", path, {
      body,
      schema: resolveProfileResponseSchema,
    });
  }

  /** Closed canonical model catalog of a Driver + trusted Installation
   * (session-authenticated read; Settings is the only consumer). The claude
   * catalog is route-specific — pass the profile's `route` there. `refresh`
   * bypasses the Host probe cache (S5). */
  modelCatalog(
    driverId: string,
    installationId: string,
    options?: { route?: ClaudeRoute; refresh?: boolean },
  ): Promise<ModelCatalogResponse> {
    const params = new URLSearchParams({ driverId, installationId });
    if (options?.route) params.set("route", options.route);
    if (options?.refresh) params.set("refresh", "1");
    return this.call("GET", `/api/v1/models/catalog?${params.toString()}`, {
      schema: modelCatalogResponseSchema,
      auth: "session",
    });
  }

  createScope(
    request: CreateScopeRequest,
    options?: RuntimeRequestOptions,
  ): Promise<CreateScopeResponse> {
    return this.call("POST", "/api/v1/scopes", {
      body: request,
      schema: createScopeResponseSchema,
      signal: options?.signal,
    });
  }

  getScopeStatus(scopeId: string, options?: RuntimeRequestOptions): Promise<ScopeStatus> {
    return this.call("GET", `/api/v1/scopes/${scopeId}`, {
      schema: scopeStatusSchema,
      auth: "session",
      signal: options?.signal,
    });
  }

  activateScope(
    scopeId: string,
    controller: ControllerRequest,
    options?: RuntimeRequestOptions,
  ): Promise<ScopeStatus> {
    return this.call("POST", `/api/v1/scopes/${scopeId}/activate`, {
      body: controller,
      schema: scopeStatusSchema,
      signal: options?.signal,
    });
  }

  takeoverScope(scopeId: string, controllerId: string): Promise<TakeoverControllerResponse> {
    return this.call("POST", `/api/v1/scopes/${scopeId}/controller`, {
      body: { controllerId },
      schema: takeoverControllerResponseSchema,
    });
  }

  execute(
    scopeId: string,
    request: ExecuteRequest,
    options?: RuntimeRequestOptions,
  ): Promise<ExecuteResponse> {
    return this.call("POST", `/api/v1/scopes/${scopeId}/executions`, {
      body: request,
      schema: executeResponseSchema,
      signal: options?.signal,
    });
  }

  getExecution(
    scopeId: string,
    executionId: string,
    options?: RuntimeRequestOptions,
  ): Promise<ExecutionStatus> {
    return this.call("GET", `/api/v1/scopes/${scopeId}/executions/${executionId}`, {
      schema: executionStatusSchema,
      auth: "session",
      signal: options?.signal,
    });
  }

  ack(
    scopeId: string,
    executionId: string,
    request: AckRequest,
    options?: RuntimeRequestOptions,
  ): Promise<AckResponse> {
    return this.call("POST", `/api/v1/scopes/${scopeId}/executions/${executionId}/ack`, {
      body: request,
      schema: ackResponseSchema,
      signal: options?.signal,
    });
  }

  async cancelExecution(
    scopeId: string,
    executionId: string,
    controller: ControllerRequest,
    options?: RuntimeRequestOptions,
  ) {
    await this.call("POST", `/api/v1/scopes/${scopeId}/executions/${executionId}/cancel`, {
      body: controller,
      schema: z.object({ executionId: z.string(), state: z.string() }),
      signal: options?.signal,
    });
  }

  closeScope(
    scopeId: string,
    controller: ControllerRequest,
    options?: RuntimeRequestOptions,
  ): Promise<CloseScopeResponse> {
    return this.call("POST", `/api/v1/scopes/${scopeId}/close`, {
      body: controller,
      schema: closeScopeResponseSchema,
      signal: options?.signal,
    });
  }

  /** Raw authenticated fetch for the SSE event stream (no JSON envelope). */
  eventStreamFetch(input: { scopeId: string; executionId: string; afterSeq: number }): {
    url: string;
    headers: Record<string, string>;
  } {
    return {
      url: this.url(
        `/api/v1/scopes/${input.scopeId}/executions/${input.executionId}/events?afterSeq=${input.afterSeq}`,
      ),
      headers: { ...this.headers("session"), Accept: "text/event-stream" },
    };
  }
}
