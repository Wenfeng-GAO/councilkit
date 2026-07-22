/**
 * HostClient — the CLI's channel to the Runtime Host (brief §2c, D1 §1).
 *
 * Rather than reimplement the wire protocol, this reuses the browser's verified
 * `RuntimeClient` (src/runtime/client.ts): one contract, both sides. The CLI
 * layer adds only (a) in-memory cookie/CSRF provisioning from `AuthClient` and
 * (b) a single bounded retry: on a definitive auth rejection (401/403 / CSRF /
 * stale-controller) it re-extracts credentials once and replays the request.
 *
 * Per plan-a §4, network/5xx/parse errors are NEVER auto-retried here — a 5xx on
 * a mutation is ambiguous (it may have landed) and is handled by execute-turn's
 * ambiguous-dispatch probe instead. Replaying only auth rejections means the
 * retry can never duplicate a dispatched model call (a 401 means rejected before
 * dispatch).
 */
import { RuntimeClient, RuntimeClientError, type RuntimeRequestOptions } from "@/runtime/client";
import { CANONICAL_ORIGIN } from "@shared/runtime/contracts";
import type {
  AckRequest,
  AckResponse,
  ClaudeRoute,
  CloseScopeResponse,
  ControllerRequest,
  CreateScopeRequest,
  CreateScopeResponse,
  DiagnosticsResponse,
  ExecuteRequest,
  ExecuteResponse,
  ExecutionProfileDto,
  ExecutionStatus,
  HealthResponse,
  InstallationsResponse,
  ModelCatalogResponse,
  ResolveProfileResponse,
  ScopeStatus,
} from "@shared/runtime/schemas";
import { AuthClient, type AuthFetchOptions, type HostAuth, mutationHeaders } from "./auth";

const AUTH_CODES = new Set(["UNAUTHENTICATED", "FORBIDDEN", "CSRF_MISMATCH", "STALE_CONTROLLER"]);

export interface HostClientOptions extends AuthFetchOptions {
  baseUrl?: string;
}

export class HostClient {
  private readonly auth: AuthClient;
  private readonly baseUrl: string;
  private rt: RuntimeClient | null = null;

  constructor(opts: HostClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? CANONICAL_ORIGIN;
    this.auth = new AuthClient(this.baseUrl, opts);
  }

  /** Current credentials (in-memory only); extracts on first use. */
  async authSnapshot(opts?: AuthFetchOptions): Promise<HostAuth> {
    return this.auth.get(opts);
  }

  /** Force a fresh extraction (e.g. after an SSE reports 401). */
  async refreshAuth(opts?: AuthFetchOptions): Promise<HostAuth> {
    const auth = await this.auth.refresh(opts);
    // Discard the built client so the next request rebuilds with new creds.
    this.rt = null;
    return auth;
  }

  private async client(signal?: AbortSignal): Promise<RuntimeClient> {
    if (this.rt !== null) return this.rt;
    const auth = await this.auth.get(signal ? { signal } : undefined);
    this.rt = new RuntimeClient({
      baseUrl: this.baseUrl,
      csrfToken: auth.csrfToken,
      headers: { Cookie: auth.cookie, Origin: CANONICAL_ORIGIN },
    });
    return this.rt;
  }

  /** Wrap a single Host call: on a definitive auth rejection, refresh once and
   * replay. Any other failure propagates unchanged.
   *
   * G3: the caller's `options.signal` (e.g. the run-level shared cleanup signal)
   * is threaded into the cold-rebuild auth extraction and combined with the
   * auth timeout, and re-checked before replaying — so a 401 at the end of a
   * cleanup budget cannot trigger an independent ~8s auth wait that out-lasts
   * the budget. */
  private async withAuthRetry<T>(
    fn: (c: RuntimeClient) => Promise<T>,
    options?: RuntimeRequestOptions,
  ): Promise<T> {
    const signal = options?.signal;
    try {
      return await fn(await this.client(signal));
    } catch (error) {
      if (!isAuthRejection(error)) throw error;
      // G3: before cold-rebuilding, bail if the caller already aborted — there
      // is no budget left for a fresh GET / + replay.
      if (signal?.aborted) {
        const err = new Error("aborted before auth cold-rebuild");
        err.name = "AbortError";
        throw err;
      }
      // Re-extract once, then rebuild + replay.
      this.rt = null;
      this.auth.invalidate();
      return fn(await this.client(signal));
    }
  }

