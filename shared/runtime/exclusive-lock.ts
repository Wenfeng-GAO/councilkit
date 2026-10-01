import {
  constants,
  type Stats,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";

const NO_PID_LOCK_STALE_MS = 5_000;

export class LockBusyError extends Error {
  constructor() {
    super("lock held");
    this.name = "LockBusyError";
  }
}

export function acquireExclusiveLock(lockPath: string): number {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, `${process.pid}\n`);
        fsyncSync(fd);
      } catch (error) {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {}
        throw error;
      }
      return fd;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP") {
        try {
          unlinkSync(lockPath);
        } catch {}
        continue;
      }
      if (code !== "EEXIST") throw error;
      if (!staleExclusiveLock(lockPath)) throw new LockBusyError();
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
  throw new LockBusyError();
}

export function releaseExclusiveLock(lockPath: string, fd: number): void {
  try {
    closeSync(fd);
  } catch {}
  try {
    unlinkSync(lockPath);
  } catch {}
}

function staleExclusiveLock(lockPath: string): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(lockPath);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return true;
  let text = "";
  try {
    text = readFileSync(lockPath, "utf8").trim();
  } catch {
    return false;
  }
  const pid = Number(text);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "EPERM";
    }
  }
  return Date.now() - stat.mtimeMs >= NO_PID_LOCK_STALE_MS;
}
