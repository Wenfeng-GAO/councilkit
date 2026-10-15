/**
 * #282 similar-bug sweep: every workspace package must declare the same
 * engines.node as the root. A narrower range in one package (cli had "^22")
 * makes `pnpm install` fail with ERR_PNPM_UNSUPPORTED_ENGINE on Node 24/26
 * under engine-strict, even though the root says ">=22".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_NODE_MAJOR } from "@shared/runtime/contracts";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

function enginesNode(dir: string): unknown {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    engines?: { node?: unknown };
  };
  return pkg.engines?.node;
}

function workspacePackageDirs(): string[] {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const block = /^packages:\s*\n((?:\s+-\s+.+\n?)+)/m.exec(yaml)?.[1] ?? "";
  return block
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s+-\s+/, "")
        .replace(/['"]/g, "")
        .trim(),
    )
    .filter((entry) => entry.length > 0);
}

describe("#282 workspace engines agree with the root", () => {
  const root = enginesNode(ROOT);

  it("the root declares Node >= the Host's minimum major", () => {
    expect(root).toBe(`>=${SUPPORTED_NODE_MAJOR}`);
  });

  it("lists at least one workspace package (guards the parser)", () => {
    expect(workspacePackageDirs().length).toBeGreaterThan(0);
  });

  for (const entry of workspacePackageDirs()) {
    it(`${entry}/package.json engines.node equals the root's`, () => {
      expect(entry.includes("*"), `glob workspace entries are not supported: ${entry}`).toBe(false);
      const dir = join(ROOT, entry);
      expect(existsSync(join(dir, "package.json"))).toBe(true);
      expect(enginesNode(dir)).toBe(root);
    });
  }
});
