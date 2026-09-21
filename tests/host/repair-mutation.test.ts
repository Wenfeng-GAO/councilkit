import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRunLaunchRequest } from "@host/cli-launcher";
import { cliRunsRoutes } from "@host/routes/cli-runs";
import type { HostServices, HttpError, RouteContext } from "@host/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRepairGrant,
  loadRepairProfile,
  revokeRepairProfile,
  saveRepairProfile,
} from "../../cli/src/auto/repair-profile";

const RUN_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const GH_PR = "https://github.com/acme/repo/pull/1";

let home: string;
let oldHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-repair-mutation-"));
  oldHome = process.env.COUNCILKIT_HOME;
  process.env.COUNCILKIT_HOME = home;
  mkdirSync(join(home, "runs", RUN_ID), { recursive: true });
  writeFileSync(join(home, "runs", RUN_ID, "report.md"), "# source\n");
});

afterEach(() => {
  if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
  else process.env.COUNCILKIT_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

function seedProfile() {
  return saveRepairProfile({
    name: "default",
    prUrl: GH_PR,
    repo: "github.com/acme/repo",
    sourceBranch: "feat-x",
    base: "main",
    capabilities: ["push-source-branch"],
  });
}

function routesWithLauncher(
  start?: (input: CliRunLaunchRequest) => { pid: number },
  bridgeAvailable = true,
) {
  const launches: CliRunLaunchRequest[] = [];
  const routes = cliRunsRoutes({
    cliRunLauncher: {
      start: (input: CliRunLaunchRequest) => {
        launches.push(input);
        return start ? start(input) : { pid: process.pid };
      },
    },
    squadBridgeProbe: () => ({
      available: bridgeAvailable,
      version: bridgeAvailable ? "squad-bridge.v1" : null,
      reason: bridgeAvailable ? null : "squadctl not on PATH",
    }),
  } as unknown as HostServices);
  return { routes, launches };
}

function ctx(body: unknown, params: Record<string, string> = {}): RouteContext {
  return {
    body,
    params,
    query: new URLSearchParams(),
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    services: {} as HostServices,
  };
}

describe("repair mutation handlers", () => {
  it("mints a parent run without writing pipeline.pid on the source review", async () => {
    seedProfile();
    const { routes, launches } = routesWithLauncher();
    const start = routes.find((route) => route.pattern === "/api/v1/cli-runs/repair");
    if (start === undefined) throw new Error("missing repair route");
    const result = (await start.handler(ctx({ from: RUN_ID, profile: "default" }))) as {
      runId: string;
      started: true;
    };
    expect(result.started).toBe(true);
    expect(result.runId).toMatch(/^ck-repair-/);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.action).toBe("repair");
    expect(launches[0]?.from).toBe(RUN_ID);
    expect(existsSync(join(home, "runs", RUN_ID, "pipeline.pid"))).toBe(false);
  });

  it("reuses the active parent id and does not spawn twice", async () => {
    seedProfile();
    const { routes, launches } = routesWithLauncher();
    const start = routes.find((route) => route.pattern === "/api/v1/cli-runs/repair");
    if (start === undefined) throw new Error("missing repair route");
    const first = (await start.handler(ctx({ from: RUN_ID, profile: "default" }))) as {
      runId: string;
    };
    const second = (await start.handler(ctx({ from: RUN_ID, profile: "default" }))) as {
      runId: string;
    };
    expect(second.runId).toBe(first.runId);
    expect(launches).toHaveLength(1);
  });

  it("serializes overlapping starts onto one parent id", async () => {
    seedProfile();
    const { routes, launches } = routesWithLauncher();
    const start = routes.find((route) => route.pattern === "/api/v1/cli-runs/repair");
    if (start === undefined) throw new Error("missing repair route");
    const [a, b] = await Promise.all([
      start.handler(ctx({ from: RUN_ID, profile: "default" })),
      start.handler(ctx({ from: RUN_ID, profile: "default" })),
    ]);
    expect((a as { runId: string }).runId).toBe((b as { runId: string }).runId);
    expect(launches).toHaveLength(1);
  });

  it("recovers the minted id when handshake times out after the CLI created the directory", async () => {
    seedProfile();
    const { routes, launches } = routesWithLauncher((input) => {
      const dir = join(home, "runs", input.runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "repair.json"),
        `${JSON.stringify({
          version: 1,
          casVersion: 0,
          sourceRunId: RUN_ID,
          profileName: "default",
          outerUsed: 0,
          outerMax: 10,
          timeoutMs: null,
          businessResult: null,
          reasonCode: null,
        })}\n`,
      );
      writeFileSync(join(dir, "pipeline.pid"), `${String(process.pid)}\n`);
      writeFileSync(
        join(dir, "status.json"),
        `${JSON.stringify({
          version: 1,
          status: "running",
          progress: {
            phase: "repair-preparing",
            attempts: [],
            updatedAt: new Date().toISOString(),
          },
          pipeline: null,
        })}\n`,
      );
      throw Object.assign(new Error("repair handshake timed out waiting for the run directory"), {
        code: "HANDSHAKE_TIMEOUT",
      });
    });
    const start = routes.find((route) => route.pattern === "/api/v1/cli-runs/repair");
    if (start === undefined) throw new Error("missing repair route");
    const result = (await start.handler(ctx({ from: RUN_ID, profile: "default" }))) as {
      runId: string;
    };
    expect(launches).toHaveLength(1);
    expect(result.runId).toBe(launches[0]?.runId);
    expect(existsSync(join(home, "runs", RUN_ID, "pipeline.pid"))).toBe(false);
  });

  it("refuses resume after the profile is revoked", async () => {
    const profile = seedProfile();
    const grant = createRepairGrant(profile);
    const repairId = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";
    mkdirSync(join(home, "runs", repairId), { recursive: true });
    writeFileSync(
      join(home, "runs", repairId, "repair-grant.json"),
      `${JSON.stringify(grant, null, 2)}\n`,
    );
    writeFileSync(
      join(home, "runs", repairId, "repair.json"),
      `${JSON.stringify({
        version: 1,
        casVersion: 0,
        sourceRunId: RUN_ID,
        profileName: "default",
        outerUsed: 0,
        outerMax: 10,
        timeoutMs: null,
        businessResult: null,
        reasonCode: null,
      })}\n`,
    );
    revokeRepairProfile("default");
    const { routes, launches } = routesWithLauncher();
    const resume = routes.find(
      (route) => route.pattern === "/api/v1/cli-runs/:runId/repair/resume",
    );
    if (resume === undefined) throw new Error("missing resume route");
    await expect(resume.handler(ctx({}, { runId: repairId }))).rejects.toMatchObject({
      status: 400,
    } satisfies Partial<HttpError>);
    expect(launches).toEqual([]);
  });

  it("stops through repair stop and leaves the source review untouched", async () => {
    seedProfile();
    const { routes, launches } = routesWithLauncher();
    const start = routes.find((route) => route.pattern === "/api/v1/cli-runs/repair");
    const stop = routes.find((route) => route.pattern === "/api/v1/cli-runs/:runId/repair/stop");
    if (start === undefined || stop === undefined) throw new Error("missing routes");
    const created = (await start.handler(ctx({ from: RUN_ID, profile: "default" }))) as {
      runId: string;
    };
    const stopped = (await stop.handler(ctx({}, { runId: created.runId }))) as {
      runId: string;
      stopped: true;
    };
    expect(stopped.stopped).toBe(true);
    expect(launches.at(-1)?.action).toBe("repair-stop");
    expect(existsSync(join(home, "runs", RUN_ID, "pipeline.pid"))).toBe(false);
  });

  it("rejects argv on the start body schema", () => {
    const { routes } = routesWithLauncher();
    const start = routes.find((route) => route.pattern === "/api/v1/cli-runs/repair");
    expect(
      start?.bodySchema?.safeParse({ from: RUN_ID, profile: "default", argv: ["-c"] }).success,
    ).toBe(false);
    expect(
      start?.bodySchema?.safeParse({ from: RUN_ID, profile: "default", authorized: true }).success,
    ).toBe(false);
    expect(start?.bodySchema?.safeParse({ from: RUN_ID, profile: "default" }).success).toBe(true);
  });

  it("saves a repair profile the CLI can load and lists it for the source review", async () => {
    writeFileSync(
      join(home, "runs", RUN_ID, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "review.started",
        runId: RUN_ID,
        startedAt: "2026-09-20",
        task: { pr: GH_PR },
      })}\n`,
    );
    writeFileSync(
      join(home, "runs", RUN_ID, "review-context.md"),
      "# Frozen review context\n\n- source: `feat-x`\n- target: `main`\n",
    );
    const { routes } = routesWithLauncher();
    const post = routes.find(
      (route) => route.method === "POST" && route.pattern === "/api/v1/cli-runs/repair/profiles",
    );
    const get = routes.find(
      (route) => route.method === "GET" && route.pattern === "/api/v1/cli-runs/repair/profiles",
    );
    if (post === undefined || get === undefined) throw new Error("missing profile routes");
    const saved = (await post.handler(
      ctx({
        name: "default",
        prUrl: GH_PR,
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        base: "main",
        capabilities: ["push-source-branch"],
      }),
    )) as { name: string; sourceBranch: string };
    expect(saved.name).toBe("default");
    expect(loadRepairProfile("default").sourceBranch).toBe("feat-x");
    const listed = (await get.handler({
      ...ctx({}),
      query: new URLSearchParams({ from: RUN_ID }),
    })) as {
      profiles: Array<{ name: string }>;
      sourceBranchHint: string | null;
      baseHint: string | null;
      hintSource: "pr" | "review" | "worktree" | null;
    };
    expect(listed.profiles.map((row) => row.name)).toEqual(["default"]);
    expect(listed.sourceBranchHint).toBe("feat-x");
    expect(listed.baseHint).toBe("main");
    expect(listed.hintSource).toBe("review");
  });

  it("inspects the live PR when frozen review context is missing", async () => {
    writeFileSync(
      join(home, "runs", RUN_ID, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "review.started",
        runId: RUN_ID,
        startedAt: "2026-09-20",
        task: { pr: GH_PR },
      })}\n`,
    );
    const bin = mkdtempSync(join(tmpdir(), "ck-gh-"));
    writeFileSync(
      join(bin, "gh"),
      '#!/bin/sh\nprintf \'%s\\n\' \'{"headRefName":"feat-x","baseRefName":"main"}\'\n',
    );
    chmodSync(join(bin, "gh"), 0o755);
    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    process.env.PATH = bin;
    process.env.HOME = bin;
    try {
      const { routes } = routesWithLauncher();
      const get = routes.find(
        (route) => route.method === "GET" && route.pattern === "/api/v1/cli-runs/repair/profiles",
      );
      if (get === undefined) throw new Error("missing list route");
      const listed = (await get.handler({
        ...ctx({}),
        query: new URLSearchParams({ from: RUN_ID }),
      })) as {
        sourceBranchHint: string | null;
        baseHint: string | null;
        hintSource: string | null;
      };
      expect(listed.sourceBranchHint).toBe("feat-x");
      expect(listed.baseHint).toBe("main");
      expect(listed.hintSource).toBe("pr");
    } finally {
      process.env.PATH = prevPath;
      process.env.HOME = prevHome;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("refuses to save a profile whose repo does not match the PR", async () => {
    const { routes } = routesWithLauncher();
    const post = routes.find(
      (route) => route.method === "POST" && route.pattern === "/api/v1/cli-runs/repair/profiles",
    );
    if (post === undefined) throw new Error("missing save route");
    await expect(
      (async () =>
        post.handler(
          ctx({
            name: "default",
            prUrl: GH_PR,
            repo: "github.com/other/repo",
            sourceBranch: "feat-x",
            base: "main",
            capabilities: ["push-source-branch"],
          }),
        ))(),
    ).rejects.toMatchObject({ status: 400 } satisfies Partial<HttpError>);
  });

  it("refuses to start repair when the squad bridge is unavailable", async () => {
    seedProfile();
    const { routes, launches } = routesWithLauncher(undefined, false);
    const start = routes.find((route) => route.pattern === "/api/v1/cli-runs/repair");
    if (start === undefined) throw new Error("missing repair route");
    await expect(start.handler(ctx({ from: RUN_ID, profile: "default" }))).rejects.toMatchObject({
      status: 400,
    } satisfies Partial<HttpError>);
    expect(launches).toHaveLength(0);
  });

  it("lists bridgeAvailable on the profile endpoint", async () => {
    const { routes } = routesWithLauncher(undefined, false);
    const get = routes.find(
      (route) => route.method === "GET" && route.pattern === "/api/v1/cli-runs/repair/profiles",
    );
    if (get === undefined) throw new Error("missing list route");
    const listed = (await get.handler(ctx({}))) as {
      bridgeAvailable?: boolean;
      bridgeReason?: string | null;
    };
    expect(listed.bridgeAvailable).toBe(false);
    expect(listed.bridgeReason).toMatch(/squadctl/i);
  });

  it("resumes a preflight-failed parent without a grant when outerUsed is 0", async () => {
    seedProfile();
    const { routes, launches } = routesWithLauncher();
    const start = routes.find((route) => route.pattern === "/api/v1/cli-runs/repair");
    const resume = routes.find(
      (route) => route.pattern === "/api/v1/cli-runs/:runId/repair/resume",
    );
    if (start === undefined || resume === undefined) throw new Error("missing routes");
    const created = (await start.handler(ctx({ from: RUN_ID, profile: "default" }))) as {
      runId: string;
    };
    writeFileSync(
      join(home, "runs", created.runId, "repair.json"),
      `${JSON.stringify({
        version: 1,
        casVersion: 0,
        sourceRunId: RUN_ID,
        profileName: "default",
        outerUsed: 0,
        outerMax: 10,
        timeoutMs: null,
        businessResult: "needs_attention",
        reasonCode: "identity_mismatch",
        lastError: "AntCode PR did not include headSha; repair cannot freeze identity",
      })}\n`,
    );
    const result = (await resume.handler(ctx({}, { runId: created.runId }))) as {
      started: boolean;
    };
    expect(result.started).toBe(true);
    expect(launches.at(-1)?.action).toBe("repair-resume");
  });

  it("rejects an empty source branch on the save body schema", () => {
    const { routes } = routesWithLauncher();
    const post = routes.find(
      (route) => route.method === "POST" && route.pattern === "/api/v1/cli-runs/repair/profiles",
    );
    expect(
      post?.bodySchema?.safeParse({
        name: "default",
        prUrl: GH_PR,
        repo: "github.com/acme/repo",
        sourceBranch: "",
        base: "main",
        capabilities: ["push-source-branch"],
      }).success,
    ).toBe(false);
  });
});
