#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const cmd = args[0] ?? "";
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
if (process.env.FAKE_SQUADCTL_ARGV) {
  appendFileSync(process.env.FAKE_SQUADCTL_ARGV, `${args.join(" ")}\n`);
}

const taskDir = flag("--task-dir");
if (cmd === "init") {
  if (!taskDir) {
    process.stderr.write("missing --task-dir\n");
    process.exit(2);
  }
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "events.jsonl"), `${JSON.stringify({ type: "init", epoch: 1 })}\n`);
  writeFileSync(
    join(taskDir, "state.json"),
    `${JSON.stringify({ epoch: 1, task_id: flag("--task-id"), phase: "briefing" })}\n`,
  );
  process.stdout.write(`${JSON.stringify({ ok: true, epoch: 1 })}\n`);
  process.exit(0);
}
if (cmd === "intake") {
  process.stdout.write(
    `${JSON.stringify({
      imported: true,
      historyCompleteness: args.includes("--new-repair-chain") ? "verified" : "absent",
      newChain: args.includes("--new-repair-chain"),
    })}\n`,
  );
  process.exit(0);
}
if (cmd === "status") {
  process.stdout.write(
    `${JSON.stringify({
      epoch: 1,
      phase: "briefing",
      control_status: "active",
      candidate: { status: "pending" },
    })}\n`,
  );
  process.exit(0);
}
if (cmd === "pause" || cmd === "resume") {
  process.stdout.write(`${JSON.stringify({ ok: true, epoch: 2, command: cmd })}\n`);
  process.exit(0);
}
process.stderr.write(`unknown ${cmd}\n`);
process.exit(2);
