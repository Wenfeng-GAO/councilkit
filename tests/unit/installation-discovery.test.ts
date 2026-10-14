import { existsSync } from "node:fs";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DiscoveredInstallation,
  discoverInstallations,
  discoveryDirs,
} from "../../runtime-host/installations/discovery";
import { defaultDriverWellKnownBinDirs } from "../../shared/runtime/driver-bins";
import {
  RUNNING_AS_ROOT,
  cleanupInstallationFixtures,
  privateDir,
  writeExecutable,
} from "./installation-fixtures";

afterEach(cleanupInstallationFixtures);

async function pathBin(root: string, name: string): Promise<string> {
  const bin = join(root, name);
  await mkdir(bin, { recursive: true });
  await chmod(bin, 0o755);
  return bin;
}

describe("discoveryDirs", () => {
  it("lists unique PATH entries before the built-in well-known directories", async () => {
    const root = await privateDir("dirs-");
    const bin = await pathBin(root, "bin");
    const home = await pathBin(root, "home");
    const dirs = discoveryDirs({ env: { PATH: `${bin}::${bin}:`, HOME: home } });
    expect(dirs).toEqual([
      { dir: bin, source: "path" },
      { dir: "/opt/homebrew/bin", source: "well-known" },
      { dir: "/usr/local/bin", source: "well-known" },
      { dir: "/usr/bin", source: "well-known" },
      { dir: join(home, ".local", "bin"), source: "well-known" },
      { dir: join(home, "bin"), source: "well-known" },
      { dir: join(home, ".kimi-code", "bin"), source: "well-known" },
      { dir: join(home, ".grok", "bin"), source: "well-known" },
    ]);
  });

  it("does not repeat a well-known directory that is already on PATH", async () => {
    const root = await privateDir("dedupe-");
    const home = await pathBin(root, "home");
    const userBin = join(home, "bin");
    const dirs = discoveryDirs({
      env: { PATH: `/usr/bin:${userBin}`, HOME: home },
      wellKnownDirs: ["/usr/bin", "", userBin, userBin],
    });
    expect(dirs).toEqual([
      { dir: "/usr/bin", source: "path" },
      { dir: userBin, source: "path" },
    ]);
  });

  it("uses the process environment when no options are passed", () => {
    const pathEntries = (process.env.PATH ?? "")
      .split(delimiter)
      .filter((entry) => entry.length > 0);
    const uniquePath: string[] = [];
    for (const entry of pathEntries) {
      if (!uniquePath.includes(entry)) uniquePath.push(entry);
    }
    const dirs = discoveryDirs();
    expect(dirs.slice(0, uniquePath.length)).toEqual(
      uniquePath.map((dir) => ({ dir, source: "path" })),
    );
    const rest = dirs.slice(uniquePath.length);
    expect(rest.every((entry) => entry.source === "well-known")).toBe(true);
    const seen = new Set(uniquePath);
    const expectedRest = defaultDriverWellKnownBinDirs(process.env).filter((dir) => {
      if (!dir || seen.has(dir)) return false;
      seen.add(dir);
      return true;
    });
    expect(rest).toEqual(expectedRest.map((dir) => ({ dir, source: "well-known" })));
  });

  it("treats a missing PATH as no PATH entries", async () => {
    const root = await privateDir("nopath-");
    const home = await pathBin(root, "home");
    const dirs = discoveryDirs({ env: { HOME: home }, wellKnownDirs: [join(home, "bin")] });
    expect(dirs).toEqual([{ dir: join(home, "bin"), source: "well-known" }]);
  });
});

