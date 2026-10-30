import { RuntimeClientError } from "@/runtime/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DoctorHost,
  ghVersionSupported,
  parseGhVersionLine,
  runDoctor,
} from "../src/commands/doctor";
import { CliError } from "../src/errors";
import { type OutputSink, createOutput } from "../src/output";

const UNREACHABLE =
  "Host unreachable at http://127.0.0.1:43127: connect ECONNREFUSED 127.0.0.1:43127\n";
const STARTUP =
  "The Runtime Host is not running. The CLI never spawns it — start it with `pnpm start` (or `pnpm dev`) on http://127.0.0.1:43127, then retry.\n";

describe("doctor output when the Host is down", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function captureStreams(): { stderr: () => string; stdout: () => string } {
    const stderr: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    return {
      stderr: () => stderr.join(""),
      stdout: () => stdout.join(""),
    };
  }

  function hostDown(): void {
    vi.stubGlobal("fetch", () =>
      Promise.reject(new TypeError("connect ECONNREFUSED 127.0.0.1:43127")),
    );
  }

  it("prints only the diagnostic on stderr for a json sink", async () => {
    hostDown();
    const streams = captureStreams();

    const error = await runDoctor([], createOutput(true)).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(3);
    expect(streams.stderr()).toBe(UNREACHABLE);
    expect(streams.stdout()).toBe("");
  });

  it("prints the startup paragraph on stdout in human mode", async () => {
    hostDown();
    const streams = captureStreams();

    const error = await runDoctor([], createOutput(false)).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(3);
    expect(streams.stdout()).toBe(STARTUP);
    expect(streams.stderr()).toBe(UNREACHABLE);
  });
});

describe("CK-4 doctor login overlay", () => {
  it("CK-4 doctor flags a not-logged-in driver", async () => {
    const sink: OutputSink & { finished: unknown } = {
      json: true,
      finished: undefined,
      progress() {},
      diag() {},
      finish(data) {
        this.finished = data;
        return Promise.resolve();
      },
    };
    await runDoctor([], sink, {
      host: {
        async health() {
          return {
            apiVersion: "v1",
            hostInstanceId: "h-1",
            node: { version: "v22.14.0", major: 22 },
            drivers: [{ driverId: "kimi-stream-json", capability: "ready" }],
          };
        },
        async listInstallations() {
          return {
            installations: [
              {
                installationId: "inst-kimi-1",
                driverId: "kimi-stream-json",
                state: "trusted",
                executablePath: null,
                fingerprint: null,
                components: [],
                detail: null,
              },
            ],
          };
        },
        async modelCatalog() {
          return { catalog: ["kimi-code/k3"], cachedAt: "2026-01-01T00:00:00.000Z" };
        },
        async profileReadiness() {
          throw new RuntimeClientError(
            403,
            "AUTH_REQUIRED",
            "kimi provider probe failed: provider list exited with code 1",
          );
        },
      },
    });
    const result = sink.finished as {
      drivers: Array<{ driverId: string; catalogProbe: { ok: boolean; error?: string } }>;
    };
    expect(result.drivers).toHaveLength(1);
    expect(result.drivers[0]?.catalogProbe.ok).toBe(false);
    expect(result.drivers[0]?.catalogProbe.error).toContain("先运行 `kimi login`");
  });
});

describe("doctor gh version line (#302)", () => {
  function humanSink(): OutputSink & { finished: unknown } {
    return {
      json: false,
      finished: undefined,
      progress() {},
      diag() {},
      finish(data, humanRender) {
        this.finished = humanRender ? humanRender(data) : data;
        return Promise.resolve();
      },
    };
  }

  function fakeHost(): DoctorHost {
    return {
      async health() {
        return {
          apiVersion: "v1",
          hostInstanceId: "h-1",
          node: { version: "v22.14.0", major: 22 },
          drivers: [{ driverId: "kimi-stream-json", capability: "ready" }],
        };
      },
      async listInstallations() {
        return {
          installations: [
            {
              installationId: "inst-kimi-1",
              driverId: "kimi-stream-json",
              state: "trusted",
              executablePath: null,
              fingerprint: null,
              components: [],
              detail: null,
            },
          ],
        };
      },
      async modelCatalog() {
        return { catalog: ["kimi-code/k3"], cachedAt: "2026-01-01T00:00:00.000Z" };
      },
      async profileReadiness() {
        return {
          readiness: { state: "ready", detail: null },
          binding: null,
          cachedAt: "2026-01-01T00:00:00.000Z",
        };
      },
    };
  }

  function jsonSink(): OutputSink & { finished: unknown } {
    return {
      json: true,
      finished: undefined,
      progress() {},
      diag() {},
      finish(data) {
        this.finished = data;
        return Promise.resolve();
      },
    };
  }

  it("reports a supported gh version in JSON and human output", async () => {
    const sink = jsonSink();
    await runDoctor([], sink, {
      host: fakeHost(),
      ghVersion: async () => ({ found: true, version: "2.46.0", supported: true, detail: null }),
    });
    const result = sink.finished as { gh: { version: string; supported: boolean } };
    expect(result.gh.version).toBe("2.46.0");
    expect(result.gh.supported).toBe(true);

    const human = humanSink();
    await runDoctor([], human, {
      host: fakeHost(),
      ghVersion: async () => ({ found: true, version: "2.46.0", supported: true, detail: null }),
    });
    expect(String(human.finished)).toContain("gh: 2.46.0 (ok, >= 2.46)");
  });

  it("flags an unsupported gh version with an upgrade hint", async () => {
    const human = humanSink();
    await runDoctor([], human, {
      host: fakeHost(),
      ghVersion: async () => ({ found: true, version: "2.45.0", supported: false, detail: null }),
    });
    expect(String(human.finished)).toContain("gh: 2.45.0 (below minimum 2.46 — upgrade gh)");
  });

  it("degrades gracefully when gh is missing", async () => {
    const human = humanSink();
    await expect(
      runDoctor([], human, {
        host: fakeHost(),
        ghVersion: async () => ({
          found: false,
          version: null,
          supported: null,
          detail: "not found on PATH",
        }),
      }),
    ).resolves.toBeUndefined();
    expect(String(human.finished)).toContain("gh: not found");
  });

  it("degrades gracefully when the probe fails", async () => {
    const human = humanSink();
    await expect(
      runDoctor([], human, {
        host: fakeHost(),
        ghVersion: async () => ({
          found: true,
          version: null,
          supported: null,
          detail: "`gh --version` failed",
        }),
      }),
    ).resolves.toBeUndefined();
    expect(String(human.finished)).toContain(
      "gh: installed, version unknown (`gh --version` failed)",
    );
  });

  it("compares gh versions numerically, not as strings", () => {
    expect(parseGhVersionLine("gh version 2.46.0 (2024-01-01)")).toEqual({
      major: 2,
      minor: 46,
      patch: 0,
    });
    expect(parseGhVersionLine("not a version")).toBeNull();
    expect(ghVersionSupported({ major: 2, minor: 46 })).toBe(true);
    expect(ghVersionSupported({ major: 2, minor: 100 })).toBe(true);
    expect(ghVersionSupported({ major: 2, minor: 45 })).toBe(false);
    expect(ghVersionSupported({ major: 3, minor: 0 })).toBe(true);
  });
});
