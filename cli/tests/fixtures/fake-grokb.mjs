#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const resumeId = flag("--resume");
const sessionId = flag("--session-id");
let forced = null;
if (process.env.MODE_FILE) {
  try {
    forced = readFileSync(process.env.MODE_FILE, "utf8").trim();
  } catch {
    forced = null;
  }
}
if (forced === "exit") process.exit(17);
const passthrough = new Set(["", "grand", "postexit", "exit0", "signal"]);
const session =
  forced && !passthrough.has(forced)
    ? forced
    : (resumeId ?? sessionId ?? process.env.FAKE_GROK_SESSION ?? "fake-native-session");
let grand;
if (forced === "grand" || process.env.CANARY) {
  const script = process.env.CANARY
    ? `const fs=require('fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.env.CANARY,'x'),20)`
    : `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  grand = spawn(process.execPath, ["-e", script], {
    stdio: "ignore",
    env: process.env,
  });
  if (process.env.GRAND_FILE && grand.pid) writeFileSync(process.env.GRAND_FILE, String(grand.pid));
  if (process.env.PIDFILE && grand.pid) writeFileSync(process.env.PIDFILE, String(grand.pid));
}
process.stdout.write(
  `${JSON.stringify({ type: "system", subtype: "init", session_id: session })}\n`,
);
if (forced === "postexit") {
  setTimeout(() => process.exit(17), 500);
} else if (forced === "exit0") {
  setTimeout(() => process.exit(0), 200);
} else {
  setInterval(() => {}, 1000);
}
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
