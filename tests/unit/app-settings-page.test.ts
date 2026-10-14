import "fake-indexeddb/auto";
import "./app-dom-install";

import {
  SettingsPage,
  mergeAgentEdit,
  setAgentEnabled,
  submitAgentEdit,
} from "@/app/pages/SettingsPage";
import type { AgentFormValues } from "@/components/settings/AgentFormModal";
import type { ProfileFormValues } from "@/components/settings/ProfileFormModal";
import { runtimeDb } from "@/lib/runtime-db";
import { createDiscussionAgent } from "@/models/discussion/factories";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
import type { DriverId } from "@shared/runtime/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clickButton } from "./app-dom-install";
import { deferred, mountRouted, settle, waitForText } from "./app-page-harness";

const client = vi.hoisted(() => ({
  health: vi.fn(),
  listInstallations: vi.fn(),
  modelCatalog: vi.fn(),
  profileReadiness: vi.fn(),
  diagnostics: vi.fn(),
  revalidateInstallation: vi.fn(),
  refreshInstallations: vi.fn(),
}));

const scene = vi.hoisted(() => ({
  host: null as null | {
    hostOnline: boolean | null;
    onShowRestartHelp: () => void;
    onExportDiagnostics: () => void;
    exporting: boolean;
  },
  installations: null as null | {
    installations: Array<{ installationId: string; status: string }>;
    drivers: Array<{ driverId: string; status: string }>;
    onRevalidate: (id: string) => void;
    onShowRequirements: () => void;
    onRecheckDrivers: () => void;
    onRediscover: () => void;
    onShowDiagnostics: (driverId: DriverId) => void;
  },
  profiles: null as null | {
    onCreate: (values: ProfileFormValues) => Promise<string | null>;
    onUpdate: (id: string, values: ProfileFormValues) => Promise<string | null>;
    onDelete: (id: string) => Promise<string | null>;
    items: Array<{ profileId: string; checkedAt?: string; retryAfterMs?: number; status: string }>;
  },
  agents: null as null | {
    onCreate: (values: AgentFormValues) => Promise<string | null>;
    onUpdate: (id: string, revision: number, values: AgentFormValues) => Promise<string | null>;
    onDelete: (id: string) => Promise<string | null>;
    onToggleEnabled: (id: string, enabled: boolean) => Promise<string | null>;
    onDuplicate: (id: string) => Promise<string | null>;
    onImport: (file: File) => Promise<string>;
  },
}));

vi.mock("@/runtime/bootstrap", () => ({
  getAppRuntime: () => ({ client, orchestrator: {} }),
}));

vi.mock("@/components/settings/HostSection", async () => {
  const { createElement: h } = await import("react");
  return {
    HostSection: (props: NonNullable<typeof scene.host>) => {
      scene.host = props;
      return h(
        "p",
        null,
        `host:${String(props.hostOnline)}:${props.exporting ? "exporting" : "idle"}`,
      );
    },
  };
});

vi.mock("@/components/settings/InstallationsSection", async () => {
  const { createElement: h } = await import("react");
  return {
    InstallationsSection: (props: NonNullable<typeof scene.installations>) => {
      scene.installations = props;
      return h(
        "p",
        null,
        `installations:${props.installations.map((item) => `${item.installationId}:${item.status}`).join(",")}`,
      );
    },
  };
});

vi.mock("@/components/settings/ProfilesSection", () => ({
  ProfilesSection: (props: NonNullable<typeof scene.profiles>) => {
    scene.profiles = props;
    return null;
  },
}));

vi.mock("@/components/settings/AgentsSection", () => ({
  AgentsSection: (props: NonNullable<typeof scene.agents>) => {
    scene.agents = props;
    return null;
  },
}));

const AGENT_VALUES: AgentFormValues = {
  name: "审查员",
  personaPrompt: "认真审查",
  executionProfileId: "p-claude",
  modelId: "glm-x",
  color: "#112233",
};

