import { parseMaxRoundsInput } from "@/app/pages/NewRoomPage";
import { describe, expect, it } from "vitest";

/**
 * NewRoomPage maxRounds input parser (G3 regression guard): the pure
 * `parseMaxRoundsInput` extracted from the submit handler pins the three-state
 * validation contract the page relies on — null (unlimited), a positive
 * integer, or undefined (illegal). The spec's "must red when loosened to
 * `!= null`" cases live here; the orchestrator/transaction suites are
 * unaffected (they consume the already-validated number).
 */

describe("parseMaxRoundsInput", () => {
  it('"3" → 3 (valid positive integer)', () => {
    expect(parseMaxRoundsInput("3")).toBe(3);
  });

  it("空串 / 纯空白 → null（不限）", () => {
    expect(parseMaxRoundsInput("")).toBeNull();
    expect(parseMaxRoundsInput("   ")).toBeNull();
  });

  it('" 3 " → 3（前后空白容错，内部仍合法）', () => {
    expect(parseMaxRoundsInput(" 3 ")).toBe(3);
  });

  it('"2.5" → undefined（拒绝小数/静默截断）', () => {
    expect(parseMaxRoundsInput("2.5")).toBeUndefined();
  });

  it('"3abc" → undefined（拒绝数字+字母混合的静默截断）', () => {
    expect(parseMaxRoundsInput("3abc")).toBeUndefined();
  });

  it('"0" → undefined（非正整数）', () => {
    expect(parseMaxRoundsInput("0")).toBeUndefined();
  });

  it('"-1" → undefined（负数：数字符正则已排除符号）', () => {
    expect(parseMaxRoundsInput("-1")).toBeUndefined();
  });
});
