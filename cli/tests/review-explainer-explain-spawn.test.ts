import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FINDING, MODULES } from "../../tests/review-explainer/contract";
import { importFeature, requireExport } from "../../tests/review-explainer/load-feature";
import { buildIdeateSpawnSpec, buildSpawnSpec } from "../src/auto/driver-commands";
import { IDEATE_FORBIDDEN_FLAGS, assertIdeateRestrictedArgv } from "../src/auto/ideate-policy";
import { Store } from "../src/store/store";

describe("A07 restricted explain spawn", () => {
  let home: string;
  const oldHome = process.env.COUNCILKIT_HOME;
  const oldPath = process.env.PATH;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-explainer-spawn-"));
    process.env.COUNCILKIT_HOME = home;
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["cld", "kimi", "grok", "codex"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    process.env.PATH = `${bin}${oldPath ? `:${oldPath}` : ""}`;
  });

  afterEach(() => {
    if (oldHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
    else process.env.COUNCILKIT_HOME = oldHome;
    if (oldPath === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  });

  it("uses the restricted ideate-style spawn, not full-capability review spawn", async () => {
    const store = new Store();
    const agent = store.createAgent({
      name: "explainer",
      personaPrompt: "explain",
      modelId: "grok-4.6",
      color: "#abcdef",
      driverSelection: { driverId: "grok-stream-json", options: {} },
    });
    const workspace = join(home, "ws");
    mkdirSync(workspace, { recursive: true });
    const mod = await importFeature<Record<string, unknown>>(MODULES.explainSpawn);
    const buildExplainSpawnSpec = requireExport<
      (
        record: unknown,
        opts: Record<string, unknown>,
      ) => { argv: string[]; prompt: string; driverId: string }
    >(mod, "buildExplainSpawnSpec", MODULES.explainSpawn);
    const spec = buildExplainSpawnSpec(agent, {
      attemptId: "explain-1",
      workspace,
      findingId: FINDING.busy,
      prompt: `Explain ${FINDING.busy} with frozen code only. Do not edit files.`,
    });
    expect(spec.prompt).toContain(FINDING.busy);
    expect(spec.prompt).toMatch(/do not edit|不要修改|read-only|只读/i);
    for (const flag of IDEATE_FORBIDDEN_FLAGS) {
      expect(spec.argv.includes(flag)).toBe(false);
    }
    assertIdeateRestrictedArgv(spec.argv, spec.driverId);
    const full = buildSpawnSpec(agent, {
      attemptId: "review-1",
      workspace,
      prompt: "review",
    });
    expect(spec.argv.join(" ")).not.toBe(full.argv.join(" "));
    const ideate = buildIdeateSpawnSpec(agent, {
      attemptId: "ideate-1",
      workspace: join(home, "ideate-ws"),
      prompt: "idea",
    });
    expect(spec.argv).toEqual(
      expect.arrayContaining(ideate.argv.filter((arg) => arg.startsWith("--"))),
    );
  });
});
