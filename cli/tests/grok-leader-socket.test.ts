import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AF_UNIX_PATH_MAX_BYTES,
  GROK_LEADER_SOCK,
  ensurePrivateSocketDir,
  grokLeaderSocket,
  grokLeaderSocketDir,
  utf8ByteLength,
} from "../src/auto/driver-commands";

let roots: string[] = [];
let boundSockets: string[] = [];

afterEach(() => {
  for (const path of boundSockets) {
    try {
      const st = lstatSync(path);
      if (st.isDirectory() && !st.isSymbolicLink()) rmSync(path, { recursive: true, force: true });
      else unlinkSync(path);
    } catch {
      // already gone
    }
  }
  boundSockets = [];
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function currentUid(): number {
  const getuid = process.getuid;
  if (typeof getuid !== "function") throw new Error("getuid required");
  return getuid();
}

function tempRoot(prefix: string, base = tmpdir()): string {
  const root = mkdtempSync(join(base, prefix));
  roots.push(root);
  return root;
}

function deepWorkspace(root: string, segment: string): string {
  let ws = root;
  while (utf8ByteLength(join(ws, GROK_LEADER_SOCK)) < AF_UNIX_PATH_MAX_BYTES) {
    ws = join(ws, segment);
  }
  mkdirSync(ws, { recursive: true });
  return ws;
}

function workspaceWithGivenSocketBytes(root: string, givenBytes: number): string {
  mkdirSync(root, { recursive: true });
  const slashAndSock = utf8ByteLength(`/${GROK_LEADER_SOCK}`);
  const pad = givenBytes - utf8ByteLength(root) - 1 - slashAndSock;
  if (pad < 1) throw new Error(`root ${root} already too long for ${givenBytes} byte socket`);
  const ws = join(root, "x".repeat(pad));
  mkdirSync(ws, { recursive: true });
  return ws;
}

function bindUnix(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const fail = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once("error", fail);
    server.listen({ path }, () => {
      boundSockets.push(path);
      server.close((closeErr) => {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
        boundSockets = boundSockets.filter((row) => row !== path);
        if (closeErr) reject(closeErr);
        else resolve();
      });
    });
  });
}

function socketEndpoint(path: string): string {
  return join(realpathSync(dirname(path)), basename(path));
}

function tmpIsAliased(): boolean {
  try {
    return realpathSync("/tmp") !== "/tmp";
  } catch {
    return false;
  }
}

function deepSymlinkTo(target: string, segment = "深层别名目录"): string {
  const root = tempRoot("ck-sock-alias-", "/tmp");
  let dir = root;
  while (utf8ByteLength(join(join(dir, "alias"), GROK_LEADER_SOCK)) < AF_UNIX_PATH_MAX_BYTES) {
    dir = join(dir, segment);
  }
  mkdirSync(dir, { recursive: true });
  const alias = join(dir, "alias");
  symlinkSync(realpathSync(target), alias);
  return alias;
}

function pathSnapshot(path: string): {
  ino: number;
  dev: number;
  mode: number;
  uid: number;
  kind: string;
  content: string | null;
  linkTarget: string | null;
} {
  const st = lstatSync(path);
  const kind = st.isSymbolicLink()
    ? "symlink"
    : st.isSocket()
      ? "socket"
      : st.isDirectory()
        ? "dir"
        : st.isFile()
          ? "file"
          : "other";
  return {
    ino: st.ino,
    dev: st.dev,
    mode: st.mode,
    uid: st.uid,
    kind,
    content: kind === "file" ? readFileSync(path, "utf8") : null,
    linkTarget: kind === "symlink" ? readlinkSync(path) : null,
  };
}

function listenUnix(path: string): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ path }, () => {
      boundSockets.push(path);
      resolve(server);
    });
  });
}

function pythonBind(path: string): { ok: boolean; bytes: number; error: string | null } {
  const script = `
import os, socket, sys
path = sys.argv[1]
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    sock.bind(path)
    print("bound", len(path.encode("utf-8")))
except OSError as exc:
    print("error", len(path.encode("utf-8")), exc, file=sys.stderr)
    sys.exit(1)
finally:
    sock.close()
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
`;
  const result = spawnSync("python3", ["-c", script, path], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    bytes: utf8ByteLength(path),
    error: result.status === 0 ? null : (result.stderr || result.stdout).trim(),
  };
}

