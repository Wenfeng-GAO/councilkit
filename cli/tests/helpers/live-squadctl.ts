import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Independent-review freeze; installed ~/.codex symlink may still be 2.1.0. */
export const FROZEN_SQUAD_SKILL =
  "/tmp/councilkit-squad-bridge-20260921/skill-history-worktree/hengzhuo-engineering-squad";
const FROZEN_SQUADCTL = join(FROZEN_SQUAD_SKILL, "scripts/squadctl");
const INSTALLED_SKILL = join(homedir(), ".codex/skills/hengzhuo-engineering-squad");

export const LIVE_SKILL_DIR =
  process.env.COUNCILKIT_SQUAD_SKILL ??
  (existsSync(FROZEN_SQUAD_SKILL) ? FROZEN_SQUAD_SKILL : INSTALLED_SKILL);

export const LIVE_SQUADCTL =
  process.env.COUNCILKIT_SQUADCTL ??
  (existsSync(FROZEN_SQUADCTL) ? FROZEN_SQUADCTL : join(LIVE_SKILL_DIR, "scripts/squadctl"));

export const HAS_LIVE_SQUADCTL = existsSync(LIVE_SQUADCTL);

if (process.env.COUNCILKIT_SQUAD_SMOKE === "1" && !HAS_LIVE_SQUADCTL) {
  throw new Error(
    "COUNCILKIT_SQUAD_SMOKE=1 requires a real squadctl; set COUNCILKIT_SQUADCTL or install hengzhuo-engineering-squad",
  );
}
