/**
 * `councilkit doctor` — Host reachability + installations + catalog summary
 * (brief §2a, plan-a §5/§6). The CLI NEVER spawns the Host (D1 §7): when the
 * Host is unreachable, doctor reports that, prints the startup guidance, and
 * exits 3. doctor also routes through `resolveInstallations` so its view never
 * drifts from what a run would use.
 */
import { CANONICAL_ORIGIN, CREDENTIAL_MODE } from "@shared/runtime/contracts";
import type {
  ExecutionProfileDto,
  HealthResponse,
  InstallationsResponse,
  ModelCatalogResponse,
} from "@shared/runtime/schemas";
import { errors } from "../errors";
import { HostClient } from "../host/client";
import { listTrusted } from "../host/installations";
import { isAuthRequiredError, withLoginHint } from "../login-hint";
import type { OutputSink } from "../output";
import { parseFlags } from "./parse";

export type DoctorHost = Pick<
  HostClient,
  "health" | "listInstallations" | "modelCatalog" | "profileReadiness"
>;

export interface DoctorDeps {
  host?: DoctorHost;
}

export async function runDoctor(
  argv: string[],
  out: OutputSink,
  deps: DoctorDeps = {},
): Promise<void> {
  parseFlags({ flags: {}, allowPositionals: 0 }, argv);

  const host = deps.host ?? new HostClient();
  let health: HealthResponse;
  let installations: InstallationsResponse;
  try {
    health = await host.health();
    installations = await host.listInstallations();
  } catch (error) {
    reportUnreachable(out, error);
    throw errors.hostUnavailable(`Host unreachable at ${CANONICAL_ORIGIN}`, {
      hint: "start the Runtime Host (pnpm start) and retry; the CLI never spawns it",
    });
  }

  // Per-driver trusted installations + a one-model catalog probe (first route
  // for claude-stream-json). Errors per driver are captured, not fatal.
  const drivers = Array.from(new Set(installations.installations.map((i) => i.driverId)));
  const driverSummary = await Promise.all(
    drivers.map(async (driverId) => {
      const trusted = listTrusted(installations, driverId);
      const sample = await probeCatalog(host, driverId, trusted[0]?.installationId);
      const catalogProbe = await overlayLoginProbe(
        host,
        driverId,
        trusted[0]?.installationId,
        sample,
      );
      return {
        driverId,
        trustedCount: trusted.length,
        trustedInstallationIds: trusted.map((t) => t.installationId),
        catalogProbe,
      };
    }),
  );

  const result = {
    reachable: true,
    origin: CANONICAL_ORIGIN,
    health,
    installations: installations.installations.map((i) => ({
      installationId: i.installationId,
      driverId: i.driverId,
      state: i.state,
    })),
    drivers: driverSummary,
  };

  await out.finish(result, (d) => renderHuman(d as typeof result));
}

async function probeCatalog(
  host: Pick<HostClient, "modelCatalog">,
  driverId: string,
  installationId: string | undefined,
): Promise<{ ok: boolean; catalog?: string[]; cachedAt?: string; error?: string }> {
  if (!installationId) return { ok: false, error: "no trusted installation" };
  try {
    const route = driverId === "claude-stream-json" ? ("cfuse" as const) : undefined;
    const resp: ModelCatalogResponse = await host.modelCatalog(driverId, installationId, {
      route,
      refresh: true,
    });
    return { ok: true, catalog: resp.catalog, cachedAt: resp.cachedAt };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: isAuthRequiredError(error) ? withLoginHint(raw, driverId) : raw,
    };
  }
}

/** Catalog can succeed from a hardcoded closed set before the driver login
 * probe runs (kimi `__catalog__` → MODEL_UNAVAILABLE + catalog). A follow-up
 * readiness handshake with a real modelId is what surfaces AUTH_REQUIRED. */
async function overlayLoginProbe(
  host: Pick<HostClient, "profileReadiness">,
  driverId: string,
  installationId: string | undefined,
  catalog: { ok: boolean; catalog?: string[]; cachedAt?: string; error?: string },
): Promise<{ ok: boolean; catalog?: string[]; cachedAt?: string; error?: string }> {
  if (!catalog.ok || installationId === undefined) return catalog;
  const modelId = catalog.catalog?.[0];
  if (modelId === undefined || modelId.length === 0) return catalog;
  const profile = {
    driverId,
    installationId,
    credentialMode: CREDENTIAL_MODE,
    options: driverId === "claude-stream-json" ? { route: "cfuse" } : {},
  } as ExecutionProfileDto;
  try {
    const readiness = await host.profileReadiness(profile, modelId, { refresh: true });
    if (readiness.readiness.state === "ready") return catalog;
    const detail = readiness.readiness.detail ?? readiness.readiness.state;
    if (readiness.readiness.state === "runtime_unavailable" && /auth|login/i.test(detail)) {
      return { ok: false, error: withLoginHint(detail, driverId) };
    }
    return catalog;
  } catch (error) {
    if (!isAuthRequiredError(error)) return catalog;
    const raw = error instanceof Error ? error.message : String(error);
    return { ok: false, error: withLoginHint(raw, driverId) };
  }
}

function renderHuman(d: {
  reachable: boolean;
  origin: string;
  health: HealthResponse;
  installations: { installationId: string; driverId: string; state: string }[];
  drivers: {
    driverId: string;
    trustedCount: number;
    trustedInstallationIds: string[];
    catalogProbe: { ok: boolean; catalog?: string[]; error?: string };
  }[];
}): string {
  const lines: string[] = [];
  lines.push(`councilkit doctor — Host reachable at ${d.origin}`);
  lines.push(`  apiVersion: ${d.health.apiVersion}`);
  lines.push(`  hostInstanceId: ${d.health.hostInstanceId}`);
  lines.push(`  node: ${d.health.node.version}`);
  lines.push(
    `  drivers (health): ${d.health.drivers.map((dr) => `${dr.driverId}=${dr.capability}`).join(", ")}`,
  );
  lines.push(`  installations: ${d.installations.length}`);
  for (const dr of d.drivers) {
    lines.push(
      `  ${dr.driverId}: trusted=${dr.trustedCount} catalogProbe=${dr.catalogProbe.ok ? "ok" : "fail"}${dr.catalogProbe.catalog ? ` (${dr.catalogProbe.catalog.length} models)` : ""}${dr.catalogProbe.error ? ` — ${dr.catalogProbe.error}` : ""}`,
    );
  }
  return lines.join("\n");
}

function reportUnreachable(out: OutputSink, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  out.diag(`Host unreachable at ${CANONICAL_ORIGIN}: ${msg}`);
  if (out.json) return;
  out.progress(
    "The Runtime Host is not running. The CLI never spawns it — start it with `pnpm start` (or `pnpm dev`) on http://127.0.0.1:43127, then retry.",
  );
}
