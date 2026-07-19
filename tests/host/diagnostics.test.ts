import { request } from "node:http";
import { createLogger } from "@host/logging";
import { diagnosticsRoutes } from "@host/routes/diagnostics";
import { CANONICAL_HOST_HEADER, CANONICAL_PORT } from "@shared/runtime/contracts";
import {
  type DiagnosticsResponse,
  type InstallationDto,
  diagnosticsResponseSchema,
} from "@shared/runtime/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { type TestHost, authedHeaders, createTestHost } from "./helpers";

// ---------------------------------------------------------------------------
// Sensitive-vocabulary scan (S6 acceptance): the diagnostics bundle must
// NEVER carry prompts, model output, tokens, cookies, secrets or env dumps.
// FORBIDDEN is the single vocabulary list for the whole file. Applying it to
// string VALUES as bare substring matching is intentionally strict — it only
// holds because every fixture below is controlled seed data, and it doubles
// as a regression net for the production route: if a future log event name
// introduces e.g. "session reconciliation", this test forces the vocabulary
// to be narrowed at the route first. Do not delete words to make it pass.
// ---------------------------------------------------------------------------
const FORBIDDEN = [
  /csrf/i,
  /session/i,
  /token/i,
  /cookie/i,
  /prompt/i,
  /output/i,
  /secret/i,
  /env/i,
  /api[-_]?key/i,
  /bearer/i,
  /password/i,
];

function* walk(
  node: unknown,
  path: string[] = [],
): Generator<{ path: string[]; key?: string; value?: string }> {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      yield* walk(node[i], [...path, String(i)]);
    }
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      yield { path: [...path, key], key };
      yield* walk(value, [...path, key]);
    }
    return;
  }
  if (typeof node === "string") {
    yield { path, value: node };
  }
}

// Controlled seeds: every string is verified free of FORBIDDEN vocabulary.
const FAKE_INSTALLATION: InstallationDto = {
  installationId: "fake-claude-01",
  driverId: "claude-stream-json",
  state: "trusted",
  executablePath: "/fake/cld",
  fingerprint: "sha256:00",
  components: [{ role: "wrapper", path: "/fake/cld", fingerprint: "sha256:00" }],
  detail: null,
};

const FAKE_COUNTS = {
  activeScopes: 2,
  liveDriverProcesses: 3,
  runningExecutions: 1,
  eventConnections: 4,
} as const;

const FAKE_DRIVERS = [
  { driverId: "claude-stream-json", capability: "ready" },
  { driverId: "codex-app-server", capability: "checking" },
] as const;

let host: TestHost | null = null;

afterEach(async () => {
  await host?.cleanup();
  host = null;
});

async function boot(): Promise<TestHost> {
  host = await createTestHost({
    extraServices: {
      installationRegistry: { list: () => [FAKE_INSTALLATION] },
      scopeManager: { counts: () => ({ ...FAKE_COUNTS }) },
      driverCapabilities: () => FAKE_DRIVERS.map((driver) => ({ ...driver })),
    },
    routesFactory: diagnosticsRoutes,
  });
  return host;
}

interface RawResponse {
  status: number;
  body: { ok: boolean; error?: { code: string }; data?: unknown };
}

