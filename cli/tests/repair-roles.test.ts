import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRepair } from "../src/commands/repair";
import { runRepairRoles } from "../src/commands/repair-roles";
import type { OutputSink } from "../src/output";

const homes: string[] = [];
const previousHome = process.env.COUNCILKIT_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.COUNCILKIT_HOME;
  else process.env.COUNCILKIT_HOME = previousHome;
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.length = 0;
});

function homeDir(): string {
  const home = mkdtempSync(join(tmpdir(), "ck-roles-"));
  homes.push(home);
  mkdirSync(home, { recursive: true });
  process.env.COUNCILKIT_HOME = home;
  return home;
}

function sink(): OutputSink & { last: () => unknown } {
  let last: unknown;
  return {
    json: true,
    progress() {},
    diag() {},
    async finish(data: unknown) {
      last = data;
    },
    last: () => last,
  };
}

describe("repair roles", () => {
  it("persists independent Grok seats without changing Builder bindings or frozen task contracts", async () => {
    const home = homeDir();
    const configPath = join(home, "squad-bridge.json");
    const builder = { runtime: "grokb", model: "grok-4.6" };
    const original = {
      executable: "/tmp/squadctl",
      orchestratorRuntime: "grokb",
      roles: { orchestrator: builder, planner_a: builder, coder: builder },
    };
    writeFileSync(configPath, `${JSON.stringify(original)}\n`);
    const frozenPath = join(home, "squad-tasks", "existing", "runtime-contract.json");
    mkdirSync(join(home, "squad-tasks", "existing"), { recursive: true });
    const frozen = '{"roles":{"reviewer":{"runtime":"cursor","model":"composer-2.5"}}}\n';
    writeFileSync(frozenPath, frozen);
    const out = sink();
    await runRepair(
      [
        "roles",
        "set",
        "--planner-b",
        "grokb:grok-4.6",
        "--reviewer",
        "grokb:grok-4.6",
        "--verifier",
        "grokb:grok-4.6",
      ],
      out,
    );
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written).toEqual({
      ...original,
      roles: { ...original.roles, planner_b: builder, reviewer: builder, verifier: builder },
    });
    await runRepair(["roles", "show"], out);
    expect(out.last()).toMatchObject({
      roles: {
        planner_b: { ...builder, sandbox: "read-only" },
        reviewer: { ...builder, sandbox: "read-only" },
        verifier: { ...builder, sandbox: "workspace-write" },
      },
    });
    const beforeReject = readFileSync(configPath, "utf8");
    await expect(runRepair(["roles", "set", "--reviewer", "grok:grok-4.6"], out)).rejects.toThrow(
      /grokb/,
    );
    expect(readFileSync(configPath, "utf8")).toBe(beforeReject);
    expect(readFileSync(frozenPath, "utf8")).toBe(frozen);
  });

  it("sets one seat, leaves the chain budget file alone, and reset clears only roles", async () => {
    const home = homeDir();
    const budget = join(home, "repair-budget.json");
    writeFileSync(budget, '{"used":3}\n');
    const out = sink();
    await runRepair(["roles", "set", "--reviewer", "codex:gpt-5.6-sol"], out);
    expect(readFileSync(budget, "utf8")).toBe('{"used":3}\n');
    const written = JSON.parse(readFileSync(join(home, "squad-bridge.json"), "utf8")) as {
      roles: { reviewer: { runtime: string; model: string }; coder?: { model: string } };
    };
    expect(written.roles.reviewer).toEqual({ runtime: "codex", model: "gpt-5.6-sol" });
    expect(written.roles.coder).toBeUndefined();
    await runRepair(
      [
        "roles",
        "set",
        "--orchestrator",
        "cursor:composer-2.5",
        "--verifier",
        "cursor:grok-4.7-xhigh",
      ],
      out,
    );
    const next = JSON.parse(readFileSync(join(home, "squad-bridge.json"), "utf8")) as {
      roles: Record<string, { runtime: string; model: string }>;
    };
    expect(next.roles.orchestrator.model).toBe("composer-2.5");
    expect(next.roles.planner_a.model).toBe("composer-2.5");
    expect(next.roles.coder.model).toBe("composer-2.5");
    expect(next.roles.reviewer.model).toBe("gpt-5.6-sol");
    expect(next.roles.verifier.model).toBe("grok-4.7-xhigh");
    await expect(runRepair(["roles", "set", "--reviewer", "cursor:auto"], out)).rejects.toThrow(
      /auto|拒绝/,
    );
    expect(readFileSync(budget, "utf8")).toBe('{"used":3}\n');
    await runRepair(["roles", "reset"], out);
    const cleared = JSON.parse(readFileSync(join(home, "squad-bridge.json"), "utf8")) as {
      roles?: unknown;
    };
    expect(cleared.roles).toBeUndefined();
    expect(readFileSync(budget, "utf8")).toBe('{"used":3}\n');
  });

  it("show and set refuse damaged config and leave the file unchanged", async () => {
    const home = homeDir();
    const configPath = join(home, "squad-bridge.json");
    writeFileSync(configPath, "{not json\n");
    const out = sink();
    await expect(runRepair(["roles", "show"], out)).rejects.toThrow(/JSON/);
    await expect(
      runRepair(["roles", "set", "--reviewer", "codex:gpt-5.6-sol"], out),
    ).rejects.toThrow(/JSON/);
    expect(readFileSync(configPath, "utf8")).toBe("{not json\n");
    writeFileSync(
      configPath,
      `${JSON.stringify({ roles: { reviewer: { runtime: "cursor", model: "composer-2.5" } } })}\n`,
    );
    await runRepair(["roles", "show"], out);
    const shown = out.last() as { roles: { reviewer: { model: string } } };
    expect(shown.roles.reviewer.model).toBe("composer-2.5");
  });

  it("keeps the saved cursor model when COUNCILKIT_CURSOR_MODEL is blank", async () => {
    const home = homeDir();
    writeFileSync(
      join(home, "squad-bridge.json"),
      `${JSON.stringify({ model: "composer-2.5", orchestratorRuntime: "cursor" })}\n`,
    );
    const previous = process.env.COUNCILKIT_CURSOR_MODEL;
    process.env.COUNCILKIT_CURSOR_MODEL = "  ";
    try {
      const out = sink();
      await runRepairRoles(["show"], out);
      expect(out.last()).toMatchObject({
        orchestratorModel: "composer-2.5",
        roles: {
          orchestrator: { model: "composer-2.5" },
          reviewer: { model: "composer-2.5" },
        },
      });
    } finally {
      if (previous === undefined) {
        delete process.env.COUNCILKIT_CURSOR_MODEL;
      } else process.env.COUNCILKIT_CURSOR_MODEL = previous;
    }
  });
});
