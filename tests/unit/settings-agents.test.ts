import "fake-indexeddb/auto";

import { pickEnabledAgents } from "@/app/pages/NewRoomPage";
import {
  mergeAgentEdit,
  setAgentEnabled,
  submitAgentEdit,
  updateAgentWithRevisionCheck,
} from "@/app/pages/SettingsPage";
import type { AgentFormValues } from "@/components/settings/AgentFormModal";
import { shouldCommitRealCallResult } from "@/components/settings/AgentsSection";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type { DiscussionAgent } from "@/models/discussion/entities";
import { TransactionError, createDiscussionAgent } from "@/models/discussion/factories";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Settings Agents (S7): mergeAgentEdit pins the S1-registered landmine — the
 * factory always produces enabled:true, so a spread-then-put edit silently
 * reset a disabled Agent to enabled; the merge must preserve enabled (plus
 * id/createdAt, revision+1, factory validation intact). pickEnabledAgents pins
 * the NewRoom enabled filter.
 */

const VALUES: AgentFormValues = {
  name: "新名字",
  personaPrompt: "新的人设",
  executionProfileId: "prof-2",
  modelId: "model-b",
  color: "#b2c3d4",
};

describe("mergeAgentEdit", () => {
  it("S1 雷回归钉：编辑保留 enabled=false", () => {
    const existing = { ...createDiscussionAgent({ ...VALUES, name: "旧名字" }), enabled: false };
    const merged = mergeAgentEdit(existing, VALUES);
    expect(merged.enabled).toBe(false);
  });

  it("enabled=true 同样保留", () => {
    const existing = createDiscussionAgent({ ...VALUES, name: "旧名字" });
    expect(existing.enabled).toBe(true);
    expect(mergeAgentEdit(existing, VALUES).enabled).toBe(true);
  });

  it("revision +1、id/createdAt 保留、表单字段生效", () => {
    const existing = createDiscussionAgent({ ...VALUES, name: "旧名字", color: "#a1b2c3" });
    const merged = mergeAgentEdit(existing, VALUES);
    expect(merged.id).toBe(existing.id);
    expect(merged.revision).toBe(existing.revision + 1);
    expect(merged.createdAt).toBe(existing.createdAt);
    expect(merged).toMatchObject({
      name: VALUES.name,
      personaPrompt: VALUES.personaPrompt,
      executionProfileId: VALUES.executionProfileId,
      modelId: VALUES.modelId,
      color: VALUES.color,
    });
    expect(Number.isNaN(Date.parse(merged.updatedAt))).toBe(false);
  });

  it("工厂校验原样生效：坏 color 抛 INVALID", () => {
    const existing = createDiscussionAgent({ ...VALUES, name: "旧名字" });
    expect(() => mergeAgentEdit(existing, { ...VALUES, color: "red" })).toThrow(TransactionError);
    expect(() => mergeAgentEdit(existing, { ...VALUES, color: "red" })).toThrow(/6-digit hex/);
  });
});

describe("pickEnabledAgents", () => {
  it("过滤 enabled=false，保持原顺序", () => {
    const a = { ...createDiscussionAgent({ ...VALUES, name: "A" }), enabled: true };
    const b = { ...createDiscussionAgent({ ...VALUES, name: "B" }), enabled: false };
    const c = { ...createDiscussionAgent({ ...VALUES, name: "C" }), enabled: true };
    expect(pickEnabledAgents([a, b, c]).map((agent) => agent.name)).toEqual(["A", "C"]);
  });
});

// ---------------------------------------------------------------------------
// G4: 真实调用结果的 commit 守卫按单调 callToken 判断，而非 agent.revision。
// ---------------------------------------------------------------------------

