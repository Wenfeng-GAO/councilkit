import { chmodSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
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

function fdTargets(needle: string): string[] {
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
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: CANONICAL_PORT,
            path: `/assets/${name}`,
            method: "GET",
            headers: { Host: CANONICAL_HOST_HEADER },
          },
          (res) => {
            res.once("data", () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on("error", () => resolve());
        req.end();
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fdTargets(name)).toEqual([]);
  });
});
