import "./app-dom-install";

import { installPrimaryShortcut, isPrimaryEnter, resolvePrimaryAction } from "@/app/shortcuts";
import { describe, expect, it } from "vitest";

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

describe("primary shortcut predicates", () => {
  it("accepts only meta or ctrl enter", () => {
    expect(isPrimaryEnter({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPrimaryEnter({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPrimaryEnter({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isPrimaryEnter({ key: "Escape", metaKey: true, ctrlKey: false })).toBe(false);
  });

  it("silences an open modal, then prefers send over start-round", () => {
    expect(
      resolvePrimaryAction({ focusInUserInput: true, modalOpen: true, canStartRound: true }),
    ).toBe(null);
    expect(
      resolvePrimaryAction({ focusInUserInput: true, modalOpen: false, canStartRound: true }),
    ).toBe("send");
    expect(
      resolvePrimaryAction({ focusInUserInput: false, modalOpen: false, canStartRound: true }),
    ).toBe("start-round");
    expect(
      resolvePrimaryAction({ focusInUserInput: false, modalOpen: false, canStartRound: false }),
    ).toBe(null);
  });
});

describe("installPrimaryShortcut", () => {
  it("sends from the user-input, starts a round otherwise, and ignores a modal", () => {
    const calls: string[] = [];
    let allowed = true;
    const uninstall = installPrimaryShortcut({
      onSend: () => calls.push("send"),
      onStartRound: () => calls.push("start"),
      canStartRound: () => allowed,
    });

    const ignored = press({ key: "Enter" });
    expect(ignored.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);

    const started = press({ key: "Enter", ctrlKey: true });
    expect(started.defaultPrevented).toBe(true);
    expect(calls).toEqual(["start"]);

    const input = document.createElement("input");
    input.setAttribute("aria-label", "用户发言");
    document.body.appendChild(input);
    input.focus();
    const sent = press({ key: "Enter", metaKey: true });
    expect(sent.defaultPrevented).toBe(true);
    expect(calls).toEqual(["start", "send"]);

    const dialog = document.createElement("dialog");
    dialog.open = true;
    document.body.appendChild(dialog);
    const silenced = press({ key: "Enter", metaKey: true });
    expect(silenced.defaultPrevented).toBe(false);
    expect(calls).toEqual(["start", "send"]);
    dialog.remove();

    allowed = false;
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "别处";
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    const blocked = press({ key: "Enter", metaKey: true });
    expect(blocked.defaultPrevented).toBe(false);
    expect(calls).toEqual(["start", "send"]);

    uninstall();
    const after = press({ key: "Enter", ctrlKey: true });
    expect(after.defaultPrevented).toBe(false);
    expect(calls).toEqual(["start", "send"]);
    input.remove();
    elsewhere.remove();
  });
});
