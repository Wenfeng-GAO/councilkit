#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CURSOR_ARGV) {
  appendFileSync(process.env.FAKE_CURSOR_ARGV, `${args.join(" ")}\n`);
}

let stdin = "";
process.stdin.on("data", (chunk) => {
  stdin += chunk.toString("utf8");
});
process.stdin.on("end", () => {
  if (process.env.FAKE_CURSOR_STDIN) writeFileSync(process.env.FAKE_CURSOR_STDIN, stdin);
});

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const resume = flag("--resume");
const model = process.env.FAKE_CURSOR_MODEL || "Grok 4.7 500K Extra High";
const session = resume || process.env.FAKE_CURSOR_SESSION || "cursor-native-1";
process.stdout.write(
  `${JSON.stringify({ type: "system", subtype: "init", session_id: session, model })}\n`,
);
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