describe("discoverInstallations", () => {
  it("returns every known driver in scan order and ignores backend binaries without cld", async () => {
    const root = await privateDir("all-");
    const bin = await pathBin(root, "bin");
    const later = await pathBin(root, "later");
    await writeExecutable(bin, "cld", "wrapper");
    await writeExecutable(bin, "claude", "claude-bin");
    await writeExecutable(later, "cfuse-claude-code", "cfuse-bin");
    await writeExecutable(bin, "codex", "codex-bin");
    await writeExecutable(bin, "kimi", "kimi-bin");
    await writeExecutable(bin, "grok", "grok-bin");
    await writeExecutable(bin, "cursor-agent", "cursor-bin");
    // Backends alone must not become installations. They are covered above
    // because cld is present; a second scan without cld is asserted below.
    const outcome = discoverInstallations({
      env: { PATH: `${bin}:${later}` },
      wellKnownDirs: [],
    });
    const expected: DiscoveredInstallation[] = [
      {
        name: "cld",
        driverId: "claude-stream-json",
        wrapper: { name: "cld", path: join(bin, "cld"), source: "path", pathIndex: 0 },
        claude: { name: "claude", path: join(bin, "claude"), source: "path", pathIndex: 0 },
        cfuse: {
          name: "cfuse-claude-code",
          path: join(later, "cfuse-claude-code"),
          source: "path",
          pathIndex: 1,
        },
      },
      {
        name: "codex",
        driverId: "codex-app-server",
        wrapper: { name: "codex", path: join(bin, "codex"), source: "path", pathIndex: 0 },
        claude: null,
        cfuse: null,
      },
      {
        name: "kimi",
        driverId: "kimi-stream-json",
        wrapper: { name: "kimi", path: join(bin, "kimi"), source: "path", pathIndex: 0 },
        claude: null,
        cfuse: null,
      },
      {
        name: "grok",
        driverId: "grok-stream-json",
        wrapper: { name: "grok", path: join(bin, "grok"), source: "path", pathIndex: 0 },
        claude: null,
        cfuse: null,
      },
      {
        name: "cursor-agent",
        driverId: "cursor-stream-json",
        wrapper: {
          name: "cursor-agent",
          path: join(bin, "cursor-agent"),
          source: "path",
          pathIndex: 0,
        },
        claude: null,
        cfuse: null,
      },
    ];
    expect(outcome).toEqual({ installations: expected });

    const backendsOnly = discoverInstallations({
      env: { PATH: later },
      wellKnownDirs: [],
    });
    expect(backendsOnly).toEqual({ installations: [] });
  });

  it.skipIf(RUNNING_AS_ROOT)(
    "keeps the first PATH hit and skips non-files, broken symlinks, and unreadable directories",
    async () => {
      const root = await privateDir("skip-");
      const decoy = await pathBin(root, "decoy");
      const locked = await pathBin(root, "locked");
      const real = await pathBin(root, "real");
      await mkdir(join(decoy, "codex"), { recursive: true });
      await symlink(join(decoy, "missing-target"), join(decoy, "kimi"));
      const marker = join(root, "executed");
      const chosen = await writeExecutable(
        real,
        "codex",
        `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`,
      );
      await writeExecutable(locked, "codex", "hidden");
      await chmod(locked, 0o000);
      const outcome = discoverInstallations({
        env: { PATH: `${decoy}:${locked}:${real}` },
        wellKnownDirs: [],
      });
      expect(outcome).toEqual({
        installations: [
          {
            name: "codex",
            driverId: "codex-app-server",
            wrapper: { name: "codex", path: chosen, source: "path", pathIndex: 2 },
            claude: null,
            cfuse: null,
          },
        ],
      });
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("reports a well-known hit after PATH directories and returns the symlink path", async () => {
    const root = await privateDir("well-");
    const pathDir = await pathBin(root, "path");
    const wellKnown = await pathBin(root, "well");
    const targetDir = await pathBin(root, "target");
    const target = await writeExecutable(targetDir, "codex-real", "target-bytes");
    const link = join(wellKnown, "codex");
    await symlink(target, link);
    const cldOnly = await writeExecutable(pathDir, "cld", "wrapper-only");
    const outcome = discoverInstallations({
      env: { PATH: pathDir },
      wellKnownDirs: [join(root, "missing"), wellKnown],
    });
    expect(outcome).toEqual({
      installations: [
        {
          name: "cld",
          driverId: "claude-stream-json",
          wrapper: { name: "cld", path: cldOnly, source: "path", pathIndex: 0 },
          claude: null,
          cfuse: null,
        },
        {
          name: "codex",
          driverId: "codex-app-server",
          wrapper: { name: "codex", path: link, source: "well-known", pathIndex: 2 },
          claude: null,
          cfuse: null,
        },
      ],
    });
  });

  it("ignores a PATH entry that is a file rather than a directory", async () => {
    const root = await privateDir("file-path-");
    const bin = await pathBin(root, "bin");
    const notDir = await writeExecutable(root, "not-a-dir", "x", 0o644);
    const codex = await writeExecutable(bin, "codex", "ok");
    const outcome = discoverInstallations({
      env: { PATH: `${notDir}:${bin}` },
      wellKnownDirs: [],
    });
    expect(outcome.installations).toEqual([
      {
        name: "codex",
        driverId: "codex-app-server",
        wrapper: { name: "codex", path: codex, source: "path", pathIndex: 1 },
        claude: null,
        cfuse: null,
      },
    ]);
  });
});
