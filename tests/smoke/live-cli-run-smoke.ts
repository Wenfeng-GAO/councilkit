/**
 * Live CLI run smoke (V1.1 §2 / AC3 / plan-a §10). Drives the REAL built bin
 * `pnpm exec councilkit` against a real in-process Host (cfuse + kimi, 2 rounds
 * + Reporter) with the browser closed (no Vite/playwright). Reuses the
 * live-runtime-smoke harness (assertExclusiveMachine / acquireSession /
 * waitForHealth / createRealRig) — no duplicated process supervision.
 *
 * Flow:
 *   1. exclusive machine (no vitest/playwright; 43127 free);
 *   2. createRealRig (real Host on the canonical origin), acquire a session;
 *   3. temp COUNCILKIT_HOME;
 *   4. `councilkit models --json` → pick a cfuse model + a kimi model from the
 *      live catalog;
 *   5. `councilkit agent create` ×2 + `councilkit council create` (reporter);
 *   6. `councilkit run --council <id> --rounds 2 --json`;
 *   7. assert exit 0, 4 ordinary turns + 1 Reporter turn, report.md non-empty
 *      and naming both agents, transcript line count, Host diagnostics four
 *      counters zero, rig live driver count zero.
 *
 * Requires `pnpm build:cli` beforehand (the bin loads dist/main.mjs). Run:
 *   pnpm build:cli
 *   TSX_TSCONFIG_PATH=tsconfig.integration.json pnpm exec tsx \
 *     tests/smoke/live-cli-run-smoke.ts
 *
 * Exclusive/serial on 43127; never kill a non-self process — if 43127 is
 * occupied, lsof-record and report BLOCKED.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeClient } from "@/runtime/client";
import { CANONICAL_ORIGIN } from "@shared/runtime/contracts";
import {
  acquireSession,
  assertExclusiveMachine,
  createRealRig,
  waitForHealth,
} from "./live-runtime-smoke";

interface ModelEntry {
  driverId: string;
  installationId: string | null;
  route: string | null;
  catalog: string[];
  cachedAt: string | null;
  error: string | null;
}
interface ModelsJson {
  origin: string;
  models: ModelEntry[];
}
interface AgentJson {
  id: string;
  name: string;
  driverId: string;
}
interface CouncilJson {
  id: string;
  name: string;
  rounds: number;
  reporterAgentId: string;
  agentIds: string[];
}
interface RunOutcomeJson {
  runId: string;
  status: string;
  exitCode: number;
  reportPath: string;
  transcriptPath: string;
  turns: { role: string; agentName: string }[];
  incomplete: boolean;
}

/**
 * Run the built bin as an ASYNC child (spawn, not spawnSync). The rig Host
 * lives in THIS process; spawnSync would block the event loop and starve the
 * rig's HTTP server, so the child's requests would hang. Async spawn keeps the
 * parent looping so the rig serves the bin throughout the run.
 */
