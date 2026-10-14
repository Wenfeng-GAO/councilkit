import { statSync } from "node:fs";
import { chmod, mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateExecutable } from "../../runtime-host/installations/validation";
import {
  RUNNING_AS_ROOT,
  cleanupInstallationFixtures,
  fingerprintOf,
  privateDir,
  worldWritableDir,
  writeExecutable,
} from "./installation-fixtures";

afterEach(cleanupInstallationFixtures);

describe("validateExecutable", () => {
  it("pins realpath, owner, mode bits, and a sha256 of the file bytes", async () => {
    const root = await privateDir("ok-");
    const targetDir = join(root, "target");
    const linkDir = join(root, "bin");
    const target = await writeExecutable(targetDir, "codex-real", "#!/bin/sh\nexit 0\n", 0o755);
    await mkdir(linkDir, { recursive: true });
    await chmod(linkDir, 0o755);
    const link = join(linkDir, "codex");
    await symlink(target, link);
    const resolved = await realpath(target);
    const info = statSync(resolved);
    const expected = {
      ok: true as const,
      record: {
        realpath: resolved,
        fingerprint: fingerprintOf(resolved),
        mode: info.mode & 0o7777,
        uid: info.uid,
        gid: info.gid,
      },
    };
    expect(validateExecutable(link)).toEqual(expected);
    expect(validateExecutable(link, { uid: info.uid })).toEqual(expected);
  });

  it("returns not_found for a missing path and for a path through a non-directory", async () => {
    const root = await privateDir("missing-");
    const missing = join(root, "missing");
    expect(validateExecutable(missing)).toEqual({
      ok: false,
      reason: "not_found",
      detail: `Executable "${missing}" does not exist.`,
    });
    const file = await writeExecutable(root, "not-a-dir", "x", 0o644);
    const child = join(file, "codex");
    expect(validateExecutable(child)).toEqual({
      ok: false,
      reason: "not_found",
      detail: `Executable "${child}" does not exist.`,
    });
  });

  it.skipIf(RUNNING_AS_ROOT)("returns unreadable when the path cannot be resolved", async () => {
    const root = await privateDir("unreadable-");
    const locked = join(root, "locked");
    const hidden = await writeExecutable(locked, "codex", "secret");
    await chmod(locked, 0o000);
    expect(validateExecutable(hidden)).toEqual({
      ok: false,
      reason: "unreadable",
      detail: `Executable "${hidden}" cannot be inspected (EACCES).`,
    });

    const loopA = join(root, "loop-a");
    const loopB = join(root, "loop-b");
    await symlink(loopB, loopA);
    await symlink(loopA, loopB);
    expect(validateExecutable(loopA)).toEqual({
      ok: false,
      reason: "unreadable",
      detail: `Executable "${loopA}" cannot be inspected (ELOOP).`,
    });
  });

  it("rejects directories and files without the owner execute bit", async () => {
    const root = await privateDir("exec-");
    const dir = join(root, "dir-candidate");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    const resolvedDir = await realpath(dir);
    expect(validateExecutable(dir)).toEqual({
      ok: false,
      reason: "not_executable",
      detail: `"${resolvedDir}" is not a regular file.`,
    });

    const plain = await writeExecutable(root, "plain", "x", 0o644);
    const resolvedPlain = await realpath(plain);
    expect(validateExecutable(plain)).toEqual({
      ok: false,
      reason: "not_executable",
      detail: `"${resolvedPlain}" lacks the owner execute bit.`,
    });
  });

  it("rejects a file owned by someone other than the allowed uid or root", async () => {
    const root = await privateDir("owner-");
    const path = await writeExecutable(root, "codex", "x");
    const resolved = await realpath(path);
    const uid = statSync(resolved).uid;
    expect(validateExecutable(path, { uid: uid + 1 })).toEqual({
      ok: false,
      reason: "bad_owner",
      detail: `"${resolved}" is owned by uid ${uid}, not the current user or root.`,
    });
  });

  it("rejects group- or other-writable files and directories in the path chain", async () => {
    const root = await privateDir("write-");
    const otherWritable = await writeExecutable(root, "codex", "x", 0o707);
    const resolvedFile = await realpath(otherWritable);
    expect(validateExecutable(otherWritable)).toEqual({
      ok: false,
      reason: "writable_path",
      detail: `"${resolvedFile}" is group- or other-writable.`,
    });

    const mid = join(root, "mid");
    const bin = join(mid, "bin");
    const nested = await writeExecutable(bin, "codex", "x");
    await chmod(mid, 0o707);
    const resolvedMid = await realpath(mid);
    expect(validateExecutable(nested)).toEqual({
      ok: false,
      reason: "writable_path",
      detail: `Directory "${resolvedMid}" in the path chain is group- or other-writable.`,
    });
  });

  it("rejects an executable placed under a world-writable directory", async () => {
    const root = await worldWritableDir("ck-world-");
    const path = await writeExecutable(root, "codex", "x");
    await chmod(root, 0o777);
    expect(validateExecutable(path)).toEqual({
      ok: false,
      reason: "writable_path",
      detail: `Directory "${await realpath(root)}" in the path chain is group- or other-writable.`,
    });
  });

  it.skipIf(RUNNING_AS_ROOT)(
    "returns unreadable when the executable bytes cannot be hashed",
    async () => {
      const root = await privateDir("hash-");
      const path = await writeExecutable(root, "codex", "secret-bytes", 0o111);
      const resolved = await realpath(path);
      expect(validateExecutable(path)).toEqual({
        ok: false,
        reason: "unreadable",
        detail: `"${resolved}" cannot be fingerprinted (EACCES).`,
      });
    },
  );
});
