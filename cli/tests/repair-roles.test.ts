import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRepair } from "../src/commands/repair";
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
  it("sets one seat, leaves the chain budget file alone, and reset clears only roles", async () => {
    const home = homeDir();
    const budget = join(home, "repair-budget.json");
    writeFileSync(budget, "{\"used\":3}\n");
    const out = sink();
    await runRepair(["roles", "set", "--reviewer", "codex:gpt-5.6-sol"], out);
    expect(readFileSync(budget, "utf8")).toBe("{\"used\":3}\n");
    const written = JSON.parse(readFileSync(join(home, "squad-bridge.json"), "utf8")) as {
      roles: { reviewer: { runtime: string; model: string }; coder?: { model: string } };
    };
    expect(written.roles.reviewer).toEqual({ runtime: "codex", model: "gpt-5.6-sol" });
    expect(written.roles.coder).toBeUndefined();
    await runRepair(
      ["roles", "set", "--orchestrator", "cursor:composer-2.5", "--verifier", "cursor:grok-4.7-xhigh"],
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
    await expect(
      runRepair(["roles", "set", "--reviewer", "cursor:auto"], out),
    ).rejects.toThrow(/auto|拒绝/);
    expect(readFileSync(budget, "utf8")).toBe("{\"used\":3}\n");
    await runRepair(["roles", "reset"], out);
    const cleared = JSON.parse(readFileSync(join(home, "squad-bridge.json"), "utf8")) as {
      roles?: unknown;
    };
    expect(cleared.roles).toBeUndefined();
    expect(readFileSync(budget, "utf8")).toBe("{\"used\":3}\n");
  });
});
