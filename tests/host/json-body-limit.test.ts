import { request } from "node:http";
import { connect } from "node:net";
import type { Route } from "@host/server";
import { CANONICAL_HOST_HEADER, CANONICAL_PORT, LIMITS } from "@shared/runtime/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type TestHost, createTestHost } from "./helpers";

/**
 * Content-Length is a decimal byte count. Node will not finish the request
 * until that many bytes arrive, so an over-limit header has to be rejected
 * before the read loop. A body with no usable length still stops at 4 MiB.
 */

let host: TestHost | null = null;
let hits = 0;

afterEach(async () => {
  await host?.cleanup();
  host = null;
  hits = 0;
});

function probeRoute(): Route {
  return {
    method: "POST",
    pattern: "/api/v1/body-probe",
    auth: "public",
    bodySchema: z.object({}).passthrough(),
    handler: () => {
      hits += 1;
      return { seen: true };
    },
  };
}

interface JsonBody {
  ok: boolean;
  error?: { code: string };
  data?: { seen?: boolean };
}

function post(
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; json: JsonBody }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: CANONICAL_PORT,
        path: "/api/v1/body-probe",
        method: "POST",
        headers: {
          Host: CANONICAL_HOST_HEADER,
          "Content-Type": "application/json",
          ...headers,
        },
        timeout: 3000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: JsonBody = { ok: false };
          try {
            json = JSON.parse(text) as JsonBody;
          } catch {
            json = { ok: false };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timed out"));
    });
    req.on("error", (error) => {
      reject(error);
    });
    req.end(body);
  });
}

function rawExchange(payload: Buffer): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: CANONICAL_PORT });
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(raw)?.[1] ?? 0);
      if (status !== 0) {
        resolve({ status, raw });
        return;
      }
      reject(error ?? new Error(`no response:\n${raw.slice(0, 300)}`));
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("raw request timed out"));
    }, 8000);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => {
      clearTimeout(timer);
      finish(error);
    });
    socket.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    socket.end(payload);
  });
}

describe("JSON body limit", () => {
  it("rejects an over-limit Content-Length before reading the body", async () => {
    host = await createTestHost({ routes: [probeRoute()] });
    const over = String(LIMITS.httpBodyBytes + 1);
    for (const header of [over, "9999999999999999999", "9007199254740993", "0000004194305"]) {
      const res = await post({ "Content-Length": header }, "{}");
      expect(res.status, header).toBe(413);
      expect(res.json.error?.code, header).toBe("PAYLOAD_TOO_LARGE");
    }
    expect(hits).toBe(0);
  });

  it("accepts a padded Content-Length that is the real body size", async () => {
    host = await createTestHost({ routes: [probeRoute()] });
    const body = '{"a":1}';
    const res = await post({ "Content-Length": `000000000${body.length}` }, body);
    expect(res.status).toBe(200);
    expect(res.json.data?.seen).toBe(true);
    expect(hits).toBe(1);
  });

  it("stops a chunked body once it passes 4 MiB", async () => {
    host = await createTestHost({ routes: [probeRoute()] });
    const body = Buffer.alloc(LIMITS.httpBodyBytes + 1, 0x61);
    const payload = Buffer.concat([
      Buffer.from(
        `POST /api/v1/body-probe HTTP/1.1\r\nHost: ${CANONICAL_HOST_HEADER}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body.length.toString(16)}\r\n`,
      ),
      body,
      Buffer.from("\r\n0\r\n\r\n"),
    ]);
    const res = await rawExchange(payload);
    expect(res.status).toBe(413);
    expect(res.raw).toContain("PAYLOAD_TOO_LARGE");
    expect(hits).toBe(0);
  });
});
