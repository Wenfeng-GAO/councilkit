/**
 * Room page primary shortcut (S8): ⌘/Ctrl+Enter sends (when focus is in the
 * user-input box) or starts a new round (otherwise). Modal open → the shortcut
 * is silenced. Esc closes Modals — that is the Modal's own window-level
 * listener (Modal.tsx), NOT registered here, so there is zero conflict.
 *
 * The pure predicates (`isPrimaryEnter`, `resolvePrimaryAction`) are unit-
 * tested in tests/unit/shortcuts.test.ts. `installPrimaryShortcut` is the thin
 * DOM glue the RoomPage effect consumes (wired in segment 2); all DOM access
 * is confined to its body so module load stays side-effect-free in the node
 * test environment.
 */

export function isPrimaryEnter(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

export type PrimaryShortcutAction = "send" | "start-round";

/** Resolve the action a primary-enter press should trigger under the current
 * focus/modal/context. Priority: modalOpen → null（Modal 打开时全局快捷键静默）；
 * focusInUserInput → "send"；否则 canStartRound → "start-round"；否则 null。
 * focusInUserInput 优先于 canStartRound。 */
export function resolvePrimaryAction(input: {
  focusInUserInput: boolean;
  modalOpen: boolean;
  canStartRound: boolean;
}): PrimaryShortcutAction | null {
  if (input.modalOpen) return null;
  if (input.focusInUserInput) return "send";
  if (input.canStartRound) return "start-round";
  return null;
}

export interface PrimaryShortcutHandlers {
  onSend(): void;
  onStartRound(): void;
  /** Re-evaluated on every keydown — mirrors the start-round button's disabled
   * guard (controlling && !concluding && !hasActiveRound && phase !==
   * "concluded" && !startRound.isPending). */
  canStartRound(): boolean;
}

/**
 * Register the window-level ⌘/Ctrl+Enter listener. Returns the uninstaller.
 * The caller's `onSend` goes through `input.form?.requestSubmit()` (reuses
 * UserInputBar's trim/disabled validation, zero logic duplication); every
 * handled press calls `preventDefault()` so browsers that fire a native
 * implicit submit on Cmd+Enter cannot double-send.
 */
export function installPrimaryShortcut(handlers: PrimaryShortcutHandlers): () => void {
  function onKeyDown(event: KeyboardEvent): void {
    if (!isPrimaryEnter(event)) return;
    const active = document.activeElement;
    const focusInUserInput =
      active instanceof HTMLElement && active.matches('input[aria-label="用户发言"]');
    const modalOpen = document.querySelector("dialog[open]") !== null;
    const action = resolvePrimaryAction({
      focusInUserInput,
      modalOpen,
      canStartRound: handlers.canStartRound(),
    });
    if (!action) return;
    event.preventDefault();
    if (action === "send") {
      handlers.onSend();
    } else {
      handlers.onStartRound();
    }
  }
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
