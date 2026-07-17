/**
 * Standalone "host-under-test" for process supervision tests.
 *
 * Run by tests as: `node --import tsx tests/fixtures/host-harness.ts <spec.json>`
 * where spec.json is:
 *   { participants: string[], toyDriver: string, driverWorkRoot: string,
 *     watchdogProgram: string }
 *
 * The harness uses the real createProcessSupervisor to spawn one toy driver
 * per participant (each asked to SPAWN-GRANDCHILD), waits for all of them to
 * be supervised, then prints one line:
 *
 *   HARNESS-READY pids=<pid,pid> gpids=<pgid,pgid> grandchild=<pid,pid>
 *
 * and stays alive forever. SIGTERM/SIGINT are swallowed on purpose so tests
 * can SIGKILL the harness mid-supervision and observe watchdog reaping.
 *
 * With HARNESS_KILLABLE_EARLY=1 it first prints `HARNESS-PID <pid>` and waits
 * ~250ms before spawning anything, so tests can kill it inside the
 * spawn -> supervised window.
 */
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { HostConfig } from "../../runtime-host/config";
import { createLogger } from "../../runtime-host/logging";
import {
  type DriverProcess,
  createProcessSupervisor,
  prepareParticipantCwd,
} from "../../runtime-host/process/process-supervisor";

interface HarnessSpec {
  participants: string[];
  toyDriver: string;
  driverWorkRoot: string;
  watchdogProgram: string;
}

// Tests SIGKILL the harness mid-supervision; SIGTERM/SIGINT must do nothing.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

function nextLine(stream: Readable, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(() => {
      rejectPromise(new Error("harness: timed out waiting for a driver stdout line"));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index !== -1) {
        clearTimeout(timer);
        resolvePromise(buffer.slice(0, index));
      }
    });
  });
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) throw new Error("usage: host-harness.ts <spec.json>");
  const spec = JSON.parse(await readFile(specPath, "utf8")) as HarnessSpec;

  const logger = createLogger({ sink: (line) => process.stderr.write(`[harness] ${line}\n`) });
  const config: HostConfig = {
    mode: "development",
    hostname: "127.0.0.1",
    port: 0,
    hostHeader: "127.0.0.1",
    distDir: spec.driverWorkRoot,
    watchdogProgram: spec.watchdogProgram,
    driverWorkRoot: spec.driverWorkRoot,
  };
  const supervisor = createProcessSupervisor({ config, logger });

  if (process.env.HARNESS_KILLABLE_EARLY === "1") {
    process.stdout.write(`HARNESS-PID ${process.pid}\n`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }

  const drivers: DriverProcess[] = [];
  const grandchildPids: number[] = [];
  for (const participantId of spec.participants) {
    const cwd = await prepareParticipantCwd(config.driverWorkRoot, participantId);
    const driver = await supervisor.spawnDriver({
      participantId,
      executable: process.execPath,
      argv: [spec.toyDriver],
      cwd,
      envInherit: ["PATH", "HOME"],
      envSet: { TOY_DRIVER: "1" },
    });
    await driver.waitSupervised(10_000);
    const grandchildLine = nextLine(driver.stdout);
    driver.stdin.write("SPAWN-GRANDCHILD\n");
    const line = await grandchildLine;
    grandchildPids.push(Number(line.split(" ")[1]));
    drivers.push(driver);
  }

  const pids = drivers.map((driver) => driver.pid).join(",");
  const gpids = drivers.map((driver) => driver.pgid).join(",");
  process.stdout.write(`HARNESS-READY pids=${pids} gpids=${gpids} grandchild=${grandchildPids.join(",")}\n`);
  setInterval(() => {}, 60_000);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[harness] fatal: ${message}\n`);
  process.exit(1);
});