describe("shouldCommitRealCallResult (G4 call-token guard)", () => {
  const record = (revision: number, callToken: number) =>
    ({
      revision,
      callToken,
      result: {
        verdict: "completed",
        canonical: "m",
        effective: "m",
        modelVerdict: "match",
        toolState: "none",
        ttftMs: 10,
        totalMs: 20,
        outputPreview: "ok",
        usage: null,
        error: null,
      },
    }) as never;

  it("G4 钉：编辑 Agent 升 revision 后再调用 → 新结果仍写入（不被 revision 守卫误拒）", () => {
    // 编辑前一次调用：revision=1, callToken=1 已落记录。
    const existing = record(1, 1);
    // 编辑使 agent.revision 升到 2，之后再调用分配 callToken=2。
    expect(shouldCommitRealCallResult(existing, 2)).toBe(true);
  });

  it("首次调用（无既有记录）→ 写入", () => {
    expect(shouldCommitRealCallResult(undefined, 1)).toBe(true);
  });

  it("更早完成者（token 小于既有记录 token）→ 不覆盖晚请求槽位", () => {
    // 晚请求 token=2 先落记录，更早的 token=1 完成 → 不覆盖。
    const existing = record(2, 2);
    expect(shouldCommitRealCallResult(existing, 1)).toBe(false);
  });

  it("同一调用重入（token 相等）→ 仍写入（首创即最新）", () => {
    const existing = record(2, 2);
    expect(shouldCommitRealCallResult(existing, 2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S7 R3: 启停/编辑的丢失更新防护（真实 Dexie on fake-indexeddb）
// ---------------------------------------------------------------------------

describe("S7 R3 并发写防护", () => {
  let db: CouncilKitRuntimeDB;

  beforeEach(() => {
    db = new CouncilKitRuntimeDB(`test-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    await db.delete();
    db.close();
  });

  async function seedAgent(): Promise<DiscussionAgent> {
    const agent = createDiscussionAgent({
      name: "旧名字",
      personaPrompt: "旧人设",
      executionProfileId: "prof-1",
      modelId: "model-a",
      color: "#a1b2c3",
    });
    await db.agents.add(agent);
    return agent;
  }

  it("启停与编辑交错：双方写入都不丢失（无整行回写覆盖）", async () => {
    const agent = { ...(await seedAgent()), enabled: false };
    await db.agents.put(agent);
    const entered = (await db.agents.get(agent.id)) as DiscussionAgent;

    // 编辑（改名）与启停（enabled false→true）并发提交；无论事务谁先谁后，
    // 启停的原子 update 只写 enabled/updatedAt，编辑基于事务内 fresh 行合并，
    // 两个效果都必须落在最终行上。
    await Promise.all([
      updateAgentWithRevisionCheck(db, agent.id, entered.revision, VALUES),
      setAgentEnabled(db, agent.id, true),
    ]);

    const final = await db.agents.get(agent.id);
    expect(final?.name).toBe(VALUES.name);
    expect(final?.enabled).toBe(true);
    expect(final?.revision).toBe(entered.revision + 1);
  });

  it("编辑乐观锁：revision 窗口内变化 → CONCURRENT_MODIFICATION，他方写入不被覆盖", async () => {
    const agent = await seedAgent();
    // 另一页面先完成一次编辑（revision 1→2）。
    await updateAgentWithRevisionCheck(db, agent.id, 1, { ...VALUES, name: "他方的名字" });

    // 本页面仍持有「进入时」revision=1 → 冲突可解释抛出，且不再回写。
    await expect(updateAgentWithRevisionCheck(db, agent.id, 1, VALUES)).rejects.toMatchObject({
      code: "CONCURRENT_MODIFICATION",
    });
    const final = await db.agents.get(agent.id);
    expect(final?.name).toBe("他方的名字");
    expect(final?.revision).toBe(2);
  });

  it("编辑已删除的 Agent → AGENT_NOT_FOUND（与进入时缺失的提示分支分离）", async () => {
    const agent = await seedAgent();
    await db.agents.delete(agent.id);
    await expect(updateAgentWithRevisionCheck(db, agent.id, 1, VALUES)).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("启停对已删除 Agent 返回 false 且不建行", async () => {
    expect(await setAgentEnabled(db, "missing", true)).toBe(false);
    expect(await db.agents.count()).toBe(0);
  });

  it("启停只写 enabled/updatedAt：revision 与其余字段原样", async () => {
    const agent = await seedAgent();
    const before = (await db.agents.get(agent.id)) as DiscussionAgent;

    expect(await setAgentEnabled(db, agent.id, false)).toBe(true);

    const after = (await db.agents.get(agent.id)) as DiscussionAgent;
    expect(after.enabled).toBe(false);
    expect(after.revision).toBe(before.revision);
    expect(after.name).toBe(before.name);
    expect(after.personaPrompt).toBe(before.personaPrompt);
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt));
  });

  it("S7 fix-2 #3 真实提交链：rev1 打开 → 他方保存到 rev2 → 以 rev1 期望值提交 → 冲突且不覆盖", async () => {
    const agent = await seedAgent();
    // 打开编辑框：捕获打开时刻的 revision（AgentsSection editing 状态持有的行）。
    const opened = (await db.agents.get(agent.id)) as DiscussionAgent;
    expect(opened.revision).toBe(1);

    // 编辑框打开期间，另一页面保存成功（rev 1→2）。
    expect(await submitAgentEdit(db, agent.id, 1, { ...VALUES, name: "他方的名字" })).toBeNull();

    // 本页面提交：期望值来自打开时刻的 rev1。修复前在提交时重读会拿到对方
    // 的 rev2 当期望值，乐观锁通过并静默覆盖他方写入。
    const conflict = await submitAgentEdit(db, agent.id, opened.revision, VALUES);
    expect(conflict).toContain("被其他页面修改");
    const final = await db.agents.get(agent.id);
    expect(final?.name).toBe("他方的名字");
    expect(final?.revision).toBe(2);
  });

  it("S7 fix-2 #3 提交链：编辑期间被删除 → 「该 Agent 已不存在。」（与进入时缺失同文案）", async () => {
    const agent = await seedAgent();
    await db.agents.delete(agent.id);
    expect(await submitAgentEdit(db, agent.id, 1, VALUES)).toBe("该 Agent 已不存在。");
  });
});
