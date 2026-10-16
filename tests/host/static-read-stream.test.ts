import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { CANONICAL_HOST_HEADER, CANONICAL_PORT } from "@shared/runtime/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type TestHost, createTestHost } from "./helpers";

let host: TestHost | null = null;

afterEach(async () => {
  await host?.cleanup();
  host = null;
});

// V1 ships on macOS, which has no /proc. Linux CI has /proc and may not have lsof.
function fdTargets(needle: string): string[] {
  if (existsSync("/proc/self/fd")) {
    return readdirSync("/proc/self/fd")
      .map((fd) => {
        try {
          return readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          return "";
        }
      })
      .filter((target) => target.includes(needle));
  }
  const command = ["/usr/sbin/lsof", "/usr/bin/lsof"].find((path) => existsSync(path)) ?? "lsof";
  // -F n prints the full path. A tty-width table can truncate it before the file name.
  const result = spawnSync(command, ["-nP", "-F", "n", "-p", String(process.pid)], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = result.stdout ?? "";
  if (output.length === 0) {
    throw new Error(`lsof exited ${result.status ?? "null"}: ${result.stderr || "no output"}`);
  }
  return output.split("\n").filter((line) => line.includes(needle));
}

function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${path}`)), 2_000);
    const req = request(
      {
        hostname: "127.0.0.1",
        port: CANONICAL_PORT,
        path,
        method: "GET",
        headers: { Host: CANONICAL_HOST_HEADER },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

describe("production static file streams", () => {
  it("serves a readable asset and falls back when the file is absent", async () => {
    host = await createTestHost();
    const asset = await rawGet("/assets/index.js");
    expect(asset.status).toBe(200);
    expect(asset.body).toContain("console.log");

    const missing = await rawGet("/assets/missing.js");
    expect(missing.status).toBe(200);
    expect(missing.body).toContain('<div id="root"></div>');

    const payload = "y".repeat(256 * 1024);
    writeFileSync(join(host.services.config.distDir, "assets", "blob.js"), payload);
    const blob = await rawGet("/assets/blob.js");
    expect(blob.status).toBe(200);
    expect(blob.body).toBe(payload);
  });

  it("returns 500 when a static file cannot be read and keeps serving", async () => {
    host = await createTestHost();
    const assetPath = join(host.services.config.distDir, "assets", "index.js");
    chmodSync(assetPath, 0o000);
    const uncaught: string[] = [];
    const onUncaught = (error: Error): void => {
      uncaught.push(error.message);
    };
    process.on("uncaughtException", onUncaught);
    try {
      const asset = await rawGet("/assets/index.js");
      expect(asset.status).toBe(500);
      expect(asset.body).toContain("INTERNAL");
      expect(asset.body).not.toContain(host.services.config.distDir);
      expect(uncaught).toEqual([]);

      const home = await rawGet("/");
      expect(home.status).toBe(200);
      expect(home.body).toContain('<div id="root"></div>');
    } finally {
      process.off("uncaughtException", onUncaught);
      chmodSync(assetPath, 0o644);
    }
  });

  it("closes the file when the client aborts a static download", async () => {
    host = await createTestHost();
    const name = "big.js";
    writeFileSync(join(host.services.config.distDir, "assets", name), "x".repeat(2 * 1024 * 1024));
    let chunks = 0;
    let openDuringBody: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      await abortAfterFirstChunk(`/assets/${name}`, () => {
        chunks += 1;
        if (openDuringBody.length === 0) openDuringBody = fdTargets(name);
      });
    }
    expect(chunks).toBe(5);
    expect(openDuringBody.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fdTargets(name)).toEqual([]);
  });
});

function abortAfterFirstChunk(path: string, onChunk: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no body chunk for ${path}`)), 2_000);
    let sawChunk = false;
    const req = request(
      {
        hostname: "127.0.0.1",
        port: CANONICAL_PORT,
        path,
        method: "GET",
        headers: { Host: CANONICAL_HOST_HEADER },
      },
      (res) => {
        res.once("data", () => {
          sawChunk = true;
          try {
            onChunk();
          } catch (error) {
            clearTimeout(timer);
            req.destroy();
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          clearTimeout(timer);
          req.destroy();
          resolve();
        });
        res.on("end", () => {
          if (sawChunk) return;
          clearTimeout(timer);
          reject(new Error(`response ended before a chunk for ${path}`));
        });
      },
    );
    req.on("error", (error: Error) => {
      if (sawChunk) return;
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}
