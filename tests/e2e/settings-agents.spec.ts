/**
 * S7 Agent 资产化 E2E (plan-a §3): 启停（NewRoom 过滤 + S1 雷 e2e 钉：编辑
 * 保留 enabled=false）、导出导入（secret 扫描 + 未知 Profile 落「待绑定」）、
 * 测试调用（行内 ready pill +「仅验证执行环境」尾注，不烧模型生成）。
 * 断言时序遵循 S5 教训：先等 UI 反映，再验 Dexie 行。串行锁纪律同
 * room-admin.spec.ts。
 */
import { readFileSync } from "node:fs";
import { type BrowserContext, type Locator, type Page, expect, test } from "@playwright/test";
import { createAgent, createProfile, freshPage, readStore } from "./helpers";
import { bootSettings } from "./security-helpers";

const PROFILE = "资产 GLM Profile";
const MODEL = "e2e-claude-model";
const INSTALLATION = "claude-e2e-fake01";
const KIMI_PROFILE = "资产 Kimi Profile";
const KIMI_MODEL = "kimi-code/k3";
const KIMI_INSTALLATION = "kimi-e2e-fake001";

/** AgentsSection 行：卡片含 Agent 名的 <li>（行首 pill 区 + 行尾操作组）。 */
function agentListItem(page: Page, name: string): Locator {
  return page.locator("li", { has: page.getByText(name, { exact: true }) });
}

interface AgentRow {
  id: string;
  name: string;
  enabled: boolean;
}

interface ProfileRow {
  id: string;
  name: string;
}

async function createAssetProfile(page: Page): Promise<void> {
  await createProfile(page, {
    name: PROFILE,
    driverId: "claude-stream-json",
    installationId: INSTALLATION,
    route: "ant-glm5.2",
  });
}

async function createAssetAgent(page: Page, name: string, color: string): Promise<void> {
  await createAgent(page, {
    name,
    persona: `${name}的人格设定。`,
    profileName: PROFILE,
    modelId: MODEL,
    color,
  });
}

let context: BrowserContext;
let page: Page;

test.beforeEach(async ({ browser }) => {
  ({ context, page } = await freshPage(browser));
});

test.afterEach(async () => {
  await context?.close();
});

