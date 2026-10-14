/**
 * Drive one mapped CouncilKit feature and write proof under
 * artifacts/verify/<sha>/drive/<feature>/.
 *
 * UI drives use Playwright against the isolated origin from launch.sh.
 * cli-init uses `pnpm exec councilkit` with a disposable COUNCILKIT_HOME.
 * This file never clicks 开始审查 and never calls a model.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const feature = process.argv[2];
const root = process.env.VERIFY_ROOT;
const evidence = process.env.VERIFY_EVIDENCE;
const statePath = process.env.VERIFY_STATE;
if (!feature || !root || !evidence) {
  process.stderr.write("usage: drive.mjs <feature-id>\n");
  process.exit(2);
}

const outDir = join(evidence, "drive", feature);
mkdirSync(outDir, { recursive: true });

function writeJson(name, value) {
  writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function runCommand(command, args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({ exitCode: 127, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function ariaDump(page) {
  try {
    return await page.locator("#root").ariaSnapshot();
  } catch (error) {
    return `aria snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function shot(page, name) {
  const path = join(outDir, name);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function withPage(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    return await fn(page);
  } catch (error) {
    await page.screenshot({ path: join(outDir, "failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

async function driveHome(origin) {
  const actions = [];
  await withPage(async (page) => {
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("heading", { name: /让模型互相看见/ }).waitFor({ timeout: 45_000 });
    await page.getByRole("link", { name: "贴 URL 开审查" }).waitFor();
    await page.getByRole("link", { name: "查看审查案件" }).waitFor();
    await page.getByRole("link", { name: "去新建房间" }).waitFor();
    await page.getByRole("link", { name: "检查 Host" }).waitFor();
    const homeShot = await shot(page, "01-home.png");
    actions.push({
      action: "goto",
      url: `${origin}/`,
      result: "heading 让模型互相看见 and the four landing links are visible",
      screenshot: homeShot,
    });
    await page.getByRole("link", { name: "贴 URL 开审查" }).click();
    await page.waitForURL(/\/reports#review/, { timeout: 30_000 });
    const prUrl = page.locator("#review-pr-url");
    await prUrl.waitFor({ timeout: 30_000 });
    await page.getByRole("heading", { name: "发起 PR 审查" }).waitFor();
    await page.getByRole("checkbox", { name: /强制按 spec review/ }).waitFor();
    await page.getByRole("button", { name: "开始审查" }).waitFor();
    const focused = await prUrl.evaluate((element) => element === document.activeElement);
    if (!focused) throw new Error("PR URL textbox is visible but does not have focus");
    const aria = await ariaDump(page);
    writeFileSync(join(outDir, "02-review-composer.aria.txt"), aria);
    const reviewShot = await shot(page, "02-review-composer.png");
    actions.push({
      action: "click",
      role: "link",
      name: "贴 URL 开审查",
      result: "URL /reports#review, heading 发起 PR 审查, #review-pr-url focused, 开始审查 visible and not clicked",
      screenshot: reviewShot,
    });
  });
  writeJson("transcript.json", {
    feature: "home-landing",
    origin,
    ok: true,
    actions,
  });
}

async function driveSettings(origin) {
  const health = await fetch(`${origin}/api/v1/health`);
  const healthBody = await health.json();
  const hostId = healthBody?.data?.hostInstanceId;
  const nodeVersion = healthBody?.data?.node?.version;
  if (!hostId || !nodeVersion) throw new Error("health payload missing hostInstanceId");
  await withPage(async (page) => {
    await page.goto(`${origin}/settings`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("heading", { name: "设置", exact: true }).waitFor({ timeout: 45_000 });
    await page.getByRole("heading", { name: "1. Host" }).waitFor();
    await page.getByText("本地执行服务在线", { exact: true }).waitFor({ timeout: 20_000 });
    await page.getByText(hostId, { exact: false }).waitFor();
    await page.getByText(`Node ${nodeVersion}`, { exact: false }).waitFor();
    const aria = await ariaDump(page);
    writeFileSync(join(outDir, "settings.aria.txt"), aria);
    const path = await shot(page, "settings-host.png");
    writeJson("transcript.json", {
      feature: "host-settings",
      origin,
      ok: true,
      hostInstanceId: hostId,
      node: nodeVersion,
      actions: [
        {
          action: "goto",
          url: `${origin}/settings`,
          result: "heading 设置, heading 1. Host, text 本地执行服务在线, same hostInstanceId as GET /api/v1/health",
          screenshot: path,
        },
      ],
    });
  });
}

async function driveReports(origin) {
  await withPage(async (page) => {
    await page.goto(`${origin}/reports`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("heading", { name: "审查与报告" }).waitFor({ timeout: 45_000 });
    await page.getByRole("heading", { name: "发起 PR 审查" }).waitFor();
    const search = page.getByRole("searchbox", { name: "搜索报告" });
    await search.waitFor();
    await page.getByText("第一份报告，从一个 PR 开始").waitFor({ timeout: 20_000 });
    const emptyShot = await shot(page, "01-empty-library.png");
    await search.fill("verify-no-such-run");
    await page.getByText("第一份报告，从一个 PR 开始").waitFor();
    const queryShot = await shot(page, "02-search-empty-library.png");
    await page.getByRole("button", { name: /全部案件/ }).click();
    const pressed = await page.getByRole("button", { name: /全部案件/ }).getAttribute("aria-pressed");
    if (pressed !== "true") throw new Error("全部案件 filter did not become aria-pressed");
    const aria = await ariaDump(page);
    writeFileSync(join(outDir, "reports.aria.txt"), aria);
    writeJson("transcript.json", {
      feature: "reports-library",
      origin,
      ok: true,
      actions: [
        {
          action: "goto",
          url: `${origin}/reports`,
          result: "heading 审查与报告 and empty copy 第一份报告，从一个 PR 开始",
          screenshot: emptyShot,
        },
        {
          action: "fill",
          role: "searchbox",
          name: "搜索报告",
          value: "verify-no-such-run",
          result: "fresh home still shows the empty library; search did not throw",
          screenshot: queryShot,
        },
        {
          action: "click",
          role: "button",
          name: "全部案件",
          result: "aria-pressed=true",
        },
      ],
    });
  });
}

async function driveNewCouncil(origin) {
  let unmet = null;
  await withPage(async (page) => {
    await page.goto(`${origin}/rooms/new`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("heading", { name: "新建讨论房间" }).waitFor({ timeout: 45_000 });
    await page.getByText("尚未配置 Execution Profile", { exact: true }).waitFor();
    await page.getByRole("button", { name: "前往 Runtime 设置" }).waitFor();
    const topic = page.getByRole("textbox", { name: "话题" });
    const topicCount = await topic.count();
    const gateShot = await shot(page, "01-empty-profiles.png");
    const aria = await ariaDump(page);
    writeFileSync(join(outDir, "new-council.aria.txt"), aria);
    if (topicCount === 0) {
      unmet = {
        subFeature: "new-council-create",
        reason:
          "Fresh verification origin has no Execution Profile in IndexedDB, so the topic form is not rendered.",
      };
    }
    writeJson("transcript.json", {
      feature: "new-council",
      origin,
      ok: unmet === null,
      unmet,
      actions: [
        {
          action: "goto",
          url: `${origin}/rooms/new`,
          result: "heading 新建讨论房间, text 尚未配置 Execution Profile, button 前往 Runtime 设置",
          screenshot: gateShot,
        },
      ],
    });
  });
  if (unmet) {
    process.stderr.write(`${unmet.subFeature}: ${unmet.reason}\n`);
    process.exit(2);
  }
}

function userCouncilkitHome() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "councilkit");
  return join(process.env.HOME ?? "", ".config", "councilkit");
}

function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

async function driveCliInit() {
  const bundle = join(root, "cli/dist/main.mjs");
  try {
    statSync(bundle);
  } catch {
    writeJson("transcript.json", {
      feature: "cli-init",
      ok: false,
      reason: "councilkit CLI is not built. Run pnpm build:cli from the repo root.",
    });
    process.stderr.write("councilkit CLI is not built. Run pnpm build:cli from the repo root.\n");
    process.exit(2);
  }
  const scratch = join(evidence, "drive", "cli-init", "home");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const userHome = userCouncilkitHome();
  const before = mtime(userHome);
  const env = { ...process.env, COUNCILKIT_HOME: scratch };
  const init = await runCommand("pnpm", ["exec", "councilkit", "init", "--json"], env, root);
  writeFileSync(join(outDir, "init.stdout.json"), init.stdout);
  writeFileSync(join(outDir, "init.stderr.txt"), init.stderr);
  const list =
    init.exitCode === 0
      ? await runCommand("pnpm", ["exec", "councilkit", "council", "list", "--json"], env, root)
      : { exitCode: null, stdout: "", stderr: "" };
  if (list.stdout) writeFileSync(join(outDir, "council-list.stdout.json"), list.stdout);
  writeFileSync(join(outDir, "council-list.stderr.txt"), list.stderr);
  const after = mtime(userHome);
  const touchedUserHome = before !== after;
  let parsed = null;
  if (init.exitCode === 0 && init.stdout.trim().length > 0) {
    try {
      parsed = JSON.parse(init.stdout);
    } catch {
      parsed = null;
    }
  }
  const councilNames = [];
  if (parsed?.createdCouncil?.name) councilNames.push(parsed.createdCouncil.name);
  if (parsed?.reusedCouncil?.name) councilNames.push(parsed.reusedCouncil.name);
  let listNames = [];
  if (list.exitCode === 0 && list.stdout.trim().length > 0) {
    try {
      const body = JSON.parse(list.stdout);
      listNames = (body.councils ?? []).map((council) => council.name);
    } catch {
      listNames = [];
    }
  }
  const secret = /api[_-]?key|cookie|csrf|authorization/i.test(init.stdout);
  const ok =
    init.exitCode === 0 &&
    !touchedUserHome &&
    !secret &&
    councilNames.includes("pr-jury") &&
    listNames.includes("pr-jury");
  writeJson("transcript.json", {
    feature: "cli-init",
    ok,
    exitCode: init.exitCode,
    councilListExitCode: list.exitCode,
    councilNames,
    listNames,
    touchedUserHome,
    home: scratch,
    commands: [
      "pnpm exec councilkit init --json",
      "pnpm exec councilkit council list --json",
    ],
  });
  if (!ok) {
    process.stderr.write(
      `cli-init failed exit=${init.exitCode} councils=${councilNames.join(",") || "(none)"} userHomeTouched=${touchedUserHome}\n`,
    );
    if (init.stderr.trim()) process.stderr.write(init.stderr);
    process.exit(init.exitCode === 0 ? 1 : init.exitCode);
  }
}

const state = loadState();
const uiFeatures = new Set(["home-landing", "host-settings", "reports-library", "new-council"]);
try {
  if (feature === "cli-init") {
    await driveCliInit();
  } else if (uiFeatures.has(feature)) {
    if (!state || state.status === "stopped" || !state.origin) {
      throw new Error("no running verification host; run launch.sh and doctor.sh first");
    }
    if (feature === "home-landing") await driveHome(state.origin);
    else if (feature === "host-settings") await driveSettings(state.origin);
    else if (feature === "reports-library") await driveReports(state.origin);
    else await driveNewCouncil(state.origin);
  } else {
    process.stderr.write(
      "unknown feature. expected home-landing, host-settings, reports-library, new-council, or cli-init\n",
    );
    process.exit(2);
  }
} catch (error) {
  writeJson("transcript.json", {
    feature,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
