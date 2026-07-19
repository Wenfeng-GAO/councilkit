import { isPrimaryEnter, resolvePrimaryAction } from "@/app/shortcuts";
import { describe, expect, it } from "vitest";

/**
 * S8 主快捷键纯谓词（plan-a §1.7）：isPrimaryEnter（⌘/Ctrl+Enter）与
 * resolvePrimaryAction（modalOpen > focusInUserInput > canStartRound 优先级）。
 * installPrimaryShortcut 是 DOM 胶（段 2 接线 / e2e 覆盖），不在 node 单测范围。
 */

describe("isPrimaryEnter", () => {
  it("meta/ctrl + Enter → true", () => {
    expect(isPrimaryEnter({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPrimaryEnter({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPrimaryEnter({ key: "Enter", metaKey: true, ctrlKey: true })).toBe(true);
  });

  it("bare Enter or non-Enter with meta → false", () => {
    expect(isPrimaryEnter({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isPrimaryEnter({ key: "a", metaKey: true, ctrlKey: false })).toBe(false);
    expect(isPrimaryEnter({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
  });
});

describe("resolvePrimaryAction", () => {
  it("focus in user input → send", () => {
    expect(
      resolvePrimaryAction({ focusInUserInput: true, modalOpen: false, canStartRound: false }),
    ).toBe("send");
  });

  it("no input focus + canStartRound → start-round", () => {
    expect(
      resolvePrimaryAction({ focusInUserInput: false, modalOpen: false, canStartRound: true }),
    ).toBe("start-round");
  });

  it("modal open → null even when focus is in the input", () => {
    expect(
      resolvePrimaryAction({ focusInUserInput: true, modalOpen: true, canStartRound: true }),
    ).toBeNull();
  });

  it("no input focus + !canStartRound → null", () => {
    expect(
      resolvePrimaryAction({ focusInUserInput: false, modalOpen: false, canStartRound: false }),
    ).toBeNull();
  });

  it("input focus takes priority over canStartRound", () => {
    expect(
      resolvePrimaryAction({ focusInUserInput: true, modalOpen: false, canStartRound: true }),
    ).toBe("send");
  });
});
