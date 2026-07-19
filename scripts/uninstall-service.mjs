#!/usr/bin/env node
/**
 * Uninstalls the CouncilKit Runtime Host launchd agent.
 *
 * Deletes ONLY ~/Library/LaunchAgents/com.councilkit.host.plist — the target
 * path is constructed from fixed segments and re-checked after resolve() so
 * nothing else can be removed. Logs under ~/Library/Logs/CouncilKit/ are
 * deliberately left untouched.
 *
 * This script does NOT unload the agent: if it is currently loaded, run the
 * printed `launchctl bootout` command yourself (order matters — bootout
 * first, then delete, or launchd will respawn/rewrite state).
 *
 * Idempotent: exits 0 with a notice when the plist is not installed.
 *
 * Usage: node scripts/uninstall-service.mjs
 */
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const LABEL = "com.councilkit.host";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

if (!existsSync(plistPath)) {
  console.log(`not installed: ${plistPath} does not exist — nothing to do.`);
  process.exit(0);
}

const resolved = resolve(plistPath);
if (resolved !== plistPath) {
  console.error(`error: refusing to remove unexpected path ${resolved} (expected ${plistPath}).`);
  process.exit(1);
}

// Print the unload instructions BEFORE deleting the plist: once the file is
// gone the path-based bootout form no longer works, and the user would lose
// their unload instructions exactly when they still need them. The
// service-target form (gui/<uid>/<label>) does not depend on the plist file.
console.log("If the agent is currently loaded, unload it first — this script does not unload:");
console.log(`  launchctl bootout gui/$(id -u)/${LABEL}`);
console.log("or, on older macOS (path form, valid only while the plist exists):");
console.log(`  launchctl unload ${resolved}`);
console.log("");

rmSync(resolved);
console.log(`removed ${resolved}`);
console.log(`logs under ${join(homedir(), "Library", "Logs", "CouncilKit")} were left untouched.`);
console.log("Reminder: this script did not unload the agent — run the bootout above if needed.");
