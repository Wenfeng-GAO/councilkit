import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostConfig } from "../../runtime-host/config";
import { createLogger } from "../../runtime-host/logging";
import {
  type DriverSpawnSpec,
  type ProcessSupervisor,
  SPAWN_ERROR_DETAIL_MAX,
  buildSupervisedEnv,
  createBoundedRing,
  createProcessSupervisor,
  filterDeniedEnv,
  isDeniedEnvName,
  prepareParticipantCwd,
} from "../../runtime-host/process/process-supervisor";
import { clipUtf16 } from "../../shared/text/clip-utf16";

const WATCHDOG_PROGRAM = new URL("../../runtime-host/process/watchdog-child.mjs", import.meta.url)
  .pathname;

let tempRoot = "";
let supervisors: ProcessSupervisor[] = [];

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ck-proc-env-"));
});

afterEach(async () => {
  for (const supervisor of supervisors) {
    await supervisor.shutdownAll(200).catch(() => undefined);
  }
  supervisors = [];
  await rm(tempRoot, { recursive: true, force: true });
});

function spawnFailed(message: string, participantId?: string) {
  return {
    code: "DRIVER_SPAWN_FAILED",
    phase: "prewarm",
    message,
    retryable: false,
    ...(participantId ? { participantId } : {}),
  };
}

function supervisorFor(driverWorkRoot = join(tempRoot, "work")): ProcessSupervisor {
  const config: HostConfig = {
    mode: "development",
    hostname: "127.0.0.1",
    port: 0,
    hostHeader: "127.0.0.1",
    distDir: tempRoot,
    watchdogProgram: WATCHDOG_PROGRAM,
    driverWorkRoot,
  };
  const supervisor = createProcessSupervisor({ config, logger: createLogger({ sink: () => {} }) });
  supervisors.push(supervisor);
  return supervisor;
}

describe("environment filtering", () => {
  it("keeps explicit inherits and envSet, and drops denied names", () => {
    expect(
      buildSupervisedEnv(
        ["PATH", "ABSENT", "MY_TOKEN", "NODE_OPTIONS"],
        { DRIVER: "1", SMUGGLED_SECRET: "no", PATH: "/override" },
        { PATH: "/bin", MY_TOKEN: "t", NODE_OPTIONS: "--inspect", ABSENT: undefined },
      ),
    ).toEqual({ PATH: "/override", MY_TOKEN: "t", DRIVER: "1" });

    expect(buildSupervisedEnv(["PATH"], { DECLARED: "1" })).toEqual({
      PATH: process.env.PATH,
      DECLARED: "1",
    });
  });

  it("applies exact and prefix denies even when the name was inherited", () => {
    expect(isDeniedEnvName("NODE_OPTIONS", true)).toBe(true);
    expect(isDeniedEnvName("LD_PRELOAD", true)).toBe(true);
    expect(isDeniedEnvName("DYLD_INSERT_LIBRARIES")).toBe(true);
    expect(isDeniedEnvName("BASH_ENV")).toBe(true);
    expect(isDeniedEnvName("ENV", true)).toBe(true);
    expect(isDeniedEnvName("MY_TOKEN", true)).toBe(false);
    expect(isDeniedEnvName("MY_TOKEN")).toBe(true);
    expect(isDeniedEnvName("http_proxy")).toBe(true);
    expect(isDeniedEnvName("Secret")).toBe(true);
    expect(isDeniedEnvName("PASSWORD")).toBe(true);
    expect(isDeniedEnvName("KEY")).toBe(true);
    expect(isDeniedEnvName("PATH")).toBe(false);

    expect(
      filterDeniedEnv(
        {
          NODE_OPTIONS: "a",
          LD_PRELOAD: "b",
          DYLD_FORCE: "c",
          BASH_ENV: "d",
          ENV: "e",
          API_PASSWORD: "f",
          SAFE: "g",
        },
        {
          exemptInheritedNames: [
            "NODE_OPTIONS",
            "LD_PRELOAD",
            "DYLD_FORCE",
            "API_PASSWORD",
            "SAFE",
          ],
        },
      ),
    ).toEqual({ API_PASSWORD: "f", SAFE: "g" });
  });
});

describe("createBoundedRing", () => {
  it("drops bytes from the front and ignores empty chunks", () => {
    const ring = createBoundedRing(3);
    ring.append("");
    ring.append(Buffer.alloc(0));
    ring.append("ab");
    expect(ring.text()).toBe("ab");
    expect(ring.byteLength()).toBe(2);
    ring.append("cdef");
    expect(ring.text()).toBe("def");
    expect(ring.byteLength()).toBe(3);
    ring.clear();
    expect(ring.text()).toBe("");
    expect(ring.byteLength()).toBe(0);

    const empty = createBoundedRing(0);
    empty.append("ab");
    expect(empty.text()).toBe("");
    expect(empty.byteLength()).toBe(0);
  });
});

