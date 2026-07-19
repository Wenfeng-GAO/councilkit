#!/usr/bin/env node
/**
 * Installs the CouncilKit Runtime Host as a macOS launchd agent.
 *
 * Writes ~/Library/LaunchAgents/com.councilkit.host.plist pointing at
 * `node <repo>/dist-host/main.mjs` (KeepAlive=true, ThrottleInterval=10,
 * stdout/stderr to ~/Library/Logs/CouncilKit/). The Node path is pinned to
 * the interpreter running this script (process.execPath) — re-run this
 * script after switching Node versions or moving the repository.
 *
 * This script ONLY writes the plist file. It never runs launchctl: loading
 * the agent is a deliberate user action, and the exact command is printed
 * at the end.
 *
 * Usage:
 *   node scripts/install-service.mjs            write the plist
 *   node scripts/install-service.mjs --dry-run  print the plist, write nothing
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.councilkit.host";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const entry = join(repoRoot, "dist-host", "main.mjs");
const home = homedir();
const logsDir = join(home, "Library", "Logs", "CouncilKit");
const plistPath = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
const dryRun = process.argv.includes("--dry-run");

// launchd starts agents with a minimal PATH; CLI discovery (drivers) relies
// on PATH plus well-known directories, so inject the usual locations.
// dirname(process.execPath) goes FIRST: under nvm-style setups the globally
// installed CLIs (codex/cld) live next to the node binary itself.
const servicePath = [
  dirname(process.execPath),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  join(home, ".local", "bin"),
  join(home, "bin"),
].join(":");

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${escapeXml(process.execPath)}</string>
\t\t<string>${escapeXml(entry)}</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${escapeXml(repoRoot)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${escapeXml(servicePath)}</string>
\t</dict>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(join(logsDir, "host.out.log"))}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(join(logsDir, "host.err.log"))}</string>
</dict>
</plist>
`;
}

if (!existsSync(entry)) {
  console.error(`error: ${entry} not found — run \`pnpm build\` first.`);
  process.exit(1);
}
if (!existsSync(join(repoRoot, "dist", "index.html"))) {
  console.warn(
    "warning: dist/index.html not found — the hosted Host cannot serve the UI; run `pnpm build`.",
  );
}

if (dryRun) {
  console.log(`# dry run — would write ${plistPath}:\n`);
  process.stdout.write(renderPlist());
  process.exit(0);
}

mkdirSync(logsDir, { recursive: true });
// A fresh HOME may not have ~/Library/LaunchAgents yet (F4).
mkdirSync(dirname(plistPath), { recursive: true });
if (existsSync(plistPath)) {
  console.log(`overwriting existing ${plistPath}`);
}
writeFileSync(plistPath, renderPlist());
console.log(`wrote ${plistPath}`);
console.log(`logs will go to ${logsDir}/host.out.log and host.err.log`);
console.log("\nThis script does not load the agent. To start it, run:");
console.log(`  launchctl bootstrap gui/$(id -u) ${plistPath}`);
console.log("or, on older macOS:");
console.log(`  launchctl load -w ${plistPath}`);
console.log(
  "\nThen verify: launchctl list | grep councilkit && curl http://127.0.0.1:43127/api/v1/health",
);
