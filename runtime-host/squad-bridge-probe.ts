import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolveCouncilkitHome } from "@shared/runtime/cli-home";
import { withDriverWellKnownPath } from "@shared/runtime/driver-bins";
import { readPrivateText, replacePrivateFile } from "@shared/runtime/durable-write";
import { jsonParseEmbedded } from "@shared/runtime/json-parse";
import type { SquadBridgeProbe } from "@shared/runtime/squad-bridge-discovery";
import { resolveCouncilkitSpawn } from "./cli-launcher";

const DIAGNOSIS_FILE = "squad-bridge-diagnosis.json";
const FRESH_MS = 5 * 60 * 1000;

export type { SquadBridgeProbe };

/** Host never spawns squadctl. It reuses a CLI diagnosis or starts same-checkout councilkit repair probe. */
export function probeSquadBridge(env: NodeJS.ProcessEnv = process.env): SquadBridgeProbe {
  const cached = readDiagnosis(env);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.probe;
  const spawned = spawnCliProbe(env);
  if (spawned) {
    writeDiagnosis(env, spawned);
    return spawned;
  }
  if (cached) return cached.probe;
  return {
    available: false,
    version: null,
    toolVersion: null,
    reason: "无法运行同 checkout 的 councilkit repair probe。Host 不直接启动 squadctl。",
    executable: null,
    skillDir: null,
    capabilities: [],
    historyContract: null,
    orchestrator: null,
  };
}

function spawnCliProbe(env: NodeJS.ProcessEnv): SquadBridgeProbe | null {
  const spec = resolveCouncilkitSpawn();
  if (spec === null) return null;
  const result = spawnSync(spec.execPath, [...spec.argvPrefix, "--json", "repair", "probe"], {
    env: withDriverWellKnownPath(env),
    encoding: "utf8",
    timeout: 12_000,
    shell: false,
  });
  const parsed = jsonParseEmbedded(result.stdout ?? "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Partial<SquadBridgeProbe>;
  if (typeof row.available !== "boolean") return null;
  return {
    available: row.available,
    version: typeof row.version === "string" ? row.version : null,
    toolVersion: typeof row.toolVersion === "string" ? row.toolVersion : null,
    reason: typeof row.reason === "string" ? row.reason : null,
    executable: typeof row.executable === "string" ? row.executable : null,
    skillDir: typeof row.skillDir === "string" ? row.skillDir : null,
    capabilities: Array.isArray(row.capabilities)
      ? row.capabilities.filter((item): item is string => typeof item === "string")
      : [],
    historyContract: typeof row.historyContract === "string" ? row.historyContract : null,
    orchestrator: row.orchestrator ?? null,
  };
}

function diagnosisPath(env: NodeJS.ProcessEnv): string {
  return join(resolveCouncilkitHome(env), DIAGNOSIS_FILE);
}

function readDiagnosis(env: NodeJS.ProcessEnv): { at: number; probe: SquadBridgeProbe } | null {
  try {
    const text = readPrivateText(diagnosisPath(env));
    if (text === null) return null;
    const parsed = JSON.parse(text) as {
      at?: number;
      probe?: SquadBridgeProbe;
    };
    if (typeof parsed.at !== "number" || !parsed.probe) return null;
    return { at: parsed.at, probe: parsed.probe };
  } catch {
    return null;
  }
}

function writeDiagnosis(env: NodeJS.ProcessEnv, probe: SquadBridgeProbe): void {
  try {
    replacePrivateFile(
      diagnosisPath(env),
      `${JSON.stringify({ at: Date.now(), probe }, null, 2)}\n`,
    );
  } catch {
    // cache is optional
  }
}
