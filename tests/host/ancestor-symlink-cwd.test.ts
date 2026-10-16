import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAppServerDriver } from "@host/drivers/codex-app-server";
import { createCursorStreamJsonDriver } from "@host/drivers/cursor-stream-json";
import { createGrokStreamJsonDriver } from "@host/drivers/grok-stream-json";
import { createKimiStreamJsonDriver } from "@host/drivers/kimi-stream-json";
import type { DriverDeps, ParticipantDriver } from "@host/drivers/types";
import type { InstallationName } from "@host/installations/discovery";
import type { InstallationRecord } from "@host/installations/registry";
import { createLogger } from "@host/logging";
import type { ProcessSupervisor } from "@host/process/process-supervisor";
import type { DriverId } from "@shared/runtime/contracts";
import type { ParticipantSpec } from "@shared/runtime/schemas";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deps(workRoot: string): DriverDeps {
  const supervisor = {
    spawnDriver() {
      throw new Error("spawn should not run");
    },
  } as unknown as ProcessSupervisor;
  return {
    supervisor,
    logger: createLogger({ sink: () => {} }),
    timeouts: {
      handshakeMs: 50,
      dispatchAckMs: 50,
      streamIdleMs: 50,
      turnMs: 50,
      oneshotMs: 50,
      interruptGraceMs: 50,
      shutdownGraceMs: 50,
    },
    workRoot,
  };
}

function spec(driverId: Exclude<DriverId, "claude-stream-json">): ParticipantSpec {
  return {
    participantId: "p-1",
    modelId: "nope",
    profile: {
      driverId,
      installationId: "inst",
      credentialMode: "installation-managed",
      options: {},
    },
  };
}

function installation(
  driverId: Exclude<DriverId, "claude-stream-json">,
  name: InstallationName,
): InstallationRecord {
  return {
    installationId: "inst",
    driverId,
    name,
    discoveredPath: "/usr/bin/true",
    realpath: "/usr/bin/true",
    fingerprint: "f".repeat(64),
    state: "trusted",
    components: [{ role: "wrapper", path: "/usr/bin/true", fingerprint: "f".repeat(64) }],
    detail: null,
  };
}

const drivers: Array<{
  name: string;
  driverId: Exclude<DriverId, "claude-stream-json">;
  installationName: InstallationName;
  open: (deps: DriverDeps) => (participantId: string) => ParticipantDriver;
}> = [
  {
    name: "grok",
    driverId: "grok-stream-json",
    installationName: "grok",
    open: createGrokStreamJsonDriver,
  },
  {
    name: "cursor",
    driverId: "cursor-stream-json",
    installationName: "cursor-agent",
    open: createCursorStreamJsonDriver,
  },
  {
    name: "kimi",
    driverId: "kimi-stream-json",
    installationName: "kimi",
    open: createKimiStreamJsonDriver,
  },
  {
    name: "codex",
    driverId: "codex-app-server",
    installationName: "codex",
    open: createCodexAppServerDriver,
  },
];

describe("driver cwd mkdir", () => {
  for (const row of drivers) {
    it(`${row.name} does not create a participant directory through a symlinked work root`, async () => {
      const parent = mkdtempSync(join(tmpdir(), "ck-ancestor-cwd-"));
      dirs.push(parent);
      const outside = join(parent, "outside");
      mkdirSync(outside);
      const workRoot = join(parent, "work");
      symlinkSync(outside, workRoot);
      const driver = row.open(deps(workRoot))("p-1");

      await expect(
        driver.prewarm({
          participantId: "p-1",
          spec: spec(row.driverId),
          installation: installation(row.driverId, row.installationName),
        }),
      ).rejects.toMatchObject({ code: "ELOOP" });

      expect(existsSync(join(outside, "p-1"))).toBe(false);
      expect(existsSync(join(outside, "p-1", "skills-empty"))).toBe(false);
    });
  }
});