describe("spawn error detail clip (SPAWN_ERROR_DETAIL_MAX)", () => {
  const clip = (v: string) => clipUtf16(v, SPAWN_ERROR_DETAIL_MAX);
  it("drops a surrogate pair that would be split at 512 code units", () => {
    const emoji = "😀";
    const clipped = clip(`${"a".repeat(511)}${emoji}${"z".repeat(20)}`);
    expect(clipped).toBe("a".repeat(511));
    expect(clip("driver cwd must not be a symlink")).toBe("driver cwd must not be a symlink");
  });
});

describe("prepareParticipantCwd", () => {
  it("creates a dedicated directory and accepts another call for the same id", async () => {
    const root = join(tempRoot, "work");
    const id = `a${"b".repeat(127)}`;
    const first = await prepareParticipantCwd(root, id);
    const second = await prepareParticipantCwd(root, "seat.v1_a");
    expect(first).toBe(join(root, id));
    expect(second).toBe(join(root, "seat.v1_a"));
    expect((await lstat(first)).isDirectory()).toBe(true);
    expect(await prepareParticipantCwd(root, id)).toBe(first);
  });

  it("rejects relative roots, unsafe ids, symlinks, and non-directories", async () => {
    const root = join(tempRoot, "work");
    await expect(prepareParticipantCwd("relative/root", "seat")).rejects.toEqual(
      spawnFailed("driverWorkRoot must be an absolute path", "seat"),
    );
    for (const id of ["", ".hidden", "-bad", "a/b", "a b", `a${"b".repeat(128)}`]) {
      await expect(prepareParticipantCwd(root, id)).rejects.toEqual(
        spawnFailed("participantId is not safe for a dedicated cwd", id || undefined),
      );
    }

    await mkdir(root, { recursive: true });
    const elsewhere = join(tempRoot, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(root, "p-link"));
    await expect(prepareParticipantCwd(root, "p-link")).rejects.toEqual(
      spawnFailed("participant cwd must not be a symlink", "p-link"),
    );

    await writeFile(join(root, "p-file"), "x");
    await expect(prepareParticipantCwd(root, "p-file")).rejects.toEqual(
      spawnFailed("participant cwd exists and is not a directory", "p-file"),
    );
  });

  it("rejects a participant directory reached through an ancestor symlink", async () => {
    const outside = join(tempRoot, "outside");
    await mkdir(join(outside, "p-1"), { recursive: true });
    await writeFile(join(outside, "p-1", "keep.txt"), "SECRET\n");
    const root = join(tempRoot, "linked-root");
    await symlink(outside, root);
    await expect(prepareParticipantCwd(root, "p-1")).rejects.toEqual(
      spawnFailed("participant cwd must not be a symlink", "p-1"),
    );
    expect((await lstat(root)).isSymbolicLink()).toBe(true);
    expect(await readdir(join(outside, "p-1"))).toEqual(["keep.txt"]);
    expect(await readFile(join(outside, "p-1", "keep.txt"), "utf8")).toBe("SECRET\n");
  });

  it("rethrows filesystem errors other than a missing path", async () => {
    const locked = join(tempRoot, "locked");
    await mkdir(locked);
    await chmod(locked, 0);
    try {
      await expect(prepareParticipantCwd(locked, "seat")).rejects.toMatchObject({
        code: "EACCES",
        syscall: "lstat",
        path: join(locked, "seat"),
      });
    } finally {
      await chmod(locked, 0o755);
    }
  });
});

describe("spawnDriver spec validation", () => {
  it("rejects a bad spec before starting a watchdog", async () => {
    const supervisor = supervisorFor();
    const valid: DriverSpawnSpec = {
      participantId: "p",
      executable: process.execPath,
      argv: [],
      cwd: "/tmp",
      envInherit: [],
      envSet: {},
    };
    const cases: Array<{ spec: unknown; message: string; participantId?: string }> = [
      { spec: undefined, message: "participantId is required" },
      { spec: { ...valid, participantId: "" }, message: "participantId is required" },
      {
        spec: { ...valid, executable: "node" },
        message: "executable must be an absolute path",
        participantId: "p",
      },
      {
        spec: { ...valid, argv: "nope" },
        message: "argv must be an array of strings",
        participantId: "p",
      },
      {
        spec: { ...valid, argv: ["ok", 1] },
        message: "argv must be an array of strings",
        participantId: "p",
      },
      {
        spec: { ...valid, cwd: "relative" },
        message: "cwd must be an absolute path",
        participantId: "p",
      },
      {
        spec: { ...valid, envInherit: "PATH" },
        message: "envInherit must be an array of variable names",
        participantId: "p",
      },
      {
        spec: { ...valid, envInherit: ["PATH", 1] },
        message: "envInherit must be an array of variable names",
        participantId: "p",
      },
      {
        spec: { ...valid, envSet: null },
        message: "envSet must be a map of strings to strings",
        participantId: "p",
      },
      {
        spec: { ...valid, envSet: { A: 1 } },
        message: "envSet must be a map of strings to strings",
        participantId: "p",
      },
    ];
    for (const item of cases) {
      await expect(supervisor.spawnDriver(item.spec as DriverSpawnSpec)).rejects.toEqual(
        spawnFailed(item.message, item.participantId),
      );
    }
    expect(supervisor.liveCount()).toBe(0);
  });
});
