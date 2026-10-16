/**
 * #283 (DOC-01..03): README / product / roadmap / CONTEXT / AGENTS must agree
 * with each other and with the code (platform, Drivers, API keys, data
 * boundary, commands). A doc drifting back is a test failure, not a QA find.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DRIVER_IDS } from "@shared/runtime/contracts";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const PLATFORM = "macOS 支持；Linux 可用（预览）；Windows 请用 WSL2";
const CURRENT_DOCS = [
  "README.md",
  "AGENTS.md",
  "CONTEXT.md",
  "docs/product.md",
  "docs/roadmap.md",
  "docs/cli-handbook.md",
];

describe("docs consistency (#283)", () => {
  it("DOC-01 README has the clone step, real commands and real route names", () => {
    const readme = read("README.md");
    expect(readme).toContain("git clone https://github.com/Wenfeng-GAO/councilkit.git");
    expect(readme).toContain("pnpm@10.34.6");
    expect(readme).toContain("councilkit demo");
    const commands = new Set(
      readdirSync(join(ROOT, "cli/src/commands")).map((file) => file.replace(/\.ts$/, "")),
    );
    const used = [...readme.matchAll(/councilkit ([a-z]+)/g)].map((match) => match[1] as string);
    expect(used.length).toBeGreaterThan(3);
    for (const command of used) expect(commands, `councilkit ${command}`).toContain(command);
    // The claude route enum is ant-glm5.2|moonshot|deepseek|cfuse; a bare `ant` route is wrong.
    expect(readme).not.toMatch(/`ant`/);
    expect(read("package.json")).toContain('"packageManager": "pnpm@10.34.6"');
  });

  it("DOC-02 product / roadmap / CONTEXT agree on form, Drivers, API keys and data", () => {
    const product = read("docs/product.md");
    const roadmap = read("docs/roadmap.md");
    const context = read("CONTEXT.md");
    for (const doc of [product, roadmap, context]) {
      for (const driver of DRIVER_IDS) expect(doc).toContain(driver);
    }
    for (const doc of [product, roadmap]) {
      expect(doc).not.toContain("双 Driver");
      expect(doc).not.toMatch(/macOS app/i);
      expect(doc).not.toMatch(/Keychain/);
      expect(doc).not.toMatch(/三程序/);
    }
    const tscPrograms =
      (JSON.parse(read("package.json")).scripts.typecheck as string).split("tsc ").length - 1;
    expect(tscPrograms).toBe(4);
    expect(read("README.md")).toContain("四个 tsc 程序");
    expect(roadmap).toContain("四个 tsc 程序");
    // Data boundary: the report page reads CLI runs; no blanket "not shared" claim.
    for (const rel of CURRENT_DOCS) {
      expect(read(rel), rel).not.toMatch(/CLI 与浏览器\*{0,2}数据不互通/);
    }
    expect(read("README.md")).toContain("~/.config/councilkit/runs/");
    expect(product).toContain("~/.config/councilkit/runs/");
    // The outdated MVP plan is kept only as a marked historical document.
    expect(read("docs/history/2026-06-product-mvp-plan.md")).toMatch(/^> \*\*历史文档/);
    expect(read("docs/technical-design.md")).toMatch(/^> \*\*历史文档/);
  });

  it("DOC-03 one platform statement everywhere; no macOS-only claim", () => {
    for (const rel of ["README.md", "docs/product.md", "docs/roadmap.md"]) {
      expect(read(rel), rel).toContain(PLATFORM);
    }
    for (const rel of CURRENT_DOCS) {
      const doc = read(rel);
      expect(doc, rel).not.toMatch(/macOS only/i);
      expect(doc, rel).not.toContain("仅支持 macOS");
    }
  });
});
