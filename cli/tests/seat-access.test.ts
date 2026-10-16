/**
 * #273 SAFE-01..04: review seats are read-only by default.
 *
 * Every argv that review / correction / aggregator / probe spawns must carry
 * no permission-skip flag unless the user explicitly opted into write access
 * (`apply`, or `review --allow-write`). Each CLI must also be put in its own
 * read-only mode (plan / ask / read-only sandbox), not just "not escalated".
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PERMISSION_SKIP_FLAGS,
  type SeatAccess,
  buildProbeSpec,
  buildSpawnSpec,
} from "../src/auto/driver-commands";
import {
  buildInvocationManifest,
  invocationManifestSchema,
  resumeArgvFromManifest,
} from "../src/auto/invocation-manifest";
import type { AgentRecord } from "../src/store/schemas";

type Selection = AgentRecord["driverSelection"];

const DRIVERS: Record<string, { sel: Selection; model: string; readOnly: string[] }> = {
  claude: {
    sel: { driverId: "claude-stream-json", options: { route: "cfuse" } },
    model: "default",
    readOnly: ["--permission-mode", "plan", "--disallowedTools", "Bash", "Edit", "Write"],
  },
  grok: {
    sel: { driverId: "grok-stream-json", options: {} },
    model: "grok-4.6",
    readOnly: ["--permission-mode", "plan", "--deny", "Bash", "--deny", "Edit", "--deny", "Write"],
  },
  cursor: {
    sel: { driverId: "cursor-stream-json", options: {} },
    model: "auto",
    readOnly: ["--mode", "ask"],
  },
  codex: {
    sel: { driverId: "codex-app-server", options: {} },
    model: "gpt-5",
    readOnly: ["-s", "read-only"],
  },
};

function agent(sel: Selection, modelId: string): AgentRecord {
  return {
    id: "a-1",
    name: "A",
    personaPrompt: "persona",
    modelId,
    color: "#aabbcc",
    enabled: true,
    driverSelection: sel,
  };
}

function containsRun(argv: readonly string[], run: readonly string[]): boolean {
  for (let i = 0; i + run.length <= argv.length; i++) {
    if (run.every((v, j) => argv[i + j] === v)) return true;
  }
  return false;
}

function skipFlags(argv: readonly string[]): string[] {
  return argv.filter((a) => (PERMISSION_SKIP_FLAGS as readonly string[]).includes(a));
}

describe("#273 seat access", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ck-seat-access-"));
    for (const name of ["cld", "kimi", "codex", "grok", "cursor-agent"]) {
      writeFileSync(join(tmp, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(tmp, name), 0o755);
    }
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: tmp });

  const spawn = (name: string, access?: SeatAccess) => {
    const d = DRIVERS[name];
    if (!d) throw new Error(`unknown driver ${name}`);
    return buildSpawnSpec(agent(d.sel, d.model), {
      attemptId: "attempt-0",
      workspace: "/ws",
      prompt: "review",
      env: env(),
      ...(access ? { access } : {}),
    });
  };

  for (const name of Object.keys(DRIVERS)) {
    it(`SAFE-01 ${name}: default review argv has no permission-skip flag and is in read-only mode`, () => {
      const d = DRIVERS[name];
      const argv = spawn(name).argv;
      expect(skipFlags(argv)).toEqual([]);
      expect(d && containsRun(argv, d.readOnly)).toBe(true);
    });

    it(`SAFE-01 ${name}: explicit "read-only" equals the default`, () => {
      expect(spawn(name, "read-only").argv).toEqual(spawn(name).argv);
    });

    it(`SAFE-04 ${name}: write access is opt-in and leaves read-only mode`, () => {
      const d = DRIVERS[name];
      const argv = spawn(name, "write").argv;
      expect(skipFlags(argv).length).toBeGreaterThan(0);
      expect(d && containsRun(argv, d.readOnly)).toBe(false);
    });

    it(`SAFE-01 ${name}: health probe never skips permissions`, () => {
      const d = DRIVERS[name];
      if (!d) throw new Error("unreachable");
      const spec = buildProbeSpec(agent(d.sel, d.model), {
        probeId: "probe",
        cwd: "/probe-cwd",
        prompt: "ping",
        env: env(),
      });
      expect(skipFlags(spec.argv)).toEqual([]);
    });
  }

  it("kimi has no permission-skip flag in its argv (autonomy comes from the user's own kimi config; not marked locked)", () => {
    const argv = buildSpawnSpec(agent({ driverId: "kimi-stream-json", options: {} }, "k3"), {
      attemptId: "attempt-0",
      workspace: "/ws",
      prompt: "review",
      env: env(),
    }).argv;
    expect(skipFlags(argv)).toEqual([]);
    expect(argv.some((a) => a === "--auto" || a === "-y" || a === "--yolo")).toBe(false);
  });
});

describe("#273 seat access survives resume", () => {
  const base = {
    runId: "r-1",
    task: { task: "review the repo" },
    repoRealpath: null,
    reviewedSha: null,
    timeoutMs: 1,
    concurrency: null,
    agents: [],
    aggregator: agent({ driverId: "grok-stream-json", options: {} }, "grok-4.6"),
    tools: [],
  } as unknown as Parameters<typeof buildInvocationManifest>[0];

  it("a new manifest records read-only by default and resume adds no --allow-write", () => {
    const m = buildInvocationManifest(base);
    expect(m.seatAccess).toBe("read-only");
    expect(resumeArgvFromManifest(m)).not.toContain("--allow-write");
  });

  it("a write run resumes as a write run", () => {
    const m = buildInvocationManifest({ ...base, seatAccess: "write" });
    expect(resumeArgvFromManifest(m)).toContain("--allow-write");
  });

  it("a pre-#273 manifest without seatAccess still parses and resumes read-only", () => {
    const { seatAccess: _omit, ...legacy } = buildInvocationManifest(base);
    const parsed = invocationManifestSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(resumeArgvFromManifest(legacy as never)).not.toContain("--allow-write");
  });
});
