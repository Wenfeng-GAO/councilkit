import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LIVE_SQUADCTL =
  process.env.COUNCILKIT_SQUADCTL ??
  join(homedir(), ".codex/skills/hengzhuo-engineering-squad/scripts/squadctl");

export const LIVE_SKILL_DIR =
  process.env.COUNCILKIT_SQUAD_SKILL ?? join(homedir(), ".codex/skills/hengzhuo-engineering-squad");

export const HAS_LIVE_SQUADCTL = existsSync(LIVE_SQUADCTL);

if (process.env.COUNCILKIT_SQUAD_SMOKE === "1" && !HAS_LIVE_SQUADCTL) {
  throw new Error(
    "COUNCILKIT_SQUAD_SMOKE=1 requires a real squadctl; set COUNCILKIT_SQUADCTL or install hengzhuo-engineering-squad",
  );
}