async function runBinCapture(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "councilkit", ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`councilkit ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        status: code ?? -1,
      });
    });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  await assertExclusiveMachine();
  const logLines: string[] = [];
  const rig = await createRealRig(logLines);
  const home = mkdtempSync(join(tmpdir(), "councilkit-cli-smoke-"));
  const env: NodeJS.ProcessEnv = { ...process.env, COUNCILKIT_HOME: home };
  let overallOk = true;
  let diagnosticsClient: RuntimeClient | null = null;
  try {
    const session = await acquireSession(rig.host.baseUrl);
    diagnosticsClient = new RuntimeClient({
      baseUrl: rig.host.baseUrl,
      csrfToken: session.csrfToken,
      headers: { Cookie: session.cookie, Origin: CANONICAL_ORIGIN },
    });
    await waitForHealth(diagnosticsClient, 10_000);

    // 1. models --json → pick cfuse + kimi models from the live catalog.
    const modelsRes = await runBinCapture(["models", "--json"], env);
    if (modelsRes.status !== 0)
      throw new Error(
        `models --json exited ${modelsRes.status}: stderr=${modelsRes.stderr} stdout=${modelsRes.stdout.slice(0, 400)}`,
      );
    const modelsJson = JSON.parse(modelsRes.stdout) as ModelsJson;
    const cfuseEntry = modelsJson.models.find(
      (m) =>
        m.driverId === "claude-stream-json" &&
        m.route === "cfuse" &&
        (m.catalog?.length ?? 0) > 0 &&
        !m.error,
    );
    const kimiEntry = modelsJson.models.find(
      (m) => m.driverId === "kimi-stream-json" && (m.catalog?.length ?? 0) > 0 && !m.error,
    );
    if (!cfuseEntry) throw new Error("no live cfuse model in catalog (catalog must succeed)");
    if (!kimiEntry) throw new Error("no live kimi model in catalog (catalog must succeed)");
    const cfuseModel = cfuseEntry.catalog[0] as string;
    const kimiModel = kimiEntry.catalog[0] as string;

    // 2. agent create ×2.
    const cfuseAgent = await createAgent(
      env,
      "smoke-cfuse",
      cfuseModel,
      "claude-stream-json",
      '{"route":"cfuse"}',
    );
    const kimiAgent = await createAgent(env, "smoke-kimi", kimiModel, "kimi-stream-json", "{}");

    // 3. council create (kimi is the Reporter, 2 rounds).
    const councilRes = await runBinCapture(
      [
        "council",
        "create",
        "--name",
        "smoke-council",
        "--topic",
        "live CLI smoke: should a local-first CLI expose model routing?",
        "--background",
        "A live CLI smoke run with two real agents over two rounds.",
        "--target-output",
        "A short Markdown decision report.",
        "--agents",
        JSON.stringify([cfuseAgent.id, kimiAgent.id]),
        "--rounds",
        "2",
        "--reporter",
        kimiAgent.id,
        "--json",
      ],
      env,
    );
    if (councilRes.status !== 0)
      throw new Error(
        `council create exited ${councilRes.status}: stderr=${councilRes.stderr} stdout=${councilRes.stdout.slice(0, 400)}`,
      );
    const councilJson = JSON.parse(councilRes.stdout) as CouncilJson;

    // 4. run --council --rounds 2 --json.
    const runRes = await runBinCapture(
      ["run", "--council", councilJson.id, "--rounds", "2", "--json"],
      env,
      600_000,
    );
    if (runRes.status !== 0) {
      throw new Error(
        `run exited ${runRes.status}:
--- stderr ---
${runRes.stderr}
--- stdout (outcome) ---
${runRes.stdout.slice(0, 1500)}`,
      );
    }
    const outcome = JSON.parse(runRes.stdout) as RunOutcomeJson;

    // --- assertions ----------------------------------------------------------
    if (outcome.status !== "completed" || outcome.exitCode !== 0) {
      throw new Error(`unexpected outcome: status=${outcome.status} exit=${outcome.exitCode}`);
    }
    if (outcome.incomplete) throw new Error("run flagged incomplete");

    const messages = outcome.turns.filter((t) => t.role === "message");
    const reports = outcome.turns.filter((t) => t.role === "report");
    if (messages.length !== 4) throw new Error(`expected 4 ordinary turns, got ${messages.length}`);
    if (reports.length !== 1) throw new Error(`expected 1 reporter turn, got ${reports.length}`);

    // report.md non-empty + names both agents.
    const report = readFileSync(join(home, "runs", outcome.runId, "report.md"), "utf8");
    if (report.trim().length === 0) throw new Error("report.md is empty");
    if (!report.includes("smoke-cfuse") || !report.includes("smoke-kimi")) {
      throw new Error("report.md does not name both agents");
    }

    // transcript line count: run.started + 5 turn.completed + run.finished = 7.
    const transcript = readFileSync(join(home, "runs", outcome.runId, "transcript.jsonl"), "utf8");
    const transcriptLines = transcript.split("\n").filter((l) => l.length > 0);
    if (transcriptLines.length !== 7) {
      throw new Error(`expected 7 transcript lines, got ${transcriptLines.length}`);
    }
    // both agents have a turn.completed record.
    if (!transcript.includes("smoke-cfuse") || !transcript.includes("smoke-kimi")) {
      throw new Error("transcript does not contain both agents' turns");
    }

    // Host diagnostics four counters zero.
    const diag = await diagnosticsClient.diagnostics();
    const scopes = diag.scopes;
    const leaks = Object.entries(scopes)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${k}=${v}`);
    if (leaks.length > 0) throw new Error(`diagnostics leak: ${leaks.join(", ")}`);

    // rig live driver count zero.
    const liveDrivers = rig.liveDriverCount();
    if (liveDrivers !== 0) throw new Error(`rig has ${liveDrivers} live driver process(es)`);

    process.stdout.write(
      "PASS live-cli-run-smoke — exit 0, 4 ordinary + 1 reporter, report non-empty, " +
        "diagZero=ok, rigLiveDrivers=0\n",
    );
  } catch (error) {
    process.stdout.write(`FAIL live-cli-run-smoke — ${messageOf(error)}\n`);
    overallOk = false;
  } finally {
    await rig.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }

  if (!overallOk) process.exit(1);
}

async function createAgent(
  env: NodeJS.ProcessEnv,
  name: string,
  modelId: string,
  driverId: string,
  optionsJson: string,
): Promise<AgentJson> {
  const res = await runBinCapture(
    [
      "agent",
      "create",
      "--name",
      name,
      "--persona-prompt",
      `You are ${name}, a live smoke participant. Answer briefly.`,
      "--driver-id",
      driverId,
      "--options",
      optionsJson,
      "--model-id",
      modelId,
      "--color",
      "#a1b2c3",
      "--json",
    ],
    env,
  );
  if (res.status !== 0)
    throw new Error(
      `agent create ${name} exited ${res.status}: ${res.stderr || res.stdout.slice(0, 400)}`,
    );
  return JSON.parse(res.stdout) as AgentJson;
}

// runBinCapture is the single child-process entry: it captures non-zero exits
// (a `run` that exits non-zero still carries a redacted JSON outcome on stdout).

main().catch((error) => {
  console.error(`SMOKE ERROR: ${messageOf(error)}`);
  process.exit(1);
});
