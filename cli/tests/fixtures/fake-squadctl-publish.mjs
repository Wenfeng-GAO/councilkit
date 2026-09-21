#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const cmd = args[0] ?? "";
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const next = {};
    for (const key of Object.keys(value).sort()) next[key] = sortKeys(value[key]);
    return next;
  }
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortKeys(value)), "utf8").digest("hex");
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
  process.stdout.write(`${JSON.stringify({ imported: true, historyCompleteness: "verified" })}\n`);
  process.exit(0);
}
if (cmd === "status") {
  const sha = process.env.FAKE_CANDIDATE_SHA ?? "a".repeat(40);
  const policy = process.env.FAKE_POLICY_HASH ?? "b".repeat(64);
  process.stdout.write(
    `${JSON.stringify({
      epoch: 8,
      phase: process.env.FAKE_PHASE ?? "integrating",
      control_status: process.env.FAKE_CONTROL ?? "active",
      candidate: {
        status: "completed",
        candidate_sha: sha,
        policy_hash: policy,
      },
      projection: {
        aggregate_verdict: {
          approved: true,
          verdict: "pass",
          reviewer_pass: true,
          verifier_pass: true,
          candidate_sha: sha,
          binding_gaps: [],
          independence_gaps: [],
          required_gate_gaps: [],
        },
        observe_status: "awaiting_orchestrator",
      },
      independence: {
        policy_status: "satisfied",
        bound_same_sha: true,
        provenance_complete: true,
        shared_run: false,
        shared_session: false,
        shared_worktree: false,
      },
    })}\n`,
  );
  process.exit(0);
}
if (cmd === "pause" || cmd === "resume") {
  process.stdout.write(`${JSON.stringify({ ok: true, epoch: 2, command: cmd })}\n`);
  process.exit(0);
}
if (cmd === "integrate") {
  const verb = args[1] ?? "";
  if (process.env.FAKE_INTEGRATE_STDERR) {
    process.stderr.write(`${process.env.FAKE_INTEGRATE_STDERR}\n`);
    process.exit(Number(process.env.FAKE_INTEGRATE_EXIT ?? "4"));
  }
  if (verb !== "check-remote" && verb !== "push-remote") {
    process.stderr.write(`unknown integrate ${verb}\n`);
    process.exit(2);
  }
  const repoRoot = flag("--repo-root");
  const profilePath = flag("--profile");
  const expectedOld = flag("--expected-old-sha");
  const candidateSha = flag("--candidate-sha");
  if (!repoRoot || !profilePath || !expectedOld || !candidateSha) {
    process.stderr.write("integrate missing frozen arguments\n");
    process.exit(2);
  }
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  let sourceSha = "";
  try {
    sourceSha = execFileSync("git", ["rev-parse", "--verify", profile.source.ref], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    process.stderr.write("integration refused before target update\n");
    process.exit(4);
  }
  if (profile.source.sha !== candidateSha || sourceSha !== candidateSha) {
    process.stderr.write("integration refused before target update\n");
    process.exit(4);
  }
  const receipt = {
    action: verb,
    result: verb === "check-remote" ? "checked" : "pushed",
    candidate_sha: candidateSha,
    expected_old_sha: expectedOld,
    remote: profile.target.remote,
    remote_ref: profile.target.ref,
    profile_hash: canonicalSha256(profile),
    cas_ok: true,
    ff_possible: true,
    remote_verified: verb === "push-remote",
    forced: false,
    remote_new_sha: verb === "push-remote" ? candidateSha : expectedOld,
  };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exit(0);
}
process.stderr.write(`unknown ${cmd}\n`);
process.exit(2);
