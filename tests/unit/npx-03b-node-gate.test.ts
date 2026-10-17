/**
 * NPX-03 / NPX-03b (#282): every entry refuses Node < 22 with the designer's
 * exact zh + en copy (version substituted), on stderr only, exit 1, and help
 * never prints. CLI launcher, npx (same bin) and Host share ONE constant.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  enforceSupportedNode,
  unsupportedNodeLines,
  unsupportedNodeMessage,
} from "@shared/runtime/node-gate";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const CLI_BIN = join(ROOT, "cli/bin/councilkit.mjs");
const CLI_GATE = join(ROOT, "cli/dist/node-gate.mjs");
const HOST = join(ROOT, "dist-host/main.mjs");
const OLD = "v20.19.2";
const EXACT_ZH =
  "CouncilKit 需要 Node.js 22.22.2 或更新版本，你现在用的是 v20.19.2。升级方法：`nvm install 22.22.2 && nvm use 22.22.2`，或者从 nodejs.org 下载 22.22.2 或更新的 LTS 版本。";
const EXACT_EN =
  "CouncilKit needs Node.js 22.22.2 or newer (you have v20.19.2). Upgrade with `nvm install 22.22.2 && nvm use 22.22.2`, or get 22.22.2 or a newer LTS from nodejs.org.";
// Simulate an old Node for the spawned entry: process.version is what the gate reads.
const FAKE_OLD = `--import=data:text/javascript,Object.defineProperty(process,"version",{value:"${OLD}"})`;
const built = existsSync(CLI_GATE) && existsSync(HOST);
const needBuilt = process.env.CI ? it : it.skipIf(!built);

function realNode20(): string | null {
  for (const bin of ["/usr/bin/node", "/usr/local/bin/node"]) {
    if (!existsSync(bin)) continue;
    const v = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim();
    if (/^v(1[89]|2[01])\./.test(v)) return bin;
  }
  return null;
}

describe("NPX-03b unsupported Node copy", () => {
  it("NPX-03 designer copy is exact: zh line first, then en, version substituted", () => {
    expect(unsupportedNodeLines(OLD)).toEqual([EXACT_ZH, EXACT_EN]);
    expect(unsupportedNodeMessage("v18.0.0")).toContain("你现在用的是 v18.0.0。");
    expect(unsupportedNodeMessage("v18.0.0")).toContain("(you have v18.0.0)");
  });

  it("NPX-03b gate writes exactly the two lines and exits 1; passes on >=22.22.2", () => {
    let err = "";
    let code: number | null = null;
    const io = {
      stderr: {
        write: (s: string) => {
          err += s;
        },
      },
      exit: (c: number) => {
        code = c;
        throw new Error("exit");
      },
    } as never;
    expect(() => enforceSupportedNode(OLD, io)).toThrow("exit");
    expect(code).toBe(1);
    expect(err).toBe(`${EXACT_ZH}\n${EXACT_EN}\n`);
    expect(() => enforceSupportedNode("v22.18.0", io)).toThrow("exit");
    expect(() => enforceSupportedNode("v22.22.2", io)).not.toThrow();
    expect(() => enforceSupportedNode("v24.15.0", io)).not.toThrow();
  });

  needBuilt("NPX-03b CLI entry --help on Node v20.19.2: stderr copy, exit 1, no help", () => {
    for (const args of [["--help"], ["review", "--help"], ["--version"], []]) {
      const r = spawnSync(process.execPath, [FAKE_OLD, CLI_BIN, ...args], { encoding: "utf8" });
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`${EXACT_ZH}\n${EXACT_EN}\n`);
    }
  });

  needBuilt("NPX-03b CLI entry still prints help on a supported Node", () => {
    const r = spawnSync(process.execPath, [CLI_BIN, "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  needBuilt("NPX-03 Host on Node v20.19.2: same stderr copy, exit 1, no JSON / stack", () => {
    const r = spawnSync(process.execPath, [FAKE_OLD, HOST], { encoding: "utf8", timeout: 20000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`${EXACT_ZH}\n${EXACT_EN}\n`);
  });

  const node20 = realNode20();
  it.skipIf(!node20 || !built)("NPX-03b real Node 20 binary: CLI and Host refuse", () => {
    for (const entry of [[CLI_BIN, "--help"], [HOST]]) {
      const r = spawnSync(node20 as string, entry, { encoding: "utf8", timeout: 20000 });
      const v = spawnSync(node20 as string, ["--version"], { encoding: "utf8" }).stdout.trim();
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`${unsupportedNodeMessage(v)}\n`);
    }
  });
});
