import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQUAD_BRIDGE_CONTRACT_VERSION } from "@shared/runtime/squad-bridge-contract";
import { probeSquadBridge } from "@shared/runtime/squad-bridge-discovery";
import { afterEach, describe, expect, it } from "vitest";

const REQUIRED_DOC = `# squadctl
squadctl init
squadctl intake
squadctl status
squadctl resume
squadctl adapter
integrate check-remote
integrate push-remote
`;

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(path, 0o755);
}

function seedSkill(root: string, opts?: { verbs?: string; squadctlBody?: string }): string {
  const skillDir = join(root, "skills", "hengzhuo-engineering-squad");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  mkdirSync(join(skillDir, "references"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# 工程 Squad v2.1\n", "utf8");
  writeFileSync(join(skillDir, "references", "squadctl.md"), opts?.verbs ?? REQUIRED_DOC, "utf8");
  writeExecutable(
    join(skillDir, "scripts", "squadctl"),
    opts?.squadctlBody ?? "#!/bin/sh\necho squadctl\n",
  );
  return skillDir;
}

function seedGrokb(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "grokb");
  writeExecutable(path, "#!/bin/sh\necho grokb\n");
  return path;
}

function isolatedEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const empty = tempDir("ck-empty-home-");
  return {
    PATH: join(empty, "no-bin"),
    HOME: empty,
    CODEX_HOME: join(empty, "no-codex"),
    COUNCILKIT_HOME: join(empty, "no-ck"),
    XDG_CONFIG_HOME: join(empty, "no-xdg"),
    ...overrides,
  };
}

