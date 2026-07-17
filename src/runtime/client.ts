import { CSRF_HEADER_NAME } from "@shared/runtime/contracts";
import {
  type AckRequest,
  type AckResponse,
  type CloseScopeResponse,
  type ControllerRequest,
  type CreateScopeRequest,
  type CreateScopeResponse,
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
  closeScopeResponseSchema,
  createScopeResponseSchema,
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
    this.fetchFn = config.fetchFn ?? fetch;
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
    options: { body?: unknown; schema: S; auth?: "session" | "mutation" },
  ): Promise<z.infer<S>> {
    const auth = options.auth ?? "mutation";
    const response = await this.fetchFn(this.url(path), {
      method,
      headers: this.headers(auth),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

  profileReadiness(profile: ExecutionProfileDto, modelId: string): Promise<ResolveProfileResponse> {
    const body: ResolveProfileRequest = { profile, modelId };
    return this.call("POST", "/api/v1/profiles/readiness", {
      body,
      schema: resolveProfileResponseSchema,
    });
  }

  /** Closed canonical model catalog of a Driver + trusted Installation
   * (session-authenticated read; Settings is the only consumer). */
  modelCatalog(driverId: string, installationId: string): Promise<ModelCatalogResponse> {
    const params = new URLSearchParams({ driverId, installationId });
    return this.call("GET", `/api/v1/models/catalog?${params.toString()}`, {
      schema: modelCatalogResponseSchema,
      auth: "session",
    });
  }

  createScope(request: CreateScopeRequest): Promise<CreateScopeResponse> {
    return this.call("POST", "/api/v1/scopes", {
      body: request,
      schema: createScopeResponseSchema,
    });
  }

  getScopeStatus(scopeId: string): Promise<ScopeStatus> {
    return this.call("GET", `/api/v1/scopes/${scopeId}`, {
      schema: scopeStatusSchema,
      auth: "session",
    });
  }

  activateScope(scopeId: string, controller: ControllerRequest): Promise<ScopeStatus> {
    return this.call("POST", `/api/v1/scopes/${scopeId}/activate`, {
      body: controller,
      schema: scopeStatusSchema,
    });
  }

  takeoverScope(scopeId: string, controllerId: string): Promise<TakeoverControllerResponse> {
    return this.call("POST", `/api/v1/scopes/${scopeId}/controller`, {
      body: { controllerId },
      schema: takeoverControllerResponseSchema,
    });
  }

  execute(scopeId: string, request: ExecuteRequest): Promise<ExecuteResponse> {
    return this.call("POST", `/api/v1/scopes/${scopeId}/executions`, {
      body: request,
      schema: executeResponseSchema,
    });
  }

  getExecution(scopeId: string, executionId: string): Promise<ExecutionStatus> {
    return this.call("GET", `/api/v1/scopes/${scopeId}/executions/${executionId}`, {
      schema: executionStatusSchema,
      auth: "session",
    });
  }

  ack(scopeId: string, executionId: string, request: AckRequest): Promise<AckResponse> {
    return this.call("POST", `/api/v1/scopes/${scopeId}/executions/${executionId}/ack`, {
      body: request,
      schema: ackResponseSchema,
    });
  }

  async cancelExecution(scopeId: string, executionId: string, controller: ControllerRequest) {
    await this.call("POST", `/api/v1/scopes/${scopeId}/executions/${executionId}/cancel`, {
      body: controller,
      schema: z.object({ executionId: z.string(), state: z.string() }),
    });
  }

  closeScope(scopeId: string, controller: ControllerRequest): Promise<CloseScopeResponse> {
    return this.call("POST", `/api/v1/scopes/${scopeId}/close`, {
      body: controller,
      schema: closeScopeResponseSchema,
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
