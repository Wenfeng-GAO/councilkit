import { constants, accessSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { SQUAD_BRIDGE_CONTRACT_VERSION } from "@shared/runtime/squad-bridge-contract";

export function probeSquadBridge(env: NodeJS.ProcessEnv = process.env): {
  available: boolean;
  version: string | null;
  reason: string | null;
} {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    try {
      accessSync(resolve(dir || ".", "squadctl"), constants.X_OK);
      return { available: true, version: SQUAD_BRIDGE_CONTRACT_VERSION, reason: null };
    } catch {
      // keep scanning PATH
    }
  }
  return {
    available: false,
    version: null,
    reason: "squadctl not on PATH; Squad 桥不可用",
  };
}