describe("squad bridge discovery", () => {
  it("is unavailable when PATH and skill installs are empty", () => {
    const probe = probeSquadBridge(isolatedEnv({}));
    expect(probe.available).toBe(false);
    expect(probe.version).toBeNull();
    expect(probe.reason).toMatch(/squadctl/i);
    expect(probe.reason).not.toMatch(/\/Users\/hengzhuo\//);
  });

  it("finds an installed skill when PATH has no squadctl", () => {
    const home = tempDir("ck-skill-home-");
    const skillDir = seedSkill(join(home, ".codex"));
    const grokb = seedGrokb(join(home, "bin"));
    const probe = probeSquadBridge(
      isolatedEnv({
        HOME: home,
        PATH: join(home, "missing-bin"),
        COUNCILKIT_ORCHESTRATOR_RUNTIME: "grokb",
      }),
    );
    expect(probe.available).toBe(true);
    expect(probe.version).toBe(SQUAD_BRIDGE_CONTRACT_VERSION);
    expect(probe.reason).toBeNull();
    expect(probe.historyContract).toBeNull();
    expect(probe.executable).toBe(join(skillDir, "scripts", "squadctl"));
    expect(probe.skillDir).toBe(skillDir);
    expect(probe.orchestrator?.requestedRuntime).toBe("grokb");
    expect(probe.orchestrator?.model).toBe("grok-4.6");
    expect(probe.orchestrator?.actualRuntime).toBeNull();
    expect(probe.orchestrator?.nativeSession).toBeNull();
    expect(probe.orchestrator?.executable).toBe(grokb);
  });

  it("does not mark ready when only a PATH file exists without skill verbs", () => {
    const home = tempDir("ck-bare-bin-");
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeExecutable(join(bin, "squadctl"), "#!/bin/sh\necho hi\n");
    seedGrokb(bin);
    const probe = probeSquadBridge(
      isolatedEnv({
        HOME: home,
        PATH: bin,
      }),
    );
    expect(probe.available).toBe(false);
    expect(probe.version).toBeNull();
    expect(probe.reason).toMatch(/skill|说明书|COUNCILKIT_SQUAD_SKILL/i);
  });

  it("does not mark ready when skill docs omit integrate check-remote/push-remote", () => {
    const home = tempDir("ck-incomplete-skill-");
    seedSkill(join(home, ".codex"), {
      verbs: "# squadctl\nsquadctl init\nsquadctl status\n",
    });
    seedGrokb(join(home, "bin"));
    const probe = probeSquadBridge(isolatedEnv({ HOME: home }));
    expect(probe.available).toBe(false);
    expect(probe.version).toBeNull();
    expect(probe.reason).toMatch(/check-remote|push-remote/);
  });

  it("does not mark ready when squadctl exists but cursor-agent does not", () => {
    const home = tempDir("ck-no-orch-");
    seedSkill(join(home, ".codex"));
    seedGrokb(join(home, "bin"));
    const probe = probeSquadBridge(isolatedEnv({ HOME: home }));
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/cursor-agent/);
    expect(probe.reason).toMatch(/拒绝回退/);
  });

  it("discovers cursor-agent when grokb and grok are absent", () => {
    const home = tempDir("ck-cursor-only-");
    const skillDir = seedSkill(join(home, ".codex"));
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const cursor = join(bin, "cursor-agent");
    writeExecutable(cursor, "#!/bin/sh\necho cursor\n");
    const probe = probeSquadBridge(
      isolatedEnv({
        HOME: home,
        PATH: bin,
      }),
    );
    expect(probe.available).toBe(true);
    expect(probe.skillDir).toBe(skillDir);
    expect(probe.orchestrator?.requestedRuntime).toBe("cursor");
    expect(probe.orchestrator?.executable).toBe(cursor);
    expect(probe.orchestrator?.model).toBe(
      "grok-4.7[context=500k,reasoning_effort=xhigh,fast=false]",
    );
  });

  it("prefers cursor-agent over a PATH grokb unless runtime is explicitly grok", () => {
    const home = tempDir("ck-both-runtimes-");
    seedSkill(join(home, ".codex"));
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const cursor = join(bin, "cursor-agent");
    writeExecutable(cursor, "#!/bin/sh\necho cursor\n");
    seedGrokb(bin);
    const probe = probeSquadBridge(isolatedEnv({ HOME: home, PATH: bin }));
    expect(probe.available).toBe(true);
    expect(probe.orchestrator?.requestedRuntime).toBe("cursor");
    expect(probe.orchestrator?.executable).toBe(cursor);
  });

  it("keeps an explicit non-500k cursor model as itself and still refuses auto", () => {
    const home = tempDir("ck-explicit-model-");
    seedSkill(join(home, ".codex"));
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeExecutable(join(bin, "cursor-agent"), "#!/bin/sh\necho cursor\n");
    const ckHome = join(home, "ck");
    mkdirSync(ckHome, { recursive: true });
    writeFileSync(
      join(ckHome, "squad-bridge.json"),
      `${JSON.stringify({
        model: "grok-4.7-xhigh",
        roles: { reviewer: { runtime: "codex", model: "gpt-5.6-sol" } },
      })}\n`,
    );
    const probe = probeSquadBridge(
      isolatedEnv({ HOME: home, PATH: bin, COUNCILKIT_HOME: ckHome }),
    );
    expect(probe.available).toBe(true);
    expect(probe.orchestrator?.model).toBe("grok-4.7-xhigh");
    writeFileSync(join(ckHome, "squad-bridge.json"), `${JSON.stringify({ model: "auto" })}\n`);
    const refused = probeSquadBridge(
      isolatedEnv({ HOME: home, PATH: bin, COUNCILKIT_HOME: ckHome }),
    );
    expect(refused.available).toBe(false);
    expect(refused.reason).toMatch(/auto|拒绝/);
  });

  it("honors COUNCILKIT_SQUADCTL and COUNCILKIT_SQUAD_SKILL without a personal path constant", () => {
    const root = tempDir("ck-config-");
    const skillDir = seedSkill(root);
    const grokb = seedGrokb(join(root, "bin"));
    const probe = probeSquadBridge(
      isolatedEnv({
        PATH: join(root, "empty-path"),
        COUNCILKIT_SQUADCTL: join(skillDir, "scripts", "squadctl"),
        COUNCILKIT_SQUAD_SKILL: skillDir,
        COUNCILKIT_GROKB: grokb,
      }),
    );
    expect(probe.available).toBe(true);
    expect(probe.executable).toBe(join(skillDir, "scripts", "squadctl"));
    expect(probe.skillDir).toBe(skillDir);
  });

  it("reads COUNCILKIT_HOME/squad-bridge.json", () => {
    const root = tempDir("ck-home-cfg-");
    const skillDir = seedSkill(root);
    const grokb = seedGrokb(join(root, "bin"));
    const ckHome = join(root, "ck-home");
    mkdirSync(ckHome, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(ckHome, "squad-bridge.json"),
      `${JSON.stringify({
        executable: join(skillDir, "scripts", "squadctl"),
        skillDir,
        grokb,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const probe = probeSquadBridge(
      isolatedEnv({
        COUNCILKIT_HOME: ckHome,
        PATH: join(root, "empty-path"),
      }),
    );
    expect(probe.available).toBe(true);
    expect(probe.skillDir).toBe(skillDir);
  });

  it("fails closed when COUNCILKIT_SQUADCTL is set but invalid, even if a skill exists", () => {
    const home = tempDir("ck-bad-explicit-");
    seedSkill(join(home, ".codex"));
    seedGrokb(join(home, "bin"));
    const probe = probeSquadBridge(
      isolatedEnv({
        HOME: home,
        COUNCILKIT_SQUADCTL: join(home, "missing-squadctl"),
      }),
    );
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/停止继续扫描|无效/);
  });

  it("does not treat a differently named skill as the squad skill", () => {
    const home = tempDir("ck-other-skill-");
    const other = join(home, ".codex", "skills", "some-other-skill");
    mkdirSync(join(other, "scripts"), { recursive: true });
    mkdirSync(join(other, "references"), { recursive: true });
    writeFileSync(join(other, "SKILL.md"), "# other\n", "utf8");
    writeFileSync(join(other, "references", "squadctl.md"), REQUIRED_DOC, "utf8");
    writeExecutable(join(other, "scripts", "squadctl"), "#!/bin/sh\necho other\n");
    seedGrokb(join(home, "bin"));
    const probe = probeSquadBridge(isolatedEnv({ HOME: home }));
    expect(probe.available).toBe(false);
  });

  it("does not treat a non-executable skill file as ready", () => {
    const home = tempDir("ck-not-exec-");
    const skillDir = seedSkill(join(home, ".codex"));
    chmodSync(join(skillDir, "scripts", "squadctl"), 0o644);
    seedGrokb(join(home, "bin"));
    const probe = probeSquadBridge(isolatedEnv({ HOME: home }));
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/不可执行|executable/i);
  });

  it("refuses a damaged squad-bridge.json instead of using the default model", () => {
    const home = tempDir("ck-bad-json-");
    seedSkill(join(home, ".codex"));
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeExecutable(join(bin, "cursor-agent"), "#!/bin/sh\necho cursor\n");
    const ckHome = join(home, "ck");
    mkdirSync(ckHome, { recursive: true });
    const configPath = join(ckHome, "squad-bridge.json");
    writeFileSync(configPath, "{not json\n");
    const probe = probeSquadBridge(isolatedEnv({ HOME: home, PATH: bin, COUNCILKIT_HOME: ckHome }));
    expect(probe.available).toBe(false);
    expect(probe.reason).toMatch(/JSON/);
    expect(probe.orchestrator).toBeNull();
    expect(readFileSync(configPath, "utf8")).toBe("{not json\n");
    chmodSync(configPath, 0o000);
    const denied = probeSquadBridge(isolatedEnv({ HOME: home, PATH: bin, COUNCILKIT_HOME: ckHome }));
    expect(denied.available).toBe(false);
    expect(denied.reason).toMatch(/无法读取/);
    chmodSync(configPath, 0o600);
  });
});
