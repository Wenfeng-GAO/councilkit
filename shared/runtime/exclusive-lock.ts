import { chmodSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);

export class LockBusyError extends Error {
  constructor() {
    super("lock held");
    this.name = "LockBusyError";
  }
}

export interface ExclusiveLock {
  release(): void;
}

export function acquireExclusiveLock(lockPath: string): ExclusiveLock {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let db: DatabaseSync | undefined;
    try {
      db = openLockDatabase(lockPath);
      chmodSync(lockPath, 0o600);
      db.exec("BEGIN EXCLUSIVE");
      return {
        release() {
          try {
            db?.exec("ROLLBACK");
          } catch {}
          try {
            db?.close();
          } catch {}
        },
      };
    } catch (error) {
      try {
        db?.close();
      } catch {}
      if (isDatabaseLocked(error)) throw new LockBusyError();
      if (attempt === 0 && isNotDatabase(error)) {
        try {
          unlinkSync(lockPath);
        } catch {}
        continue;
      }
      throw error;
    }
  }
  throw new LockBusyError();
}

function openLockDatabase(lockPath: string): DatabaseSync {
  const restore = suppressSqliteExperimentalWarning();
  try {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    return new DatabaseSync(lockPath);
  } finally {
    restore();
  }
}

function suppressSqliteExperimentalWarning(): () => void {
  const original = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const message =
      typeof warning === "string"
        ? warning
        : warning instanceof Error
          ? warning.message
          : String(warning);
    if (message.includes("SQLite")) return;
    return original.call(process, warning as never, ...(args as never[]));
  }) as typeof process.emitWarning;
  return () => {
    process.emitWarning = original;
  };
}

function isDatabaseLocked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /database is locked|SQLITE_BUSY/i.test(message);
}

function isNotDatabase(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /not a database/i.test(message);
}
