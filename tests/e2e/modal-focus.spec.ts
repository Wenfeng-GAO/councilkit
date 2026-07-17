/**
 * Modal focus management (plan §589): asserts the generic Modal's focus
 * behavior on the Settings Profile/Agent form modals — initial focus into
 * the dialog, Tab/Shift+Tab trap cycling, and focus restore on Esc close.
 */
import { expect, test } from "@playwright/test";
import { createProfile } from "./helpers";
import { bootSettings } from "./security-helpers";

test("probe: Profile/Agent modals trap focus and restore it on close", async ({ page }) => {
  await bootSettings(page);
  await expect(page.getByText("本地执行服务在线")).toBeVisible();

  // --- Profile modal (keyboard path) ---
  const addProfile = page.getByRole("button", { name: "+ 新建 Profile" });
  await addProfile.focus();
  await page.keyboard.press("Enter");
  let dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Initial focus moved INTO the dialog: first focusable = 名称 textbox.
  const nameInput = dialog.getByRole("textbox", { name: "名称", exact: true });
  await expect(nameInput).toBeFocused();

  // Trap: Shift+Tab from the first element wraps to the last (关闭).
  await page.keyboard.press("Shift+Tab");
  const closeButton = dialog.getByRole("button", { name: "关闭", exact: true });
  await expect(closeButton).toBeFocused();
  // Trap: Tab from the last element wraps back to the first.
  await page.keyboard.press("Tab");
  await expect(nameInput).toBeFocused();
  // Tab a few times: focus never leaves the dialog.
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => document.activeElement?.closest("dialog") != null);
    expect(inside, `focus escaped the dialog after ${i + 1} Tabs`).toBe(true);
  }

  // Esc closes and restores focus to the invoking button.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(addProfile).toBeFocused();

  // The Agent create button stays disabled until a Profile exists.
  await createProfile(page, {
    name: "焦点 Profile",
    driverId: "claude-stream-json",
    installationId: "claude-e2e-fake01",
    route: "ant-glm5.2",
  });

  // --- Agent modal (keyboard path) ---
  const addAgent = page.getByRole("button", { name: "+ 新建 Agent" });
  await addAgent.focus();
  await page.keyboard.press("Enter");
  dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "名称", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(addAgent).toBeFocused();
});
