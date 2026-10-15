#!/usr/bin/env node
/**
 * Toy Driver fixture for process supervision tests (dependency-free).
 *
 * Reads stdin lines and answers on stdout:
 *   PING             -> "PONG"
 *   SPAWN-GRANDCHILD -> spawns `node -e "setInterval(()=>{},1000)"` in the
 *                       same process group and prints "GRANDCHILD <pid>"
 *   ENV              -> "ENV <JSON.stringify(process.env)>"
 *   SLEEP <ms>       -> sleeps, prints nothing
 *   STUBBORN         -> prints "STUBBORN-OK"; from now on SIGTERM is ignored
 *   QUIT             -> exits 0
 *
 * SIGTERM normally prints "SIGTERM-SEEN" and exits 0, so tests can observe
 * process-group signal delivery. The driver stays alive on stdin EOF; only
 * QUIT or a signal ends it.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";

let stubborn = false;

process.on("SIGTERM", () => {
  if (stubborn) return; // STUBBORN mode: ignore SIGTERM forever.
  const done = () => process.exit(0);
  try {
    // Pipe writes are async; exit only after the line is flushed.
    process.stdout.write("SIGTERM-SEEN\n", done);
    setTimeout(done, 250).unref();
  } catch {
    done();
  }
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const [command, ...rest] = line.trim().split(/\s+/);
  try {
    switch (command) {
      case "PING":
        process.stdout.write("PONG\n");
        break;
      case "SPAWN-GRANDCHILD": {
        // Not detached: the grandchild stays in the driver's process group.
        const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        process.stdout.write(`GRANDCHILD ${grandchild.pid}\n`);
        break;
      }
      case "ENV":
        process.stdout.write(`ENV ${JSON.stringify(process.env)}\n`);
        break;
      case "SLEEP": {
        const ms = Number(rest[0]) || 0;
        setTimeout(() => {}, ms);
        break;
      }
      case "STUBBORN":
        stubborn = true;
        process.stdout.write("STUBBORN-OK\n");
        break;
      case "QUIT":
        process.exit(0);
        break;
      default:
        break;
    }
  } catch {
    // Keep the fixture alive no matter what a test throws at it.
  }
});
