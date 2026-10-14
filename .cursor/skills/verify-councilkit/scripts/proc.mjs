/**
 * Process and port helpers for the CouncilKit verification skill.
 *
 * Identity is always a recorded PID plus cwd and command line. Nothing here
 * selects processes by name alone, and nothing sends a signal.
 */
import { createServer } from "node:net";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const LISTEN_STATE = "0A";

export function listProcs() {
  const procs = [];
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return procs;
  }
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    const proc = readProc(pid);
    if (proc) procs.push(proc);
  }
  return procs;
}

export function readProc(pid) {
  const base = `/proc/${pid}`;
  let stat;
  let cmd = "";
  let cwd = null;
  try {
    stat = readFileSync(`${base}/stat`, "utf8");
    cmd = readFileSync(`${base}/cmdline`).toString("utf8").replaceAll("\0", " ").trim();
  } catch {
    return null;
  }
  try {
    cwd = realpathSync(readlinkSync(`${base}/cwd`));
  } catch {
    cwd = null;
  }
  const parsed = parseStat(stat);
  if (!parsed) return null;
  return { pid, cmd, cwd, ...parsed };
}

/** Clock ticks since boot. Used to detect PID reuse before a signal. */

function parseStat(stat) {
  const rparen = stat.lastIndexOf(")");
  if (rparen < 0) return null;
  const rest = stat.slice(rparen + 2).trim().split(/\s+/);
  if (rest.length < 20) return null;
  return {
    state: rest[0],
    ppid: Number(rest[1]),
    pgrp: Number(rest[2]),
    session: Number(rest[3]),
    starttime: Number(rest[19]),
  };
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Root PID plus every process whose parent chain reaches it. */
export function descendants(rootPid) {
  const procs = listProcs();
  const children = new Map();
  for (const proc of procs) {
    const list = children.get(proc.ppid) ?? [];
    list.push(proc.pid);
    children.set(proc.ppid, list);
  }
  const out = [];
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}

export function ancestors(pid) {
  const out = [];
  const seen = new Set();
  let current = pid;
  while (current > 0 && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    const proc = readProc(current);
    if (!proc) break;
    current = proc.ppid;
  }
  return out;
}

/**
 * Other processes whose cwd is `root` or a directory inside it.
 * Excludes this process, its parents, and any extra PIDs.
 */
export function holders(root, extraExclude = []) {
  const exclude = new Set(ancestors(process.pid));
  exclude.add(process.pid);
  for (const pid of extraExclude) exclude.add(pid);
  const rootReal = realpathSync(root);
  const found = [];
  for (const proc of listProcs()) {
    if (exclude.has(proc.pid) || proc.cwd === null) continue;
    if (proc.cwd === rootReal || proc.cwd.startsWith(`${rootReal}/`)) {
      found.push(proc);
    }
  }
  found.sort((a, b) => a.pid - b.pid);
  return found;
}

export function isVerificationProcess(proc, cwd) {
  if (!proc || proc.cwd !== cwd) return false;
  const cmd = proc.cmd;
  if (cmd.includes("host-supervise.mjs")) return true;
  if (cmd.includes("runtime-host/main.ts")) return true;
  if (cmd.includes("dist-host/main.mjs")) return true;
  if (cmd.includes("pnpm") && /(^|\s)(dev|start)(\s|$)/.test(cmd)) return true;
  if (cmd.includes("tsx") && cmd.includes("runtime-host")) return true;
  return false;
}

export function listenerPids(port) {
  const fromSs = listenerPidsFromSs(port);
  if (fromSs) return fromSs;
  return listenerPidsFromProc(port);
}

function listenerPidsFromSs(port) {
  try {
    const out = execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set();
    for (const match of out.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
    return [...pids];
  } catch {
    return null;
  }
}

function listenerPidsFromProc(port) {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const [addr, hexPort] = fields[1].split(":");
      if (!hexPort || hexPort.toUpperCase() !== portHex) continue;
      if (fields[3].toUpperCase() !== LISTEN_STATE) continue;
      if (!isLocalAddress(addr)) continue;
      inodes.add(fields[9]);
    }
  }
  if (inodes.size === 0) return [];
  const pids = new Set();
  for (const proc of listProcs()) {
    let fds;
    try {
      fds = readdirSync(`/proc/${proc.pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = readlinkSync(`/proc/${proc.pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match && inodes.has(match[1])) pids.add(proc.pid);
    }
  }
  return [...pids];
}

function isLocalAddress(hex) {
  const value = hex.toUpperCase();
  // 127.0.0.1 little-endian, 0.0.0.0, and IPv6 loopback / v4-mapped forms.
  return (
    value === "0100007F" ||
    value === "00000000" ||
    value === "00000000000000000000000000000001" ||
    value === "0000000000000000000000000100007F" ||
    value.endsWith("0100007F")
  );
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => {
          if (port > 0 && port !== 43127) resolve(port);
          else if (left > 1) attempt(left - 1);
          else reject(new Error("could not allocate a port other than 43127"));
        });
      });
    };
    attempt(20);
  });
}

async function selfTest() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const pids = listenerPids(port);
    if (!pids.includes(process.pid)) {
      throw new Error(
        `listener lookup failed for 127.0.0.1:${port}; saw [${pids.join(", ")}], expected ${process.pid}`,
      );
    }
    if (port === 43127) throw new Error("self-test bound the canonical port");
    process.stdout.write(`ok port=${port} pid=${process.pid}\n`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function printPids(pids) {
  for (const pid of pids) process.stdout.write(`${pid}\n`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
await runCli(process.argv.slice(2));
}

async function runCli(argv) {
const [command, ...rest] = argv;

function flag(name) {
  const index = rest.indexOf(name);
  if (index === -1 || rest[index + 1] === undefined) return null;
  return rest[index + 1];
}

if (command === "free-port") {
  const port = await freePort();
  process.stdout.write(`${port}\n`);
} else if (command === "listeners") {
  const port = Number(flag("--port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write("listeners requires --port\n");
    process.exit(2);
  }
  printPids(listenerPids(port));
} else if (command === "descendants") {
  const pid = Number(flag("--pid"));
  printPids(descendants(pid));
} else if (command === "ancestors") {
  const pid = Number(flag("--pid"));
  printPids(ancestors(pid));
} else if (command === "alive") {
  const pid = Number(flag("--pid"));
  process.exit(alive(pid) ? 0 : 1);
} else if (command === "holders") {
  const root = flag("--root");
  if (!root) {
    process.stderr.write("holders requires --root\n");
    process.exit(2);
  }
  const extra = (flag("--exclude") ?? "")
    .split(",")
    .map((part) => Number(part))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  for (const proc of holders(root, extra)) {
    process.stdout.write(`${proc.pid}\t${proc.cwd}\t${proc.cmd}\n`);
  }
} else if (command === "self-test") {
  await selfTest();
} else {
  process.stderr.write(
    "usage: proc.mjs free-port|listeners --port N|descendants --pid N|ancestors --pid N|alive --pid N|holders --root PATH [--exclude pids]|self-test\n",
  );
  process.exit(2);
}
}
