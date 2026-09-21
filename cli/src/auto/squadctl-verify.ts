import { spawnSync } from "node:child_process";
import type { SquadBridgeProbe } from "@shared/runtime/squad-bridge-discovery";
import { discoverSquadBridge } from "@shared/runtime/squad-bridge-discovery";

const HELP_MARKERS = [
  "init",
  "intake",
  "status",
  "resume",
  "pause",
  "adapter",
  "check-remote",
  "push-remote",
  "--expected-old-sha",
  "--candidate-sha",
  "--repo-root",
  "--profile",
  "--expected-epoch",
  "--new-repair-chain",
];

export function probeAndVerifySquadBridge(env: NodeJS.ProcessEnv = process.env): SquadBridgeProbe {
  const discovered = discoverSquadBridge(env);
  if (!discovered.available || !discovered.executable) return discovered;
  const help = spawnBounded(discovered.executable, ["--help"], env);
  const version = spawnBounded(discovered.executable, ["--version"], env);
  const integrate = spawnBounded(discovered.executable, ["integrate", "--help"], env);
  const push = spawnBounded(discovered.executable, ["integrate", "push-remote", "--help"], env);
  const pause = spawnBounded(discovered.executable, ["pause", "--help"], env);
  const intake = spawnBounded(discovered.executable, ["intake", "--help"], env);
  const blob =
    `${help.stdout}\n${version.stdout}\n${integrate.stdout}\n${push.stdout}\n${pause.stdout}\n${intake.stdout}`.toLowerCase();
  const missing = HELP_MARKERS.filter((marker) => !blob.includes(marker.toLowerCase()));
  if (help.exitCode === null || version.exitCode === null) {
    return {
      ...discovered,
      available: false,
      version: null,
      reason: "squadctl --help/--version 超时或无法执行，不能当作 Squad 桥。",
    };
  }
  if (missing.length > 0) {
    return {
      ...discovered,
      available: false,
      version: null,
      reason: `squadctl 未声明 ${missing.join("、")}，不能当作 Squad 桥。`,
    };
  }
  const versionText = version.stdout.trim().split("\n")[0] ?? "";
  return {
    ...discovered,
    version: discovered.version,
    toolVersion: versionText || null,
    reason: null,
  };
}

function spawnBounded(
  executable: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
): { stdout: string; exitCode: number | null } {
  const result = spawnSync(executable, argv, {
    env,
    encoding: "utf8",
    timeout: 8_000,
    shell: false,
  });
  return { stdout: `${result.stdout ?? ""}\n${result.stderr ?? ""}`, exitCode: result.status };
}
