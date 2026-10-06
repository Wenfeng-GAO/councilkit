import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("acquireExclusiveLock", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("lets one of two aligned processes hold the lock", async () => {
    for (let trial = 0; trial < 8; trial += 1) {
      const root = mkdtempSync(join(tmpdir(), "ck-exclusive-lock-"));
      roots.push(root);
      const pair = [
        startAlignedAcquire(join(root, "lock")),
        startAlignedAcquire(join(root, "lock")),
      ];
      try {
        await Promise.all(pair.map((holder) => holder.ready));
        const start = Date.now() + 40;
        for (const holder of pair) holder.child.stdin?.write(`${start}\n`);
        const results = await Promise.all(pair.map((holder) => holder.finished));
        expect(results.filter((result) => result === "held")).toEqual(["held"]);
      } finally {
        for (const holder of pair) holder.child.kill("SIGKILL");
        await Promise.all(pair.map((holder) => holder.exited));
      }
    }
  });
});

function startAlignedAcquire(lockPath: string): {
  child: ChildProcess;
  ready: Promise<void>;
  finished: Promise<"held" | "busy">;
  exited: Promise<void>;
} {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
        import { acquireExclusiveLock, LockBusyError } from ${JSON.stringify(join(process.cwd(), "shared/runtime/exclusive-lock.ts"))};
        const lockPath = ${JSON.stringify(lockPath)};
        console.log("ready");
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          input += chunk;
          const line = input.split("\\n")[0];
          if (!line) return;
          const start = Number(line);
          while (Date.now() < start) {}
          try {
            const held = acquireExclusiveLock(lockPath);
            console.log("held");
            // The timer closes over the handle. Collecting it closes the database and drops the lock.
            setInterval(() => {
              if (held === undefined) process.exit(1);
            }, 1000);
          } catch (error) {
            if (error instanceof LockBusyError) {
              console.log("busy");
              process.exit(0);
            }
            console.log(error instanceof Error ? error.message : String(error));
            process.exit(1);
          }
        });
      `,
    ],
    { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
  let text = "";
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`aligned acquire did not start: ${text}`)),
      4000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`aligned acquire exited early: ${text}`));
    });
  });
  const finished = new Promise<"held" | "busy">((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`aligned acquire stalled: ${text}`)), 4000);
    const onData = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("held")) {
        clearTimeout(timer);
        resolve("held");
      }
      if (text.includes("busy")) {
        clearTimeout(timer);
        resolve("busy");
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (text.includes("held")) resolve("held");
      else if (text.includes("busy")) resolve("busy");
      else reject(new Error(`aligned acquire failed (${code}): ${text}`));
    });
  });
  return { child, ready, finished, exited };
}
