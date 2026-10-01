import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors";
import { bindTrustedRoot, revalidateTrustedRoot } from "../src/fs-safe";

describe("revalidateTrustedRoot", () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const parent = mkdtempSync(join(tmpdir(), "ck-fs-safe-"));
    temps.push(parent);
    const root = join(parent, "runs");
    mkdirSync(root);
    writeFileSync(join(root, "marker.txt"), "orig");
    return root;
  }

  it("accepts the real directory it just bound", () => {
    const root = makeRoot();
    const bound = bindTrustedRoot(root);
    expect(bound).not.toBeNull();
    if (bound === null) throw new Error("bindTrustedRoot returned null");
    revalidateTrustedRoot(bound);
    expect(readFileSync(join(root, "marker.txt"), "utf8")).toBe("orig");
  });

  it("rejects a same-path real directory that replaced the bound root", () => {
    const root = makeRoot();
    const bound = bindTrustedRoot(root);
    expect(bound).not.toBeNull();
    if (bound === null) throw new Error("bindTrustedRoot returned null");

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    writeFileSync(join(root, "precious.txt"), "keep me");

    let thrown: unknown;
    try {
      revalidateTrustedRoot(bound);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    expect(err.exitCode).toBe(5);
    expect(err.message).toBe("the trusted root changed (refusing to proceed)");
    expect(readFileSync(join(root, "precious.txt"), "utf8")).toBe("keep me");
  });
});
