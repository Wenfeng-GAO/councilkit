import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { terminateChild } from "../../shared/runtime/terminate-child.ts";

const root = process.argv[2];
const graceMs = Number(process.argv[3]);
const holdMs = Number(process.argv[4]);
if (!root || !Number.isInteger(graceMs) || !Number.isInteger(holdMs)) {
  throw new Error("usage: group-drain-runner root graceMs holdMs");
}

const grandPath = `${root}/grand.js`;
const leaderPath = `${root}/leader.js`;
const readyFile = `${root}/ready`;
const grandReady = `${root}/grand.ready`;
const grandPidFile = `${root}/grand.pid`;
const leaderPidFile = `${root}/leader.pid`;
const signalFile = `${root}/signals.json`;
const stampFile = `${root}/stamp`;

writeFileSync(
  grandPath,
  [
    'const fs = require("node:fs");',
    "let held = false;",
    'process.on("SIGTERM", () => {',
    "  if (held) return;",
    "  held = true;",
    `  setTimeout(() => process.exit(0), ${holdMs});`,
    "});",
    `fs.writeFileSync(${JSON.stringify(grandReady)}, "ready");`,
    "setInterval(() => {}, 1e9);",
    "",
  ].join("\n"),
);
writeFileSync(
  leaderPath,
  [
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    `const grand = spawn(process.execPath, [${JSON.stringify(grandPath)}], { stdio: "ignore" });`,
    `fs.writeFileSync(${JSON.stringify(grandPidFile)}, String(grand.pid));`,
    `fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
    "setInterval(() => {}, 1e9);",
    "",
  ].join("\n"),
);

function waitForFile(path: string): void {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      readFileSync(path);
      return;
    } catch {
      execFileSync("sleep", ["0.02"]);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

const leader = spawn(process.execPath, [leaderPath], { detached: true, stdio: "ignore" });
if (leader.pid === undefined) throw new Error("leader has no pid");
const leaderPid = leader.pid;
writeFileSync(leaderPidFile, String(leaderPid));
waitForFile(readyFile);
waitForFile(grandReady);

const signals: string[] = [];
const originalKill = process.kill.bind(process);
process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
  if (pid === -leaderPid) {
    signals.push(String(signal));
    writeFileSync(signalFile, JSON.stringify(signals));
  }
  return originalKill(pid, signal as NodeJS.Signals);
}) as typeof process.kill;

writeFileSync(stampFile, String(Date.now()));
terminateChild(leader, { graceMs, group: true });
