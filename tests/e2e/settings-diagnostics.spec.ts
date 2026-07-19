/**
 * Settings diagnostics export (S6): the Host section's 导出诊断包 button is
 * reachable, and clicking it downloads a single JSON bundle with the full
 * top-level shape. Runs against the E2E Host (host-entry.mts), which
 * registers the real diagnostics route with scripted fake drivers.
 */
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { bootSettings } from "./security-helpers";

test("Settings Host 段显示「导出诊断包」按钮且可用", async ({ page }) => {
  await bootSettings(page);
  await expect(page.getByText("本地执行服务在线")).toBeVisible();
  const button = page.getByRole("button", { name: "导出诊断包" });
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
});

test("点击触发诊断 JSON 下载且顶层键齐全", async ({ page }) => {
  await bootSettings(page);
  await expect(page.getByText("本地执行服务在线")).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出诊断包" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^councilkit-diagnostics-.+\.json$/);
  const path = await download.path();
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  for (const key of ["generatedAt", "health", "config", "installations", "scopes", "logs"]) {
    expect(parsed, `missing top-level key "${key}"`).toHaveProperty(key);
  }
});
