import "fake-indexeddb/auto";

import {
  AGENT_EXPORT_FORMAT,
  AGENT_EXPORT_VERSION,
  exportAgents,
  importAgents,
} from "@/lib/agent-io";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type { DiscussionAgent } from "@/models/discussion/entities";
import { createDiscussionAgent } from "@/models/discussion/factories";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
import { CREDENTIAL_MODE } from "@shared/runtime/contracts";
import { executionProfileSchema } from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * agent-io (S7): export shape + secret-free guarantee, atomic whole-file
 * rejection on bad input, unknown-profileId import landing 「待绑定」 (never
 * auto-binding by profileSnapshot content — ruling #5), fresh-id import and
 * the export→import round-trip.
 */

let db: CouncilKitRuntimeDB;

beforeEach(() => {
  db = new CouncilKitRuntimeDB(`test-${crypto.randomUUID()}`);
});

afterEach(async () => {
  await db.delete();
  db.close();
});

function now(): string {
  return new Date().toISOString();
}

function makeProfile(id: string, revision = 1): ExecutionProfileRecord {
  const ts = now();
  return {
    id,
    name: `Profile ${id}`,
    driverId: "codex-app-server",
    installationId: "inst-1",
    credentialMode: CREDENTIAL_MODE,
    options: {},
    revision,
    createdAt: ts,
    updatedAt: ts,
  };
}

function makeAgent(name: string, profileId: string, enabled = true): DiscussionAgent {
  const agent = createDiscussionAgent({
    name,
    personaPrompt: `${name} 的人设，要求直言不讳。`,
    executionProfileId: profileId,
    modelId: "model-a",
    color: "#a1b2c3",
  });
  return { ...agent, enabled };
}

interface FileEntry {
  name: string;
  personaPrompt: string;
  modelId: string;
  color: string;
  enabled?: boolean;
  executionProfileId: string;
  profileSnapshot: unknown;
}

function makeFile(entries: FileEntry[]): string {
  return JSON.stringify({
    format: AGENT_EXPORT_FORMAT,
    version: AGENT_EXPORT_VERSION,
    exportedAt: now(),
    agents: entries,
  });
}

function entryOf(agent: DiscussionAgent, snapshot: unknown = null): FileEntry {
  return {
    name: agent.name,
    personaPrompt: agent.personaPrompt,
    modelId: agent.modelId,
    color: agent.color,
    enabled: agent.enabled,
    executionProfileId: agent.executionProfileId,
    profileSnapshot: snapshot,
  };
}

describe("exportAgents", () => {
  it("导出形状：format/version/exportedAt/agents 齐全，profileSnapshot 过 toDto 契约", async () => {
    const profile = makeProfile("prof-1");
    const agent = makeAgent("A1", profile.id, false);
    const parsed = JSON.parse(exportAgents([agent], [profile]));

    expect(parsed.format).toBe(AGENT_EXPORT_FORMAT);
    expect(parsed.version).toBe(AGENT_EXPORT_VERSION);
    expect(typeof parsed.exportedAt).toBe("string");
    expect(parsed.agents).toHaveLength(1);
    const entry = parsed.agents[0];
    expect(entry).toMatchObject({
      name: agent.name,
      personaPrompt: agent.personaPrompt,
      modelId: agent.modelId,
      color: agent.color,
      enabled: false,
      executionProfileId: profile.id,
    });
    // Strict shape: exactly the documented keys, nothing else (no id/revision).
    expect(Object.keys(entry).sort()).toEqual(
      [
        "color",
        "enabled",
        "executionProfileId",
        "modelId",
        "name",
        "personaPrompt",
        "profileSnapshot",
      ].sort(),
    );
    expect(executionProfileSchema.safeParse(entry.profileSnapshot).success).toBe(true);
  });

  it("secret-free：JSON 全文无 executablePath/argv/env/token/cookie/csrf 字样", () => {
    const profile = makeProfile("prof-1");
    const agent = makeAgent("A1", profile.id);
    const json = exportAgents([agent], [profile]);
    expect(json).not.toMatch(/executablePath|argv|env|token|cookie|csrf/i);
  });
});

describe("importAgents 原子拒绝", () => {
  it("坏 JSON → ok:false", async () => {
    const result = await importAgents(db, "{not json");
    expect(result.ok).toBe(false);
    expect(await db.agents.count()).toBe(0);
  });

  it("错 format / 错 version → ok:false", async () => {
    const agent = makeAgent("A1", "prof-1");
    const bad = (patch: Record<string, unknown>) =>
      JSON.stringify({
        format: AGENT_EXPORT_FORMAT,
        version: AGENT_EXPORT_VERSION,
        exportedAt: now(),
        agents: [entryOf(agent)],
        ...patch,
      });
    expect((await importAgents(db, bad({ format: "other" }))).ok).toBe(false);
    expect((await importAgents(db, bad({ version: 2 }))).ok).toBe(false);
    expect(await db.agents.count()).toBe(0);
  });

  it("缺 personaPrompt / 坏 color → ok:false 且 agents 表零写入（整文件原子）", async () => {
    const agent = makeAgent("A1", "prof-1");
    const missing = entryOf(agent) as Partial<FileEntry>;
    // undefined 经 JSON.stringify 后键被丢弃 → 导入侧看到的就是「缺字段」。
    missing.personaPrompt = undefined;
    expect((await importAgents(db, makeFile([missing as FileEntry]))).ok).toBe(false);

    const badColor = { ...entryOf(agent), color: "red" };
    expect((await importAgents(db, makeFile([badColor]))).ok).toBe(false);

    // One bad entry poisons the whole file: even a valid sibling is rejected.
    const mixed = [entryOf(agent), badColor];
    expect((await importAgents(db, makeFile(mixed))).ok).toBe(false);
    expect(await db.agents.count()).toBe(0);
  });
});

describe("importAgents 成功路径", () => {
  it("未知 profileId → 导入成功 + unbound 清单含该 Agent + executionProfileId 原样保留（待绑定）", async () => {
    const agent = makeAgent("A1", "missing-prof");
    const result = await importAgents(db, makeFile([entryOf(agent)]));
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.imported).toHaveLength(1);
    expect(result.unbound.map((a) => a.id)).toEqual(result.imported.map((a) => a.id));
    const stored = await db.agents.get((result.imported[0] as DiscussionAgent).id);
    expect(stored?.executionProfileId).toBe("missing-prof");
  });

  it("永不按 profileSnapshot 内容自动绑定：snapshot 指向现存 Profile 也保持待绑定", async () => {
    const existing = makeProfile("prof-existing");
    await db.executionProfiles.add(existing);
    // Entry claims an unknown profileId but carries a snapshot describing the
    // EXISTING profile — content-matching auto-bind is rejected semantics.
    const agent = makeAgent("A1", "missing-prof");
    const snapshot = {
      driverId: existing.driverId,
      installationId: existing.installationId,
      credentialMode: existing.credentialMode,
      options: existing.options,
    };
    const result = await importAgents(db, makeFile([entryOf(agent, snapshot)]));
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.unbound).toHaveLength(1);
    const stored = await db.agents.get((result.imported[0] as DiscussionAgent).id);
    expect(stored?.executionProfileId).toBe("missing-prof");
  });

  it("合法导入立即可用：表 +N、revision=1、enabled 默认 true、新 id ≠ 源 id；同文件二次导入再 +N", async () => {
    const profile = makeProfile("prof-1");
    await db.executionProfiles.add(profile);
    const source = makeAgent("A1", profile.id);
    const entry = entryOf(source);
    // pre-S7 files lack the field → default true（undefined 经序列化后键缺失）
    entry.enabled = undefined;
    const file = makeFile([entry, entryOf(makeAgent("A2", profile.id))]);

    const first = await importAgents(db, file);
    if (!first.ok) throw new Error(`expected ok, got ${first.error}`);
    expect(first.imported).toHaveLength(2);
    expect(first.unbound).toHaveLength(0);
    expect(await db.agents.count()).toBe(2);
    for (const imported of first.imported) {
      expect(imported.revision).toBe(1);
      expect(imported.id).not.toBe(source.id);
    }
    const withoutEnabled = first.imported.find((a) => a.name === "A1") as DiscussionAgent;
    expect(withoutEnabled.enabled).toBe(true);

    const second = await importAgents(db, file);
    if (!second.ok) throw new Error(`expected ok, got ${second.error}`);
    expect(await db.agents.count()).toBe(4);
    const allIds = new Set([...first.imported, ...second.imported].map((a) => a.id));
    expect(allIds.size).toBe(4);
  });

  it("round-trip：exportAgents → importAgents 字段全等（id 除外）", async () => {
    const profile = makeProfile("prof-1");
    await db.executionProfiles.add(profile);
    const a1 = makeAgent("A1", profile.id, false);
    const a2 = makeAgent("A2", profile.id);

    const result = await importAgents(db, exportAgents([a1, a2], [profile]));
    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result.imported).toHaveLength(2);
    expect(result.unbound).toHaveLength(0);
    const byName = new Map(result.imported.map((a) => [a.name, a]));
    for (const source of [a1, a2]) {
      const imported = byName.get(source.name) as DiscussionAgent;
      expect(imported).toBeDefined();
      expect(imported.id).not.toBe(source.id);
      expect(imported).toMatchObject({
        personaPrompt: source.personaPrompt,
        executionProfileId: source.executionProfileId,
        modelId: source.modelId,
        color: source.color,
        enabled: source.enabled,
        revision: 1,
      });
    }
  });
});
