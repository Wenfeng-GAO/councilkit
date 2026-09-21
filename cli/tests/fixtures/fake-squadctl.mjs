#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const history = args.includes("--history");
  const newChain = args.includes("--new-repair-chain");
  if (taskDir && (history || newChain)) {
    writeFileSync(join(taskDir, "repair-history.v1.json"), `${JSON.stringify({ imported: true })}\n`);
  }
  process.stdout.write(
    `${JSON.stringify({
      imported: true,
      historyCompleteness: history || newChain ? "verified" : "absent",
      newChain,
    })}\n`,
  );
  process.exit(0);
}
if (cmd === "status") {
  let taskId = null;
  if (taskDir) {
    try {
      const state = JSON.parse(readFileSync(join(taskDir, "state.json"), "utf8"));
      taskId = typeof state.task_id === "string" ? state.task_id : null;
    } catch {
      taskId = null;
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      epoch: 1,
      phase: "briefing",
      control_status: "active",
      task_id: taskId,
      candidate: { status: "pending" },
    })}\n`,
  );
  process.exit(0);
}
if (cmd === "pause") {
  process.stdout.write(`${JSON.stringify({ ok: true, epoch: 2, command: "pause" })}\n`);
  process.exit(0);
}
if (cmd === "resume") {
  if (process.env.FAKE_SQUADCTL_RESUME_FAIL) {
    process.stderr.write("StateDriftError: bound repair history origins drifted\n");
    process.exit(5);
  }
  process.stdout.write(
    `${JSON.stringify({
      resumed: true,
      epoch: 2,
      head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      diff_hash: "b".repeat(64),
    })}\n`,
  );
  process.exit(0);
}
process.stderr.write(`unknown ${cmd}\n`);
process.exit(2);
