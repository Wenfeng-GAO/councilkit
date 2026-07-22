/**
 * `councilkit models` — the closed set of available driver/route/model
 * (brief §2a, plan-a §5). Routes through `resolveInstallations` + the Host
 * catalog, probing every trusted installation per driver (claude-stream-json
 * gets one probe per route). Output carries only driverId/route/installationId
 * /catalog/cachedAt + redacted errors — no executable paths or fingerprints.
 */
import { CANONICAL_ORIGIN } from "@shared/runtime/contracts";
import type { ClaudeRoute } from "@shared/runtime/schemas";
import { errors } from "../errors";
import { HostClient } from "../host/client";
import { listTrusted } from "../host/installations";
import type { OutputSink } from "../output";
import { parseFlags } from "./parse";

const CLAUDE_ROUTES: ClaudeRoute[] = ["ant-glm5.2", "moonshot", "deepseek", "cfuse"];

export async function runModels(argv: string[], out: OutputSink): Promise<void> {
  parseFlags({ flags: { json: { type: "boolean" } }, allowPositionals: 0 }, argv);
  const host = new HostClient();

  let installations: Awaited<ReturnType<HostClient["listInstallations"]>>;
  try {
    await host.health();
    installations = await host.listInstallations();
  } catch (error) {
    throw errors.hostUnavailable(
      `Host unreachable at ${CANONICAL_ORIGIN}: ${error instanceof Error ? error.message : String(error)}`,
      { hint: "start the Runtime Host (pnpm start) and retry" },
    );
  }

  const driverIds = Array.from(new Set(installations.installations.map((i) => i.driverId)));
  const entries: ModelEntry[] = [];
  for (const driverId of driverIds) {
    const trusted = listTrusted(installations, driverId as Parameters<typeof listTrusted>[1]);
    if (trusted.length === 0) {
      entries.push({
        driverId,
        installationId: null,
        route: null,
        catalog: [],
        cachedAt: null,
        error: "no trusted installation",
      });
      continue;
    }
    // Use the first trusted installation (same policy as a run).
    const installationId = trusted[0].installationId;
    if (driverId === "claude-stream-json") {
      for (const route of CLAUDE_ROUTES) {
        entries.push(await probe(host, driverId, installationId, route));
      }
    } else {
      entries.push(await probe(host, driverId, installationId, undefined));
    }
  }

  const result = { origin: CANONICAL_ORIGIN, models: entries };
  out.finish(result, (d) => renderHuman(d as typeof result));
}

interface ModelEntry {
  driverId: string;
  installationId: string | null;
  route: ClaudeRoute | null;
  catalog: string[];
  cachedAt: string | null;
  error: string | null;
}

async function probe(
  host: HostClient,
  driverId: string,
  installationId: string,
  route: ClaudeRoute | undefined,
): Promise<ModelEntry> {
  try {
    const resp = await host.modelCatalog(
      driverId as Parameters<HostClient["modelCatalog"]>[0],
      installationId,
      route ? { route, refresh: true } : { refresh: true },
    );
    return {
      driverId,
      installationId,
      route: route ?? null,
      catalog: resp.catalog,
      cachedAt: resp.cachedAt,
      error: null,
    };
  } catch (error) {
    return {
      driverId,
      installationId,
      route: route ?? null,
      catalog: [],
      cachedAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function renderHuman(d: { origin: string; models: ModelEntry[] }): string {
  const lines: string[] = [`councilkit models — closed set at ${d.origin}`];
  for (const m of d.models) {
    const where = m.route ? `${m.driverId}/${m.route}` : m.driverId;
    if (m.error) {
      lines.push(`  ${where} [${m.installationId ?? "n/a"}]: ERROR — ${m.error}`);
    } else {
      lines.push(`  ${where} [${m.installationId}]: ${m.catalog.join(", ") || "(empty catalog)"}`);
    }
  }
  return lines.join("\n");
}
