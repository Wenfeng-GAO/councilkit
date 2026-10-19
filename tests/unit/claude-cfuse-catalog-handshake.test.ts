/**
 * #391: the cfuse route's models catalog handshake must survive a cfuse cold
 * start that is slower than the generic handshake budget. Real driver + real
 * process supervisor + tests/fixtures/drivers/fake-cld.mjs (delayed
 * `initialize` reply).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeRoute } from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostConfig } from "../../runtime-host/config";
import { createClaudeStreamJsonDriver } from "../../runtime-host/drivers/claude-stream-json";
import type { DriverTimeouts, ParticipantDriver } from "../../runtime-host/drivers/types";
import type { InstallationRecord } from "../../runtime-host/installations/registry";
import { createLogger } from "../../runtime-host/logging";
import {
  type ProcessSupervisor,
  createProcessSupervisor,
} from "../../runtime-host/process/process-supervisor";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const FAKE_CLD = join(repoRoot, "tests/fixtures/drivers/fake-cld.mjs");
const FINGERPRINT = "f".repeat(64);
const CATALOG = [{ value: "default", resolvedModel: "antchat/GLM-5.3[1m]" }];

const TIMEOUTS: DriverTimeouts = {
  handshakeMs: 500,
  dispatchAckMs: 1500,
  streamIdleMs: 3000,
  turnMs: 15000,
  oneshotMs: 600_000,
  interruptGraceMs: 800,
  shutdownGraceMs: 1000,
};

let tempRoot = "";
let supervisor: ProcessSupervisor | null = null;
let driver: ParticipantDriver | null = null;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ck-cfuse-catalog-"));
});

afterEach(async () => {
  await driver?.close().catch(() => undefined);
  await supervisor?.shutdownAll(300).catch(() => undefined);
  driver = null;
  supervisor = null;
  await rm(tempRoot, { recursive: true, force: true });
});

async function prewarm(route: ClaudeRoute, initializeDelayMs: number) {
  const participantId = `probe-${route}`;
  const config: HostConfig = {
    mode: "production",
    hostname: "127.0.0.1",
    port: 0,
    hostHeader: "127.0.0.1",
    distDir: tempRoot,
    watchdogProgram: join(repoRoot, "runtime-host/process/watchdog-child.mjs"),
    driverWorkRoot: join(tempRoot, "work"),
  };
  const logger = createLogger({ sink: () => {} });
  supervisor = createProcessSupervisor({ config, logger });
  driver = createClaudeStreamJsonDriver({
    supervisor,
    logger,
    timeouts: TIMEOUTS,
    workRoot: join(tempRoot, "work"),
  })(participantId);
  const cwd = join(tempRoot, "work", participantId);
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "fake-driver-config.json"),
    JSON.stringify({ catalog: CATALOG, initializeDelayMs }),
  );
  const installation: InstallationRecord = {
    installationId: "fake-cld",
    driverId: "claude-stream-json",
    name: "cld",
    discoveredPath: FAKE_CLD,
    realpath: FAKE_CLD,
    fingerprint: FINGERPRINT,
    state: "trusted",
    components: [
      { role: "wrapper", path: FAKE_CLD, fingerprint: FINGERPRINT },
      { role: "claude-binary", path: FAKE_CLD, fingerprint: FINGERPRINT },
      { role: "cfuse-binary", path: FAKE_CLD, fingerprint: FINGERPRINT },
    ],
    detail: null,
  };
  return driver.prewarm({
    participantId,
    installation,
    spec: {
      participantId,
      profile: {
        driverId: "claude-stream-json",
        installationId: "fake-cld",
        credentialMode: "installation-managed",
        options: { route },
      },
      modelId: "__catalog__",
    },
  });
}

describe("claude-stream-json cfuse catalog handshake (#391)", () => {
  it("returns the cfuse catalog when initialize answers after the generic handshake budget", async () => {
    // 3× the generic budget: the cfuse route must still answer; a route
    // without the cfuse budget fails typed (HANDSHAKE_TIMEOUT), never as a
    // bare error the catalog route turns into 500 "Unhandled internal error".
    const slowStartMs = TIMEOUTS.handshakeMs * 3;
    const result = await prewarm("cfuse", slowStartMs);
    expect(result.catalog).toEqual(["antchat/GLM-5.3[1m]"]);

    await driver?.close();
    await supervisor?.shutdownAll(300);
    await expect(prewarm("ant-glm5.2", slowStartMs)).rejects.toMatchObject({
      runtimeCode: "HANDSHAKE_TIMEOUT",
    });
  });
});
