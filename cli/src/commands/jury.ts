import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ReviewJuryResponse,
  reviewJuryResponseSchema,
  reviewJuryUpdateSchema,
} from "@shared/runtime/review-jury";
import { errors } from "../errors";
import type { OutputSink } from "../output";
import { Store } from "../store/store";
import { parseFlags, parseJsonFlag } from "./parse";

/** Local discovery only; never expose model prompts or account data from the cache. */
/** Top-level `model = "..."` from Codex config, before the first table. */
export function configuredCodexModel(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const path = join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
    if (statSync(path).size > 256 * 1024) return null;
    const head = (readFileSync(path, "utf8").split(/^\[/m)[0] ?? "").trim();
    const match = head.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    const value = match?.[1]?.trim() ?? "";
    if (value.length === 0 || value.length > 256 || value.startsWith("-")) return null;
    return value;
  } catch {
    return null;
  }
}

export function discoverCodexModel(env: NodeJS.ProcessEnv = process.env): string | null {
  return configuredCodexModel(env) ?? cachedCodexModels(env)[0] ?? null;
}

export function cachedCodexModels(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const path = join(env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
    if (statSync(path).size > 8 * 1024 * 1024) return [];
    const data = JSON.parse(readFileSync(path, "utf8")) as { models?: unknown };
    if (!Array.isArray(data.models)) return [];
    return [
      ...new Set(
        data.models
          .filter(
            (row) =>
              row &&
              row.visibility === "list" &&
              typeof row.slug === "string" &&
              row.slug.length > 0 &&
              row.slug.length <= 256 &&
              !row.slug.startsWith("-"),
          )
          .map((row) => row.slug as string),
      ),
    ];
  } catch {
    return [];
  }
}

export function readJury(councilName: string, store = new Store()): ReviewJuryResponse {
  const council = store.getCouncil(councilName);
  return reviewJuryResponseSchema.parse({
    councilId: council.id,
    revision: store.councilRevision(council),
    seats: store.councilAgents(council).map((agent) => ({
      agentId: agent.id,
      modelId: agent.modelId,
      driverSelection: agent.driverSelection,
    })),
    reporterAgentId: council.reporterAgentId,
    agents: store.listAgents().map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      modelId: agent.modelId,
      driverSelection: agent.driverSelection,
      color: agent.color,
      enabled: agent.enabled,
    })),
    codexModels: cachedCodexModels(),
  });
}

export function readReviewJury(store = new Store()): ReviewJuryResponse {
  return readJury("pr-jury", store);
}

export async function runJury(argv: string[], out: OutputSink): Promise<void> {
  const sub = argv[0];
  if (sub !== "show" && sub !== "save") throw errors.usage("jury requires show or save");
  const { values } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        council: { type: "string" },
        ...(sub === "save" ? { config: { type: "string" as const } } : {}),
      },
      allowPositionals: 0,
    },
    argv.slice(1),
  );
  const store = new Store();
  const councilName = typeof values.council === "string" ? values.council : "pr-jury";
  if (sub === "save") {
    if (councilName !== "pr-jury") {
      throw errors.usage("jury save only updates pr-jury; pass --council only with show");
    }
    store.updateReviewJury(
      parseJsonFlag(values.config as string | undefined, reviewJuryUpdateSchema, "config"),
    );
  }
  await out.finish(readJury(councilName, store));
}
