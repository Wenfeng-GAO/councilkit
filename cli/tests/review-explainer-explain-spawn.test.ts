import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FINDING, MODULES } from "../../tests/review-explainer/contract";
import { importFeature, requireExport } from "../../tests/review-explainer/load-feature";
import { buildIdeateSpawnSpec, buildSpawnSpec } from "../src/auto/driver-commands";
import {
  IDEATE_FORBIDDEN_FLAGS,
  assertIdeateRestrictedArgv,
  disposeIdeateAuthHome,
} from "../src/auto/ideate-policy";
import { Store } from "../src/store/store";

describe("A07 restricted explain spawn", () => {
  let home: string;
  const oldHome = process.env.COUNCILKIT_HOME;
  const oldPath = process.env.PATH;
  const oldGrokHome = process.env.GROK_HOME;
  const authHomes: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-explainer-spawn-"));
    process.env.GROK_HOME = home;
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
    if (oldGrokHome === undefined) Reflect.deleteProperty(process.env, "GROK_HOME");
    else process.env.GROK_HOME = oldGrokHome;
    for (const dir of authHomes.splice(0)) disposeIdeateAuthHome(dir);
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
      ) => { argv: string[]; prompt: string; driverId: string; ephemeralHome?: string }
    >(mod, "buildExplainSpawnSpec", MODULES.explainSpawn);
    const spec = buildExplainSpawnSpec(agent, {
      attemptId: "explain-1",
      workspace,
      findingId: FINDING.busy,
      prompt: `Explain ${FINDING.busy} with frozen code only. Do not edit files.`,
    });
    if (spec.ephemeralHome) authHomes.push(spec.ephemeralHome);
    expect(spec.prompt).toContain(FINDING.busy);
    expect(spec.prompt).toMatch(/do not edit|不要修改|read-only|只读/i);
    for (const flag of IDEATE_FORBIDDEN_FLAGS) {
      expect(spec.argv.includes(flag)).toBe(false);
    }
    assertIdeateRestrictedArgv(spec.argv, spec.driverId);
    const disabled = spec.argv[spec.argv.indexOf("--disallowed-tools") + 1]?.split(",");
    expect(disabled).toEqual(
      expect.arrayContaining([
        "read_file",
        "list_dir",
        "grep",
        "monitor",
        "search_tool",
        "use_tool",
        "workflow",
        "enter_plan_mode",
        "exit_plan_mode",
        "ask_user_question",
        "send_feedback",
        "image_gen",
        "image_edit",
        "image_to_video",
        "reference_to_video",
        "run_terminal_cmd",
        "write",
      ]),
    );
    expect(spec.argv[spec.argv.indexOf("--max-turns") + 1]).toBe("1");
    expect(spec.argv[spec.argv.indexOf("--reasoning-effort") + 1]).toBe("low");
    expect(spec.argv.join(" ")).toContain("--deny Read --deny Grep");
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
    if (ideate.ephemeralHome) authHomes.push(ideate.ephemeralHome);
    expect(ideate.argv).not.toContain("--max-turns");
    expect(spec.argv).toEqual(
      expect.arrayContaining(ideate.argv.filter((arg) => arg.startsWith("--"))),
    );
  });
});
