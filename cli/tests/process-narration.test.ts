/**
 * Recorded streams whose final deliverable starts with process narration (#379).
 * One fixture per driver: kimi, cursor, codex, cld (claude-stream-json), grok.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractFinalOutput } from "../src/auto/driver-commands";
import { stripProcessNarration } from "../src/auto/process-narration";

const FIXTURE = join(import.meta.dirname, "fixtures/process-narration");

function stream(name: string): string {
  return readFileSync(join(FIXTURE, name), "utf8");
}

const DRIVERS = [
  ["kimi", "kimi-stream-json", "kimi.jsonl"],
  ["cursor", "cursor-stream-json", "cursor.jsonl"],
  ["codex", "codex-app-server", "codex.jsonl"],
  ["cld", "claude-stream-json", "cld.jsonl"],
  ["grok", "grok-stream-json", "grok.jsonl"],
] as const;

describe("process narration is stripped from every driver", () => {
  it.each(DRIVERS)(
    "%s recorded stream keeps the review and drops 正在读取规格文件",
    (_label, driverId, file) => {
      const text = extractFinalOutput(driverId, stream(file));
      expect(text).not.toBeNull();
      expect(text?.startsWith("## 发现")).toBe(true);
      expect(text).not.toContain("正在读取规格文件");
      expect(text).toContain("changes-requested");
      expect(text).toContain("示例缺陷");
    },
  );

  it("keeps a real lead-in that is not status chatter", () => {
    const text = "这个 diff 把加法改成了减法。\n\n## 发现\n- [major] Add 用减法\n";
    expect(stripProcessNarration(text)).toBe(text);
  });

  it("leaves a deliverable that already starts at the heading", () => {
    const text = "## 发现\n- [major] 示例缺陷\n";
    expect(stripProcessNarration(text)).toBe(text);
  });
});
