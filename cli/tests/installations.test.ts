/**
 * Installation resolution unit tests (plan-a §10 AC1, installation bucket).
 * zero/one/many trusted, driverId filtering, Host-order first-pick with recorded
 * candidate count, and a server-backed listInstallations round-trip.
 */
import { type Server, createServer } from "node:http";
import type { InstallationDto, InstallationsResponse } from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError, EXIT } from "../src/errors";
import { HostClient } from "../src/host/client";
import { listTrusted, resolveInstallations } from "../src/host/installations";

function inst(
  installationId: string,
  driverId: InstallationDto["driverId"],
  state: InstallationDto["state"],
): InstallationDto {
  return {
    installationId,
    driverId,
    state,
    executablePath: null,
    fingerprint: null,
    components: [],
    detail: null,
  };
}

function captureError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected an error to be thrown");
}

describe("cli installation resolution (pure)", () => {
  it("throws a structured NO_TRUSTED_INSTALLATION when zero trusted match", () => {
    const response: InstallationsResponse = {
      installations: [
        inst("a", "kimi-stream-json", "discovering"),
        inst("b", "claude-stream-json", "trusted"),
      ],
    };
    const err = captureError(() => resolveInstallations(response, "kimi-stream-json"));
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(EXIT.hostUnavailable);
    expect(err.detail?.code).toBe("NO_TRUSTED_INSTALLATION");
  });

  it("uses the single trusted match", () => {
    const response: InstallationsResponse = {
      installations: [inst("only", "kimi-stream-json", "trusted")],
    };
    const r = resolveInstallations(response, "kimi-stream-json");
    expect(r.installationId).toBe("only");
    expect(r.trustedCandidateCount).toBe(1);
  });

  it("picks the FIRST trusted candidate in Host order and records the count", () => {
    const response: InstallationsResponse = {
      installations: [
        inst("untrusted", "kimi-stream-json", "changed"),
        inst("first", "kimi-stream-json", "trusted"),
        inst("second", "kimi-stream-json", "trusted"),
      ],
    };
    const r = resolveInstallations(response, "kimi-stream-json");
    expect(r.installationId).toBe("first");
    expect(r.trustedCandidateCount).toBe(2);
  });

  it("filters by driverId (other drivers ignored)", () => {
    const response: InstallationsResponse = {
      installations: [
        inst("x", "claude-stream-json", "trusted"),
        inst("y", "kimi-stream-json", "trusted"),
      ],
    };
    expect(listTrusted(response, "claude-stream-json").map((i) => i.installationId)).toEqual(["x"]);
    expect(resolveInstallations(response, "claude-stream-json").installationId).toBe("x");
    expect(resolveInstallations(response, "kimi-stream-json").installationId).toBe("y");
  });
});

describe("cli installation listInstallations round-trip", () => {
  let server: Server;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const started = await new Promise<{
      server: Server;
      baseUrl: string;
      close: () => Promise<void>;
    }>((resolve) => {
      const srv = createServer((req, res) => {
        if (req.url === "/") {
          (res as unknown as { setHeader: (n: string, v: string) => void }).setHeader(
            "set-cookie",
            "councilkit_session=zzz",
          );
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<meta name="councilkit-csrf" content="c">`);
          return;
        }
        if (req.url === "/api/v1/installations") {
          const body: InstallationsResponse = {
            installations: [
              inst("kimi-1", "kimi-stream-json", "trusted"),
              inst("kimi-2", "kimi-stream-json", "trusted"),
            ],
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, data: body }));
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: "NOT_FOUND", message: "x", retryable: false, phase: "bootstrap" },
          }),
        );
      });
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({
          server: srv,
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((r) => srv.close(() => r())),
        });
      });
    });
    server = started.server;
    close = started.close;
  });

  afterEach(async () => {
    await close();
  });

  it("fetches installations through HostClient and resolves deterministically", async () => {
    const host = new HostClient({
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    const list = await host.listInstallations();
    const r = resolveInstallations(list, "kimi-stream-json");
    expect(r.installationId).toBe("kimi-1");
    expect(r.trustedCandidateCount).toBe(2);
  });
});