  /** Direct access to the underlying RuntimeClient + current auth, for SSE
   * (eventStreamFetch returns {url, headers}; the actual fetch happens in the
   * event-stream reader). The caller rebuilds the fetch input after an auth
   * refresh via `refreshAuthForStream()`. */
  async rawClient(): Promise<RuntimeClient> {
    return this.client();
  }

  async refreshAuthForStream(
    signal?: AbortSignal,
  ): Promise<{ cookie: string; csrfToken: string; origin: string }> {
    // H3: thread the caller's bounded signal (the turn deadline / shared cleanup
    // signal) into the cold-rebuild so a SIGINT during the auth GET / aborts it
    // within the shared budget rather than waiting out the auth's own 8s
    // timeout. AuthClient.extract already combines this signal with its timeout
    // (G3).
    const auth = await this.refreshAuth(signal ? { signal } : undefined);
    return { cookie: auth.cookie, csrfToken: auth.csrfToken, origin: CANONICAL_ORIGIN };
  }

  // ----- delegated surface (each wrapped for one auth retry) ----------------

  health(): Promise<HealthResponse> {
    return this.withAuthRetry((c) => c.health());
  }

  diagnostics(): Promise<DiagnosticsResponse> {
    return this.withAuthRetry((c) => c.diagnostics());
  }

  listInstallations(): Promise<InstallationsResponse> {
    return this.withAuthRetry((c) => c.listInstallations());
  }

  modelCatalog(
    driverId: string,
    installationId: string,
    options?: { route?: ClaudeRoute; refresh?: boolean },
  ): Promise<ModelCatalogResponse> {
    return this.withAuthRetry((c) => c.modelCatalog(driverId, installationId, options));
  }

  profileReadiness(
    profile: ExecutionProfileDto,
    modelId: string,
    options?: { refresh?: boolean },
  ): Promise<ResolveProfileResponse> {
    return this.withAuthRetry((c) => c.profileReadiness(profile, modelId, options));
  }

  createScope(
    request: CreateScopeRequest,
    options?: RuntimeRequestOptions,
  ): Promise<CreateScopeResponse> {
    return this.withAuthRetry((c) => c.createScope(request, options), options);
  }

  getScopeStatus(scopeId: string, options?: RuntimeRequestOptions): Promise<ScopeStatus> {
    return this.withAuthRetry((c) => c.getScopeStatus(scopeId, options), options);
  }

  activateScope(
    scopeId: string,
    controller: ControllerRequest,
    options?: RuntimeRequestOptions,
  ): Promise<ScopeStatus> {
    return this.withAuthRetry((c) => c.activateScope(scopeId, controller, options), options);
  }

  execute(
    scopeId: string,
    request: ExecuteRequest,
    options?: RuntimeRequestOptions,
  ): Promise<ExecuteResponse> {
    return this.withAuthRetry((c) => c.execute(scopeId, request, options), options);
  }

  getExecution(
    scopeId: string,
    executionId: string,
    options?: RuntimeRequestOptions,
  ): Promise<ExecutionStatus> {
    return this.withAuthRetry((c) => c.getExecution(scopeId, executionId, options), options);
  }

  ack(
    scopeId: string,
    executionId: string,
    request: AckRequest,
    options?: RuntimeRequestOptions,
  ): Promise<AckResponse> {
    return this.withAuthRetry((c) => c.ack(scopeId, executionId, request, options), options);
  }

  cancelExecution(
    scopeId: string,
    executionId: string,
    controller: ControllerRequest,
    options?: RuntimeRequestOptions,
  ): Promise<void> {
    return this.withAuthRetry(
      (c) => c.cancelExecution(scopeId, executionId, controller, options),
      options,
    );
  }

  closeScope(
    scopeId: string,
    controller: ControllerRequest,
    options?: RuntimeRequestOptions,
  ): Promise<CloseScopeResponse> {
    return this.withAuthRetry((c) => c.closeScope(scopeId, controller, options), options);
  }
}

function isAuthRejection(error: unknown): boolean {
  if (!(error instanceof RuntimeClientError)) return false;
  if (error.status === 401 || error.status === 403) return true;
  return AUTH_CODES.has(error.code);
}

// Re-export mutation headers for SSE fetch input construction (execute-turn).
export { mutationHeaders };
