/**
 * #372: the declared engines floor is at least every dependency floor in the
 * lockfile. README, root engines, the CLI package, and the Host/CLI node gate
 * state that same floor.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_NODE_FLOOR, SUPPORTED_NODE_RANGE } from "@shared/runtime/node-gate";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

interface Parts {
  major: number;
  minor: number;
  patch: number;
}

function compare(left: Parts, right: Parts): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function parseParts(text: string): Parts | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? "0"),
    patch: Number(match[3] ?? "0"),
  };
}

/** Lowest version a single alternative can accept. Upper bounds are ignored. */
function alternativeFloor(alternative: string): Parts | null {
  const trimmed = alternative.trim();
  if (trimmed.length === 0 || trimmed === "*" || /^[xX]$/.test(trimmed)) {
    return { major: 0, minor: 0, patch: 0 };
  }
  if (/^</.test(trimmed)) return null;
  const match = /^(?:>=|>|\^|~|=|v)?\s*v?(\d+(?:\.\d+){0,2})/.exec(trimmed);
  if (!match?.[1]) return null;
  return parseParts(match[1]);
}

function enginesNodeFloor(range: string): Parts | null {
  let best: Parts | null = null;
  for (const alternative of range.split("||")) {
    const floor = alternativeFloor(alternative);
    if (floor === null) continue;
    if (best === null || compare(floor, best) < 0) best = floor;
  }
  return best;
}

function lockfileNodeRanges(lockfile: string): string[] {
  const ranges: string[] = [];
  const re = /engines:\s*\{[^{}]*?\bnode:\s*(?:'([^']*)'|"([^"]*)"|([^,}\n]+))\s*[,}]/g;
  for (const match of lockfile.matchAll(re)) {
    const range = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (range.length > 0) ranges.push(range);
  }
  return ranges;
}

describe("#372 engines floor covers the lockfile", () => {
  const declared = parseParts(SUPPORTED_NODE_FLOOR);
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    engines?: { node?: string };
    packageManager?: string;
  };
  const cliPkg = JSON.parse(readFileSync(join(ROOT, "cli/package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const lockfile = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");

  it("root, CLI package, and the gate export the same range", () => {
    expect(rootPkg.engines?.node).toBe(SUPPORTED_NODE_RANGE);
    expect(cliPkg.engines?.node).toBe(SUPPORTED_NODE_RANGE);
    expect(declared).toEqual({ major: 22, minor: 22, patch: 2 });
  });

  it("README states that floor and how to install the pinned pnpm", () => {
    expect(readme).toContain(SUPPORTED_NODE_FLOOR);
    expect(readme).toContain("npm install -g pnpm@10.34.6");
    expect(rootPkg.packageManager).toBe("pnpm@10.34.6");
    expect(readme).toContain("cfuse-claude-code");
    expect(readme).toContain("`cld login`");
  });

  it("the declared floor is >= every dependency engines floor in the lockfile", () => {
    const ranges = lockfileNodeRanges(lockfile);
    expect(ranges.length).toBeGreaterThan(10);
    expect(ranges).toContain("^22.22.2 || ^24.15.0 || >=26.0.0");
    expect(declared).not.toBeNull();
    const declaredParts = declared as Parts;
    for (const range of ranges) {
      const floor = enginesNodeFloor(range);
      expect(floor, range).not.toBeNull();
      expect(
        compare(declaredParts, floor as Parts),
        `${SUPPORTED_NODE_FLOOR} is below ${range} (floor ${floor?.major}.${floor?.minor}.${floor?.patch})`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});