/** Raw HTTP client that can send an arbitrary Host header (fetch cannot). */
function rawGet(path: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(
      { hostname: "127.0.0.1", port: CANONICAL_PORT, path, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let body: RawResponse["body"];
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RawResponse["body"];
          } catch {
            body = { ok: false };
          }
          resolvePromise({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", rejectPromise);
    req.end();
  });
}

describe("diagnostics route", () => {
  it("rejects requests without the session capability", async () => {
    host = await boot();
    const res = await fetch(`${host.baseUrl}/api/v1/diagnostics`, {
      headers: { Host: CANONICAL_HOST_HEADER },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a mismatched Host header", async () => {
    host = await boot();
    const res = await rawGet("/api/v1/diagnostics", {
      ...authedHeaders(host),
      Host: "localhost:43127",
    });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("HOST_HEADER_MISMATCH");
  });

  it("returns 200 with the complete diagnostics envelope", async () => {
    host = await boot();
    const res = await fetch(`${host.baseUrl}/api/v1/diagnostics`, {
      headers: authedHeaders(host),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: unknown };
    expect(body.ok).toBe(true);
    const data = body.data as Record<string, unknown>;
    for (const key of ["generatedAt", "health", "config", "installations", "scopes", "logs"]) {
      expect(data, `missing top-level key "${key}"`).toHaveProperty(key);
    }
    expect(diagnosticsResponseSchema.safeParse(body.data).success).toBe(true);

    const dto = body.data as DiagnosticsResponse;
    expect(dto.scopes).toEqual(FAKE_COUNTS);
    expect(dto.installations).toEqual([FAKE_INSTALLATION]);
    expect(dto.health.hostInstanceId).toBe("test-host-instance");
    expect(dto.health.drivers).toEqual(FAKE_DRIVERS);
    expect(dto.config.mode).toBe("production");
    expect(dto.config.port).toBe(CANONICAL_PORT);
    expect(dto.config.node.version).toBe(process.version);
    expect(dto.config.uptimeMs).toBeGreaterThanOrEqual(0);
    // Q10 keeps realpaths ONLY on installations; Host config paths stay out.
    expect(dto.config).not.toHaveProperty("distDir");
    expect(dto.config).not.toHaveProperty("watchdogProgram");
    expect(dto.config).not.toHaveProperty("driverWorkRoot");
  });

  it("includes recent warn/error lines and excludes info", async () => {
    host = await boot();
    host.logger.info("host.started", { mode: "production" });
    host.logger.warn("driver.prewarm_failed", { detail: "spawn failed" });
    host.logger.error("watchdog.exit", { code: 1 });
    const res = await fetch(`${host.baseUrl}/api/v1/diagnostics`, {
      headers: authedHeaders(host),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: DiagnosticsResponse };
    const recent = body.data.logs.recent;
    expect(recent.map((record) => record.event)).toEqual([
      "driver.prewarm_failed",
      "watchdog.exit",
    ]);
    expect(recent[0]?.level).toBe("warn");
    expect(recent[1]?.level).toBe("error");
    // Context arrives as written (already sanitized at write time).
    expect(recent[0]?.context).toEqual({ detail: "spawn failed" });
  });

  it("sensitive-field scan finds no forbidden vocabulary or capability values", async () => {
    host = await boot();
    host.logger.warn("driver.prewarm_failed", { detail: "spawn failed" });
    host.logger.error("watchdog.exit", { code: 1 });
    const res = await fetch(`${host.baseUrl}/api/v1/diagnostics`, {
      headers: authedHeaders(host),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: unknown };

    // Layer 1 + 2: every key and every string value, recursively.
    for (const hit of walk(body.data)) {
      const where = hit.path.join(".");
      if (hit.key !== undefined) {
        for (const pattern of FORBIDDEN) {
          expect(pattern.test(hit.key), `key "${hit.key}" at ${where} matches ${pattern}`).toBe(
            false,
          );
        }
      }
      if (hit.value !== undefined) {
        for (const pattern of FORBIDDEN) {
          expect(
            pattern.test(hit.value),
            `value at ${where} matches ${pattern}: ${hit.value.slice(0, 80)}`,
          ).toBe(false);
        }
      }
    }

    // Layer 3: the serialized body never carries live capability values or
    // the session cookie / CSRF header names.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(host.session.sessionToken);
    expect(serialized).not.toContain(host.session.csrfToken);
    expect(serialized).not.toContain("councilkit_session");
    expect(serialized).not.toContain("x-councilkit-csrf");
  });

  it("redacts secret-shaped values in the problems ring and the route export (F1 poison seed)", async () => {
    host = await boot();
    // Verifier payload: one flat string carrying k=v secrets, plus an object
    // context carrying bearer/api_key shapes. Safe vocabulary must survive.
    host.logger.warn("driver.prewarm_failed", {
      detail: "prompt=private-body token=live-token Cookie=session-value",
    });
    host.logger.error("watchdog.exit", {
      note: "scope.idle_ttl_expired",
      stderr: 'Authorization: Bearer live-bearer-value {"api_key":"live-api-key"}',
    });
    const poison = [
      "private-body",
      "live-token",
      "session-value",
      "live-bearer-value",
      "live-api-key",
    ];

    // Ring output (in-process): values redacted, safe words untouched.
    const recent = host.logger.recentProblems();
    expect(recent.map((record) => record.event)).toEqual([
      "driver.prewarm_failed",
      "watchdog.exit",
    ]);
    expect(recent[0]?.context?.detail).toBe("prompt=[redacted] token=[redacted] Cookie=[redacted]");
    expect(recent[1]?.context?.stderr).toBe(
      'Authorization: [redacted] [redacted] {"api_key":"[redacted]"}',
    );
    expect(recent[1]?.context?.note).toBe("scope.idle_ttl_expired");

    // Route export carries the same redacted records and none of the poison.
    const res = await fetch(`${host.baseUrl}/api/v1/diagnostics`, {
      headers: authedHeaders(host),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: DiagnosticsResponse };
    const exported = JSON.stringify(body.data.logs.recent);
    for (const secret of poison) {
      expect(exported).not.toContain(secret);
    }
    expect(exported).toContain("[redacted]");
    expect(exported).toContain("scope.idle_ttl_expired");
  });
});

describe("logger problems ring", () => {
  it("trims the warn/error ring to its capacity and sanitizes entries", () => {
    const lines: string[] = [];
    const logger = createLogger({ problemRingSize: 3, sink: (line) => lines.push(line) });
    for (let i = 0; i < 5; i += 1) {
      logger.warn(`driver.event_${i}`, { note: `n${i}` });
    }
    expect(logger.recentProblems().map((record) => record.event)).toEqual([
      "driver.event_2",
      "driver.event_3",
      "driver.event_4",
    ]);

    // info never enters the ring.
    logger.info("host.started");
    expect(logger.recentProblems()).toHaveLength(3);

    // diagnostic() dividends land in the ring via its internal warn write.
    logger.diagnostic("driver_incompatible", "missing capability");
    expect(logger.recentProblems().at(-1)?.event).toBe("diagnostic.driver_incompatible");

    // Long context is sanitizeValue-capped before entering the ring; the sink
    // line stream is untouched either way.
    logger.error("watchdog.exit", { blob: "x".repeat(8 * 1024) });
    const last = logger.recentProblems().at(-1);
    expect(JSON.stringify(last?.context)).toContain("truncated");
    expect(JSON.stringify(last?.context).length).toBeLessThan(6 * 1024);
    expect(lines.length).toBe(8);
  });
});