function profile(
  partial: Partial<ExecutionProfileRecord> & Pick<ExecutionProfileRecord, "id" | "driverId">,
): ExecutionProfileRecord {
  return {
    name: partial.id,
    installationId: "inst-1",
    credentialMode: "installation-managed",
    options: {},
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function claudeValues(route: ProfileFormValues["route"] = "ant-glm5.2"): ProfileFormValues {
  return {
    name: "Claude 主配置",
    driverId: "claude-stream-json",
    installationId: "inst-1",
    route,
    reasoningEffort: "",
  };
}

async function resetDb(): Promise<void> {
  await runtimeDb.open();
  await runtimeDb.transaction("rw", runtimeDb.tables, async () => {
    await Promise.all(runtimeDb.tables.map((table) => table.clear()));
  });
}

describe("settings agent helpers", () => {
  it("keeps enabled and reports a missing or conflicting edit", async () => {
    const existing = {
      ...createDiscussionAgent({ ...AGENT_VALUES, name: "旧名字" }),
      enabled: false,
    };
    expect(mergeAgentEdit(existing, AGENT_VALUES).enabled).toBe(false);
    expect(mergeAgentEdit(existing, AGENT_VALUES).revision).toBe(existing.revision + 1);
    const db = runtimeDb;
    await resetDb();
    expect(await setAgentEnabled(db, "missing", false)).toBe(false);
    expect(await submitAgentEdit(db, "missing", 1, AGENT_VALUES)).toBe("该 Agent 已不存在。");
    const agent = createDiscussionAgent(AGENT_VALUES);
    await db.agents.add(agent);
    await db.agents.update(agent.id, { revision: agent.revision + 1 });
    expect(await submitAgentEdit(db, agent.id, agent.revision, AGENT_VALUES)).toBe(
      "该 Agent 在编辑期间被其他页面修改，请刷新后重试。",
    );
  });
});

describe("SettingsPage", () => {
  const mounted: Array<{ unmount: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const item of mounted.splice(0)) await item.unmount();
    client.health.mockReset();
    client.listInstallations.mockReset();
    client.modelCatalog.mockReset();
    client.profileReadiness.mockReset();
    client.diagnostics.mockReset();
    client.revalidateInstallation.mockReset();
    client.refreshInstallations.mockReset();
    await resetDb();
  });

  it("blocks recheck until the host is online, then shows the ready banner", async () => {
    const health = deferred<{ drivers: [] }>();
    client.health.mockReturnValue(health.promise);
    const view = await mountRouted("/settings", "/settings", createElement(SettingsPage));
    mounted.push(view);
    expect(view.container.textContent).toContain("host:null:idle");
    const recheck = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "重新检查",
    );
    expect(recheck instanceof HTMLButtonElement && recheck.disabled).toBe(true);

    health.resolve({ drivers: [] });
    client.listInstallations.mockResolvedValue({ installations: [] });
    await waitForText(view.container, "host:true:idle");
    await waitForText(view.container, "全部就绪：可以创建 Agent/Room");
    expect(view.container.querySelector('a[href="/rooms/new"]')?.textContent).toBe(
      "继续下一配置段：新建讨论 →",
    );
    expect(recheck instanceof HTMLButtonElement && recheck.disabled).toBe(false);
  });

  it("scrolls to a hash and opens the three help dialogs", async () => {
    const scrolled: ScrollIntoViewOptions[] = [];
    HTMLElement.prototype.scrollIntoView = (options) => {
      scrolled.push(options as ScrollIntoViewOptions);
    };
    client.health.mockResolvedValue({ drivers: [] });
    client.listInstallations.mockResolvedValue({ installations: [] });
    const view = await mountRouted("/settings#agents", "/settings", createElement(SettingsPage));
    mounted.push(view);
    await waitForText(view.container, "host:true:idle");
    expect(scrolled).toEqual([{ behavior: "smooth" }]);

    scene.installations?.onShowRequirements();
    await waitForText(view.container, "安装/路径要求");
    expect(view.container.textContent).toContain(
      "Runtime Installation 只能由 Host 在本机发现并经校验后信任：",
    );
    await clickButton(view.container, "关闭");
    scene.host?.onShowRestartHelp();
    await waitForText(view.container, "重启本地执行服务");
    expect(view.container.textContent).toContain(
      "开发模式运行 `pnpm dev`；或先 `pnpm build` 后以 `pnpm start` 运行生产模式。",
    );
    await clickButton(view.container, "关闭");
    scene.installations?.onShowDiagnostics("claude-stream-json");
    await waitForText(view.container, "诊断 / 更新 CLI");
    expect(view.container.textContent).toContain(
      "Driver「claude-stream-json」缺少必需的协议能力（incompatible），通常是本机 CLI 版本过旧：",
    );
    await clickButton(view.container, "关闭");
    expect(view.container.querySelector("dialog")).toBeNull();
  });

  it("uses auto scroll when reduced motion is requested and ignores a missing hash", async () => {
    const scrolled: ScrollIntoViewOptions[] = [];
    HTMLElement.prototype.scrollIntoView = (options) => {
      scrolled.push(options as ScrollIntoViewOptions);
    };
    window.matchMedia = (query: string) =>
      ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
      }) as MediaQueryList;
    client.health.mockResolvedValue({ drivers: [] });
    client.listInstallations.mockResolvedValue({ installations: [] });
    const reduced = await mountRouted("/settings#agents", "/settings", createElement(SettingsPage));
    mounted.push(reduced);
    await waitForText(reduced.container, "host:true:idle");
    expect(scrolled).toEqual([{ behavior: "auto" }]);
    await reduced.unmount();
    mounted.splice(0);
    scrolled.length = 0;
    const missing = await mountRouted(
      "/settings#missing",
      "/settings",
      createElement(SettingsPage),
    );
    mounted.push(missing);
    await waitForText(missing.container, "host:true:idle");
    expect(scrolled).toEqual([]);
    await missing.unmount();
    mounted.splice(0);
    const plain = await mountRouted("/settings", "/settings", createElement(SettingsPage));
    mounted.push(plain);
    await waitForText(plain.container, "host:true:idle");
    expect(scrolled).toEqual([]);
  });

  it("rechecks catalogs, exports diagnostics, and rediscovers installations", async () => {
    await runtimeDb.executionProfiles.bulkAdd([
      profile({
        id: "p-claude",
        name: "Claude",
        driverId: "claude-stream-json",
        options: { route: "ant-glm5.2" },
      }),
      profile({
        id: "p-claude-2",
        name: "Claude 2",
        driverId: "claude-stream-json",
        options: { route: "ant-glm5.2" },
      }),
      profile({
        id: "p-codex",
        name: "Codex",
        driverId: "codex-app-server",
        installationId: "inst-2",
        options: {},
      }),
    ]);
    await runtimeDb.agents.add(
      createDiscussionAgent({
        ...AGENT_VALUES,
        executionProfileId: "p-codex",
        modelId: "codex-model",
      }),
    );
    client.health.mockResolvedValue({
      drivers: [{ driverId: "claude-stream-json", capability: "ready" }],
    });
    client.listInstallations.mockResolvedValue({
      installations: [
        {
          installationId: "inst-1",
          driverId: "claude-stream-json",
          state: "trusted",
          detail: null,
        },
      ],
    });
    client.modelCatalog.mockImplementation(async (driverId: string) => {
      if (driverId === "codex-app-server") return { catalog: [" "] };
      return { catalog: ["", "glm-x"] };
    });
    client.profileReadiness.mockImplementation(async (_dto: unknown, modelId: string) => ({
      readiness: { state: modelId === "glm-x" ? "ready" : "model_unavailable", detail: modelId },
      cachedAt: modelId === "glm-x" ? "2026-10-14T00:00:00.000Z" : undefined,
      retryAfterMs: modelId === "codex-model" ? 1500 : undefined,
    }));
    const view = await mountRouted("/settings", "/settings", createElement(SettingsPage));
    mounted.push(view);
    await waitForText(view.container, "installations:inst-1:trusted");
    expect(scene.installations?.drivers).toEqual([
      { driverId: "claude-stream-json", status: "ready", action: null },
    ]);
    await settle();
    await settle();
    expect(client.modelCatalog.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([
      ["claude-stream-json", "inst-1", { route: "ant-glm5.2" }],
      ["codex-app-server", "inst-2", { route: undefined }],
    ]);
    expect(client.profileReadiness.mock.calls.map((call) => call[1])).toEqual([
      "codex-model",
      "codex-model",
      "codex-model",
      "glm-x",
      "glm-x",
    ]);
    const claudeItem = scene.profiles?.items.find((item) => item.profileId === "p-claude");
    expect(claudeItem).toMatchObject({
      status: "ready",
      checkedAt: "2026-10-14T00:00:00.000Z",
    });
    const codexItem = scene.profiles?.items.find((item) => item.profileId === "p-codex");
    expect(codexItem).toMatchObject({ status: "model_unavailable", retryAfterMs: 1500 });

    client.profileReadiness.mockImplementation(async (_dto: unknown, modelId: string) => {
      if (modelId === "codex-model") throw new Error("backoff");
      return {
        readiness: { state: "ready", detail: "fresh" },
        cachedAt: "2026-10-14T01:00:00.000Z",
      };
    });
    client.modelCatalog.mockRejectedValue(new Error("catalog down"));
    await clickButton(view.container, "重新检查");
    await settle();
    await settle();
    expect(view.container.textContent).toContain("重新检查");
    expect(view.client.getQueryData(["host", "profile-readiness", "p-claude", 1, "glm-x"])).toEqual(
      {
        readiness: { state: "ready", detail: "fresh" },
        cachedAt: "2026-10-14T01:00:00.000Z",
      },
    );
    expect(
      view.client.getQueryData([
        "host",
        "model-catalog",
        "claude-stream-json",
        "inst-1",
        "ant-glm5.2",
      ]),
    ).toEqual({ catalog: ["", "glm-x"] });

    const blobs: Blob[] = [];
    const downloads: string[] = [];
    const originalCreate = document.createElement.bind(document);
    document.createElement = ((tag: string, options?: ElementCreationOptions) => {
      const element = originalCreate(tag, options);
      if (tag.toLowerCase() === "a") {
        const anchor = element as HTMLAnchorElement;
        Object.defineProperty(anchor, "click", {
          configurable: true,
          value: () => {
            downloads.push(anchor.download);
          },
        });
      }
      return element;
    }) as typeof document.createElement;
    URL.createObjectURL = ((blob: Blob) => {
      blobs.push(blob);
      return "blob:diagnostics";
    }) as typeof URL.createObjectURL;
    window.URL.createObjectURL = URL.createObjectURL;
    client.diagnostics.mockResolvedValue({ generatedAt: "2026-10-14T01:02:03.456Z", host: "ok" });
    scene.host?.onExportDiagnostics();
    await waitForText(view.container, "host:true:idle");
    await settle();
    expect(downloads).toEqual(["councilkit-diagnostics-2026-10-14T01-02-03-456Z.json"]);
    expect(await blobs[0]?.text()).toBe(
      JSON.stringify({ generatedAt: "2026-10-14T01:02:03.456Z", host: "ok" }, null, 2),
    );

    client.diagnostics.mockRejectedValueOnce(new Error("offline"));
    scene.host?.onExportDiagnostics();
    await settle();
    expect(view.container.textContent).toContain("host:true:idle");
    expect(downloads).toEqual(["councilkit-diagnostics-2026-10-14T01-02-03-456Z.json"]);

    client.revalidateInstallation.mockResolvedValue({ ok: true });
    scene.installations?.onRevalidate("inst-1");
    await settle();
    expect(client.revalidateInstallation.mock.calls).toEqual([["inst-1"]]);
    client.refreshInstallations.mockResolvedValue({ installations: [] });
    scene.installations?.onRediscover();
    await settle();
    expect(client.refreshInstallations.mock.calls).toEqual([[]]);
    scene.installations?.onRecheckDrivers();
    await settle();
    expect(client.health.mock.calls.length).toBe(2);
    document.createElement = originalCreate;
  });

  it("creates, updates, and deletes profiles for each driver option shape", async () => {
    client.health.mockResolvedValue({ drivers: [] });
    client.listInstallations.mockResolvedValue({ installations: [] });
    const view = await mountRouted("/settings", "/settings", createElement(SettingsPage));
    mounted.push(view);
    await waitForText(view.container, "host:true:idle");
    expect(
      await scene.profiles?.onCreate({
        ...claudeValues(),
        route: "nope" as ProfileFormValues["route"],
      }),
    ).toBe("Profile 校验失败：字段不符合 Driver 的类型化选项要求。");
    expect(await scene.profiles?.onCreate(claudeValues("moonshot"))).toBe(null);
    expect(
      await scene.profiles?.onCreate({
        name: "Codex 高",
        driverId: "codex-app-server",
        installationId: "inst-2",
        route: "ant-glm5.2",
        reasoningEffort: " high ",
      }),
    ).toBe(null);
    expect(
      await scene.profiles?.onCreate({
        name: "Codex 空",
        driverId: "codex-app-server",
        installationId: "inst-2",
        route: "ant-glm5.2",
        reasoningEffort: "   ",
      }),
    ).toBe(null);
    expect(
      await scene.profiles?.onCreate({
        name: "Kimi",
        driverId: "kimi-stream-json",
        installationId: "inst-3",
        route: "ant-glm5.2",
        reasoningEffort: "",
      }),
    ).toBe(null);
    const rows = await runtimeDb.executionProfiles.toArray();
    expect(
      rows
        .map((row) => [row.name, row.options] as const)
        .sort((left, right) => left[0].localeCompare(right[0])),
    ).toEqual([
      ["Claude 主配置", { route: "moonshot" }],
      ["Codex 空", {}],
      ["Codex 高", { reasoningEffort: "high" }],
      ["Kimi", {}],
    ]);
    const claude = rows.find((row) => row.name === "Claude 主配置");
    expect(claude?.revision).toBe(1);
    expect(await scene.profiles?.onUpdate("missing", claudeValues())).toBe("该 Profile 已不存在。");
    expect(
      await scene.profiles?.onUpdate(claude?.id ?? "", {
        ...claudeValues(),
        route: "bad" as ProfileFormValues["route"],
      }),
    ).toBe("Profile 校验失败：字段不符合 Driver 的类型化选项要求。");
    expect(
      await scene.profiles?.onUpdate(claude?.id ?? "", {
        ...claudeValues("deepseek"),
        name: "Claude 新",
      }),
    ).toBe(null);
    expect((await runtimeDb.executionProfiles.get(claude?.id ?? ""))?.revision).toBe(2);
    expect((await runtimeDb.executionProfiles.get(claude?.id ?? ""))?.options).toEqual({
      route: "deepseek",
    });
    const kimi = rows.find((row) => row.name === "Kimi");
    await runtimeDb.agents.add(
      createDiscussionAgent({ ...AGENT_VALUES, executionProfileId: kimi?.id ?? "" }),
    );
    expect(await scene.profiles?.onDelete(kimi?.id ?? "")).toBe(
      "有 1 个 Agent 正在引用该 Profile。请先在下方「4. Agents」段修改这些 Agent 的绑定或删除它们。",
    );
    expect(await scene.profiles?.onDelete(claude?.id ?? "")).toBe(null);
    expect(await runtimeDb.executionProfiles.get(claude?.id ?? "")).toBeUndefined();
  });

  it("creates, edits, toggles, duplicates, imports, and deletes agents", async () => {
    client.health.mockResolvedValue({ drivers: [] });
    client.listInstallations.mockResolvedValue({ installations: [] });
    const view = await mountRouted("/settings", "/settings", createElement(SettingsPage));
    mounted.push(view);
    await waitForText(view.container, "host:true:idle");
    expect(await scene.agents?.onCreate({ ...AGENT_VALUES, color: "red" })).toBe(
      "color must be a 6-digit hex",
    );
    expect(await scene.agents?.onCreate(AGENT_VALUES)).toBe(null);
    const created = await runtimeDb.agents.toArray();
    expect(created.map((agent) => agent.name)).toEqual(["审查员"]);
    const agent = created[0];
    expect(agent?.enabled).toBe(true);
    expect(await scene.agents?.onUpdate("missing", 1, AGENT_VALUES)).toBe("该 Agent 已不存在。");
    expect(
      await scene.agents?.onUpdate(agent?.id ?? "", 99, { ...AGENT_VALUES, name: "并发" }),
    ).toBe("该 Agent 在编辑期间被其他页面修改，请刷新后重试。");
    expect(
      await scene.agents?.onUpdate(agent?.id ?? "", agent?.revision ?? 0, {
        ...AGENT_VALUES,
        name: "新审查员",
      }),
    ).toBe(null);
    expect((await runtimeDb.agents.get(agent?.id ?? ""))?.name).toBe("新审查员");
    expect((await runtimeDb.agents.get(agent?.id ?? ""))?.revision).toBe(
      (agent?.revision ?? 0) + 1,
    );
    expect(await scene.agents?.onToggleEnabled("missing", false)).toBe("该 Agent 已不存在。");
    expect(await scene.agents?.onToggleEnabled(agent?.id ?? "", false)).toBe(null);
    expect((await runtimeDb.agents.get(agent?.id ?? ""))?.enabled).toBe(false);
    expect(await scene.agents?.onDuplicate("missing")).toBe("该 Agent 已不存在。");
    expect(await scene.agents?.onDuplicate(agent?.id ?? "")).toBe(null);
    expect((await runtimeDb.agents.toArray()).map((row) => row.name).sort()).toEqual([
      "新审查员",
      "新审查员（副本）",
    ]);

    const unread = { text: async () => Promise.reject(new Error("disk")) } as unknown as File;
    expect(await scene.agents?.onImport(unread)).toBe("导入失败：无法读取文件。");
    expect(await scene.agents?.onImport(new File(["{"], "bad.json"))).toBe(
      "导入失败：文件不是合法 JSON。",
    );
    expect(await scene.agents?.onImport(new File(["{}"], "bad.json"))).toBe(
      "导入失败：文件格式不符合 councilkit-agents v1 导出格式。",
    );
    const file = new File(
      [
        JSON.stringify({
          format: "councilkit-agents",
          version: 1,
          exportedAt: "2026-10-14T00:00:00.000Z",
          agents: [
            {
              name: "外来",
              personaPrompt: "外来人设",
              modelId: "glm-x",
              color: "#445566",
              enabled: true,
              executionProfileId: "missing-profile",
              profileSnapshot: null,
            },
          ],
        }),
      ],
      "agents.json",
      { type: "application/json" },
    );
    expect(await scene.agents?.onImport(file)).toBe(
      "已导入 1 个 Agent；其中 1 个待绑定 Profile（编辑重新绑定后可用）：外来。",
    );

    await runtimeDb.participants.add({
      id: "part-1",
      roomId: "room-1",
      agentId: agent?.id ?? "",
      state: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);
    expect(await scene.agents?.onDelete(agent?.id ?? "")).toBe(
      "该 Agent 已作为 Participant 加入 1 个房间参与关系；删除会破坏既有讨论记录。如不再使用，请编辑为新配置（已加入房间的 Participant 会保留加入时快照）。",
    );
    const copy = (await runtimeDb.agents.toArray()).find((row) => row.name === "新审查员（副本）");
    expect(await scene.agents?.onDelete(copy?.id ?? "")).toBe(null);
    expect(await runtimeDb.agents.get(copy?.id ?? "")).toBeUndefined();
  });

  it("falls back from a blank catalog to an agent model, then the first agent, then unknown", async () => {
    await runtimeDb.executionProfiles.add(
      profile({ id: "p-kimi", driverId: "kimi-stream-json", installationId: "inst-k" }),
    );
    await runtimeDb.agents.bulkAdd([
      createDiscussionAgent({
        ...AGENT_VALUES,
        name: "甲",
        executionProfileId: "other",
        modelId: "first-model",
      }),
      createDiscussionAgent({
        ...AGENT_VALUES,
        name: "乙",
        executionProfileId: "p-kimi",
        modelId: "kimi-model",
      }),
    ]);
    client.health.mockResolvedValue({ drivers: [] });
    client.listInstallations.mockResolvedValue({ installations: [] });
    client.modelCatalog.mockResolvedValue({ catalog: [] });
    client.profileReadiness.mockResolvedValue({ readiness: { state: "ready", detail: null } });
    const matched = await mountRouted("/settings", "/settings", createElement(SettingsPage));
    mounted.push(matched);
    await waitForText(matched.container, "host:true:idle");
    await settle();
    expect(client.profileReadiness.mock.calls.map((call) => call[1])).toEqual(["kimi-model"]);
    await matched.unmount();
    mounted.splice(0);
    await resetDb();
    client.profileReadiness.mockClear();

    await runtimeDb.executionProfiles.add(
      profile({ id: "p-grok", driverId: "grok-stream-json", installationId: "inst-g" }),
    );
    await runtimeDb.agents.add(
      createDiscussionAgent({
        ...AGENT_VALUES,
        executionProfileId: "other",
        modelId: "first-model",
      }),
    );
    const first = await mountRouted("/settings", "/settings", createElement(SettingsPage));
    mounted.push(first);
    await waitForText(first.container, "host:true:idle");
    await settle();
    expect(client.profileReadiness.mock.calls.map((call) => call[1])).toEqual(["first-model"]);
    await first.unmount();
    mounted.splice(0);
    await resetDb();
    client.profileReadiness.mockClear();

    await runtimeDb.executionProfiles.add(
      profile({ id: "p-cursor", driverId: "cursor-stream-json", installationId: "inst-c" }),
    );
    const unknown = await mountRouted("/settings", "/settings", createElement(SettingsPage));
    mounted.push(unknown);
    await waitForText(unknown.container, "host:true:idle");
    await settle();
    expect(client.profileReadiness.mock.calls.map((call) => call[1])).toEqual(["__unknown__"]);
  });
});