test.describe("S7 agent assets", () => {
  test("启停：停用后 NewRoom 隐藏、编辑保留停用（S1 雷钉）、启用恢复", async () => {
    test.slow();
    await bootSettings(page);
    await createAssetProfile(page);
    await createAssetAgent(page, "启停甲", "#4f6ef7");
    await createAssetAgent(page, "启停乙", "#f74f6e");
    await createAssetAgent(page, "启停丙", "#4ff76e");

    // 停用甲 → 先等 UI 反映：行内出现「已停用」pill。
    const rowA = agentListItem(page, "启停甲");
    await rowA.getByRole("button", { name: "停用", exact: true }).click();
    await expect(rowA.getByText("已停用")).toBeVisible();

    // NewRoom：甲隐藏，乙/丙仍在（enabled=false 只藏选择器，存量不受影响）。
    await page.goto("/rooms/new");
    await expect(page.getByRole("heading", { name: "新建讨论房间" })).toBeVisible();
    await expect(page.locator("label", { hasText: "启停乙" })).toBeVisible();
    await expect(page.locator("label", { hasText: "启停丙" })).toBeVisible();
    await expect(page.locator("label", { hasText: "启停甲" })).toHaveCount(0);

    // S1 雷 e2e 钉：编辑甲改名后，enabled 不得被工厂产物静默重置回 true。
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    await agentListItem(page, "启停甲").getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const nameInput = dialog.getByRole("textbox", { name: "名称", exact: true });
    // 表单在 open 的 effect 里回填初值，先等回填到位再改（全量负载下防竞态）。
    await expect(nameInput).toHaveValue("启停甲");
    await nameInput.fill("启停甲改");
    await dialog.getByRole("button", { name: "保存修改" }).click();
    await expect(dialog).toBeHidden();
    const renamed = agentListItem(page, "启停甲改");
    await expect(renamed.getByText("已停用")).toBeVisible();
    // 再验 Dexie 行（S5 时序：UI 先行）。
    const agents = await readStore<AgentRow>(page, "agents");
    expect(agents.find((agent) => agent.name === "启停甲改")?.enabled).toBe(false);

    // 重新启用 → pill 消失，NewRoom 恢复可见。
    await renamed.getByRole("button", { name: "启用", exact: true }).click();
    await expect(renamed.getByText("已停用")).toHaveCount(0);
    await page.goto("/rooms/new");
    await expect(page.locator("label", { hasText: "启停甲改" })).toBeVisible();
  });

  test("导出导入：导出形状 + secret 扫描、未知 Profile 导入落「待绑定」", async () => {
    test.slow();
    await bootSettings(page);
    await createAssetProfile(page);
    await createAssetAgent(page, "导出特工", "#4f6ef7");

    // --- 导出：download 事件落盘，断言形状 + secret-free 扫描。 ---
    const exportButton = agentListItem(page, "导出特工").getByRole("button", {
      name: "导出",
      exact: true,
    });
    const [download] = await Promise.all([page.waitForEvent("download"), exportButton.click()]);
    expect(download.suggestedFilename()).toBe("councilkit-agent-导出特工.json");
    const downloadPath = await download.path();
    expect(downloadPath, "download should land on disk").not.toBeNull();
    const exported = readFileSync(downloadPath as string, "utf8");
    const parsed = JSON.parse(exported) as {
      format: string;
      version: number;
      agents: {
        name: string;
        personaPrompt: string;
        modelId: string;
        enabled: boolean;
        executionProfileId: string;
        profileSnapshot: { driverId: string; installationId: string } | null;
      }[];
    };
    expect(parsed.format).toBe("councilkit-agents");
    expect(parsed.version).toBe(1);
    expect(parsed.agents).toHaveLength(1);
    const entry = parsed.agents[0];
    expect(entry?.name).toBe("导出特工");
    expect(entry?.personaPrompt).toBe("导出特工的人格设定。");
    expect(entry?.modelId).toBe(MODEL);
    expect(entry?.enabled).toBe(true);
    expect(entry?.executionProfileId).toBeTruthy();
    expect(entry?.profileSnapshot?.driverId).toBe("claude-stream-json");
    expect(entry?.profileSnapshot?.installationId).toBe(INSTALLATION);
    // secret-free by construction：全文无秘密字段字样。
    expect(exported).not.toMatch(/executablePath|argv|"env"|token|cookie|csrf/i);

    // --- 导入：1 合法（现存 profileId）+ 1 未知 profileId（落待绑定）。 ---
    const profiles = await readStore<ProfileRow>(page, "executionProfiles");
    const profileId = profiles.find((profile) => profile.name === PROFILE)?.id;
    expect(profileId, "existing profile id should be readable").toBeTruthy();
    const importFile = {
      format: "councilkit-agents",
      version: 1,
      exportedAt: new Date().toISOString(),
      agents: [
        {
          name: "导入可用",
          personaPrompt: "导入可用的人格设定。",
          modelId: MODEL,
          color: "#4f6ef7",
          enabled: true,
          executionProfileId: profileId,
          profileSnapshot: null,
        },
        {
          name: "导入待绑",
          personaPrompt: "导入待绑的人格设定。",
          modelId: MODEL,
          color: "#f74f6e",
          enabled: true,
          executionProfileId: "profile-unknown-000000",
          profileSnapshot: null,
        },
      ],
    };
    await page.locator('input[type="file"]').setInputFiles({
      name: "councilkit-agents-import.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(importFile), "utf8"),
    });

    // 先等 UI 反映：导入结果文案 + 两个新行（未知者带「待绑定」pill）。
    await expect(page.getByText(/已导入 2 个 Agent；其中 1 个待绑定 Profile/)).toBeVisible();
    const boundRow = agentListItem(page, "导入可用");
    const unboundRow = agentListItem(page, "导入待绑");
    await expect(boundRow).toBeVisible();
    await expect(unboundRow.getByText("待绑定")).toBeVisible();

    // 合法导入立即可用：NewRoom 可勾选；待绑定者 checkbox 禁用 + 重绑定提示。
    await page.goto("/rooms/new");
    await expect(page.getByRole("heading", { name: "新建讨论房间" })).toBeVisible();
    const boundLabel = page.locator("label", { hasText: "导入可用" });
    await expect(boundLabel).toBeVisible();
    await expect(boundLabel.getByRole("checkbox")).toBeEnabled();
    const unboundLabel = page.locator("label", { hasText: "导入待绑" });
    await expect(unboundLabel).toBeVisible();
    await expect(unboundLabel.getByRole("checkbox")).toBeDisabled();
    await expect(unboundLabel.getByText(/重新绑定/)).toBeVisible();
  });

  test("测试调用：行内 ready pill +「仅验证执行环境」尾注", async () => {
    test.slow();
    await bootSettings(page);
    await createAssetProfile(page);
    await createAssetAgent(page, "测试特工", "#4f6ef7");

    const row = agentListItem(page, "测试特工");
    await row.getByRole("button", { name: "测试", exact: true }).click();
    // 行内结果区：readiness StatusPill + 固定尾注（不触发模型生成）。
    await expect(row.getByText("就绪", { exact: true })).toBeVisible();
    await expect(row.getByText(/仅验证执行环境，未调用模型生成/)).toBeVisible();
  });

  test("Kimi driver：Profile 无可编辑 options，Agent model select 出现 kimi-code/k3，Dexie options 为 {}", async () => {
    test.slow();
    await bootSettings(page);
    // Kimi Profile：driverId=kimi-stream-json，无可编辑 route/reasoning 控件。
    await createProfile(page, {
      name: KIMI_PROFILE,
      driverId: "kimi-stream-json",
      installationId: KIMI_INSTALLATION,
    });
    await expect(page.getByText(KIMI_PROFILE, { exact: true })).toBeVisible();

    // Agent modelId 选择器出现闭集 canonical 模型 kimi-code/k3。
    await createAgent(page, {
      name: "Kimi 特工",
      persona: "Kimi 特工的人格设定。",
      profileName: KIMI_PROFILE,
      modelId: KIMI_MODEL,
      color: "#4ff76e",
    });

    // Dexie 行：Profile options 严格为 {}（不保存 model/route/argv/token）。
    interface ProfileOptionsRow {
      name: string;
      driverId: string;
      options: Record<string, unknown>;
    }
    const profiles = await readStore<ProfileOptionsRow>(page, "executionProfiles");
    const kimiProfile = profiles.find((profile) => profile.name === KIMI_PROFILE);
    expect(kimiProfile, "kimi profile should be persisted").toBeDefined();
    expect(kimiProfile?.driverId).toBe("kimi-stream-json");
    expect(kimiProfile?.options).toEqual({});
  });

  test("S7 fix-3 #2：并发编辑冲突——双页同 context，B 持旧 revision 提交 → 冲突文案 + A 的改名是最终值", async () => {
    test.slow();
    // 同一 browser context 开两个 page（handoff 环境事实的双页模式；独立
    // context 各自带一个 IndexedDB origin 切片，测不出共享态）。两个 page
    // 各自有独立的 TanStack QueryClient，但底层 Dexie 指向同一 IndexedDB。
    await bootSettings(page);
    await createAssetProfile(page);
    await createAssetAgent(page, "并发特工", "#4f6ef7");

    const pageB = await context.newPage();
    await pageB.goto("/settings");
    await expect(pageB.getByRole("heading", { name: "设置" })).toBeVisible();

    // 页面 B 打开该 Agent 的编辑 Modal（不提交）——B 此刻冻结 enteredRevision
    // 为原始 revision（AgentsSection openEdit 持有的行）。
    await agentListItem(pageB, "并发特工")
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    const dialogB = pageB.getByRole("dialog");
    const nameInputB = dialogB.getByRole("textbox", { name: "名称", exact: true });
    await expect(nameInputB).toHaveValue("并发特工");

    // 页面 A 改名并保存成功（revision +1 写入共享 IndexedDB）。
    await agentListItem(page, "并发特工")
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    const dialogA = page.getByRole("dialog");
    const nameInputA = dialogA.getByRole("textbox", { name: "名称", exact: true });
    await expect(nameInputA).toHaveValue("并发特工");
    await nameInputA.fill("并发特工·A改名");
    await dialogA.getByRole("button", { name: "保存修改" }).click();
    await expect(dialogA).toBeHidden();

    // 页面 B 改另一字段（personaPrompt）提交——submitAgentEdit 在事务内重读
    // fresh 行，revision 与 B 冻结的期望值不一致 → 乐观锁失效，返回冲突文案。
    const personaB = dialogB.getByRole("textbox", {
      name: "人格设定（personaPrompt）",
      exact: true,
    });
    await personaB.fill("页面B 试图改写的人格设定。");
    await dialogB.getByRole("button", { name: "保存修改" }).click();

    // B 仍停在打开的 Modal 内看到冲突文案（含「被其他页面修改」）。
    await expect(dialogB.getByText(/被其他页面修改/)).toBeVisible();

    // A 的改名仍是最终值：行内显示 + Dexie 行复核。
    await expect(agentListItem(page, "并发特工·A改名")).toBeVisible();
    const agents = await readStore<{ name: string; personaPrompt: string }>(page, "agents");
    const finalAgent = agents.find((agent) => agent.name === "并发特工·A改名");
    expect(finalAgent, "A 的改名应是最终值").toBeDefined();
    // B 尝试写入的 personaPrompt 未落库（B 的提交被乐观锁整体拒绝，而非合并）。
    expect(finalAgent?.personaPrompt).not.toContain("页面B 试图改写的人格设定");
    await pageB.close();
  });
});