describe("grokLeaderSocket AF_UNIX path", () => {
  it("keeps a short in-workspace .grok-leader.sock path", () => {
    const ws = tempRoot("ck-sock-short-", "/tmp");
    const expected = join(ws, GROK_LEADER_SOCK);
    expect(utf8ByteLength(expected)).toBeLessThan(AF_UNIX_PATH_MAX_BYTES);
    expect(utf8ByteLength(join(realpathSync(ws), GROK_LEADER_SOCK))).toBeLessThan(
      AF_UNIX_PATH_MAX_BYTES,
    );
    expect(grokLeaderSocket(ws)).toBe(expected);
  });

  it("keeps a short unicode in-workspace path", () => {
    const ws = join(tempRoot("ck-sock-han-", "/tmp"), "项目");
    mkdirSync(ws);
    const expected = join(ws, GROK_LEADER_SOCK);
    expect(utf8ByteLength(expected)).toBeLessThan(AF_UNIX_PATH_MAX_BYTES);
    expect(grokLeaderSocket(ws)).toBe(expected);
  });

  it("uses a hashed short socket for a deep path, is stable, and actually binds", async () => {
    const ws = deepWorkspace(tempRoot("ck-sock-deep-", "/tmp"), "deep-segment-for-unix-socket");
    const inWorkspace = join(ws, GROK_LEADER_SOCK);
    expect(utf8ByteLength(inWorkspace)).toBeGreaterThanOrEqual(AF_UNIX_PATH_MAX_BYTES);
    const path = grokLeaderSocket(ws);
    expect(path).not.toBe(inWorkspace);
    expect(utf8ByteLength(path)).toBeLessThan(AF_UNIX_PATH_MAX_BYTES);
    expect(path.endsWith(".sock")).toBe(true);
    const protectedDir = realpathSync(grokLeaderSocketDir());
    expect(path.startsWith(`${protectedDir}/`)).toBe(true);
    expect(lstatSync(protectedDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(protectedDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(protectedDir).uid).toBe(currentUid());
    expect(grokLeaderSocket(ws)).toBe(path);
    await bindUnix(path);
  });

  it("hashes unicode workspaces by UTF-8 bytes and binds the short path", async () => {
    const ws = deepWorkspace(tempRoot("ck-sock-uni-", "/tmp"), "工作区");
    const inWorkspace = join(ws, GROK_LEADER_SOCK);
    expect(utf8ByteLength(inWorkspace)).toBeGreaterThanOrEqual(AF_UNIX_PATH_MAX_BYTES);
    expect(inWorkspace.length).toBeLessThan(utf8ByteLength(inWorkspace));
    const path = grokLeaderSocket(ws);
    expect(utf8ByteLength(path)).toBeLessThan(AF_UNIX_PATH_MAX_BYTES);
    expect(grokLeaderSocket(ws)).toBe(path);
    const python = pythonBind(path);
    expect(python).toEqual({ ok: true, bytes: utf8ByteLength(path), error: null });
  });

  it("hashes distinct workspaces to different sockets", () => {
    const a = deepWorkspace(tempRoot("ck-sock-a-", "/tmp"), "deep-segment-for-unix-socket");
    const b = deepWorkspace(tempRoot("ck-sock-b-", "/tmp"), "deep-segment-for-unix-socket");
    expect(grokLeaderSocket(a)).not.toBe(grokLeaderSocket(b));
  });

  it("uses the same real endpoint for a short workspace and a deep symlink alias", async () => {
    const target = tempRoot("ck-sock-short-tgt-", "/tmp");
    const alias = deepSymlinkTo(target);
    expect(realpathSync(alias)).toBe(realpathSync(target));
    expect(utf8ByteLength(join(target, GROK_LEADER_SOCK))).toBeLessThan(AF_UNIX_PATH_MAX_BYTES);
    expect(utf8ByteLength(join(alias, GROK_LEADER_SOCK))).toBeGreaterThanOrEqual(
      AF_UNIX_PATH_MAX_BYTES,
    );
    const fromTarget = grokLeaderSocket(target);
    const fromAlias = grokLeaderSocket(alias);
    const realEndpoint = join(realpathSync(target), GROK_LEADER_SOCK);
    expect(socketEndpoint(fromTarget)).toBe(realEndpoint);
    expect(socketEndpoint(fromAlias)).toBe(realEndpoint);
    expect(socketEndpoint(fromAlias)).toBe(socketEndpoint(fromTarget));
    expect(fromAlias).not.toContain(`ck-grok-${currentUid()}`);
    await bindUnix(realEndpoint);
  });

  it("hashes a deep workspace the same way through a symlink alias", () => {
    const ws = deepWorkspace(tempRoot("ck-sock-canon-", "/tmp"), "deep-segment-for-unix-socket");
    const alias = deepSymlinkTo(ws);
    const hashed = grokLeaderSocket(ws);
    expect(hashed).toBe(grokLeaderSocket(realpathSync(ws)));
    expect(hashed).toBe(grokLeaderSocket(alias));
    expect(socketEndpoint(hashed)).toBe(hashed);
  });

  it.skipIf(!tmpIsAliased())(
    "hashes when only the canonical form of a 103-byte /tmp socket exceeds AF_UNIX",
    async () => {
      const root = tempRoot("ck-sock-edge-", "/tmp");
      const ws = workspaceWithGivenSocketBytes(root, 103);
      const given = join(ws, GROK_LEADER_SOCK);
      const canonical = join(realpathSync(ws), GROK_LEADER_SOCK);
      expect(realpathSync(ws)).not.toBe(ws);
      expect(utf8ByteLength(given)).toBe(103);
      expect(utf8ByteLength(canonical)).toBeGreaterThanOrEqual(AF_UNIX_PATH_MAX_BYTES);
      const path = grokLeaderSocket(ws);
      expect(path).not.toBe(given);
      expect(utf8ByteLength(path)).toBeLessThan(AF_UNIX_PATH_MAX_BYTES);
      await bindUnix(path);
    },
  );

  it("does not use TMPDIR for the short hashed directory", () => {
    const ws = deepWorkspace(tempRoot("ck-sock-tmp-", "/tmp"), "deep-segment-for-unix-socket");
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = join("/very-long-tmpdir", "x".repeat(80));
    try {
      const path = grokLeaderSocket(ws);
      expect(path.includes("very-long-tmpdir")).toBe(false);
      expect(path.startsWith(realpathSync(grokLeaderSocketDir()))).toBe(true);
    } finally {
      if (prev === undefined) {
        // process.env.TMPDIR = undefined becomes the string "undefined".
        // biome-ignore lint/performance/noDelete: restore an unset env var
        delete process.env.TMPDIR;
      } else process.env.TMPDIR = prev;
    }
  });

  it("refuses a pre-existing file, directory, or symlink without changing inode or content", () => {
    const ws = deepWorkspace(tempRoot("ck-sock-keep-", "/tmp"), "deep-segment-for-unix-socket");
    const path = grokLeaderSocket(ws);
    writeFileSync(path, "keep-me");
    boundSockets.push(path);
    const fileBefore = pathSnapshot(path);
    expect(() => grokLeaderSocket(ws)).toThrow(/non-socket/);
    expect(pathSnapshot(path)).toEqual(fileBefore);

    unlinkSync(path);
    mkdirSync(path);
    const dirBefore = pathSnapshot(path);
    expect(() => grokLeaderSocket(ws)).toThrow(/non-socket/);
    expect(pathSnapshot(path)).toEqual(dirBefore);

    rmSync(path, { recursive: true });
    symlinkSync(join(dirname(path), "elsewhere"), path);
    const linkBefore = pathSnapshot(path);
    expect(() => grokLeaderSocket(ws)).toThrow(/symlink/);
    expect(pathSnapshot(path)).toEqual(linkBefore);
  });

  it("reuses an existing same-user AF_UNIX socket without replacing it", async () => {
    const ws = deepWorkspace(tempRoot("ck-sock-reuse-", "/tmp"), "deep-segment-for-unix-socket");
    const path = grokLeaderSocket(ws);
    const server = await listenUnix(path);
    try {
      const before = pathSnapshot(path);
      expect(before.kind).toBe("socket");
      expect(grokLeaderSocket(ws)).toBe(path);
      expect(pathSnapshot(path)).toEqual(before);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("refuses a leftover non-socket at a short in-workspace path", () => {
    const ws = tempRoot("ck-sock-short-file-", "/tmp");
    const path = join(ws, GROK_LEADER_SOCK);
    writeFileSync(path, "nope");
    const before = pathSnapshot(path);
    expect(() => grokLeaderSocket(ws)).toThrow(/non-socket/);
    expect(pathSnapshot(path)).toEqual(before);
  });

  it("rejects a symlink directory without touching the real user socket dir", () => {
    const root = tempRoot("ck-sock-hostile-", "/tmp");
    const target = join(root, "target");
    mkdirSync(target);
    const link = join(root, "link");
    symlinkSync(target, link);
    expect(() => ensurePrivateSocketDir(link)).toThrow(/not a real directory/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("rejects a non-directory and chmod's an owned directory to 0700", () => {
    const root = tempRoot("ck-sock-mode-", "/tmp");
    const file = join(root, "not-a-dir");
    writeFileSync(file, "x");
    expect(() => ensurePrivateSocketDir(file)).toThrow(/not a real directory/);
    const dir = join(root, "owned");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const resolved = ensurePrivateSocketDir(dir);
    expect(lstatSync(resolved).mode & 0o777).toBe(0o700);
    expect(lstatSync(resolved).uid).toBe(currentUid());
  });
});
