import { db } from "@/lib/db";
import type { Agent, Gateway, GatewayType } from "@/models";
import { createGateway } from "@/models";

// D-03: 旧 agent.model 标签 → 真实 model id 映射 + 占位 gateway seed 配置。
interface LegacySpec {
  tag: "claude" | "openai" | "deepseek";
  name: string;
  type: GatewayType;
  baseUrl: string;
  defaultModel: string;
}

const LEGACY_SPECS: LegacySpec[] = [
  {
    tag: "claude",
    name: "Claude",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4",
  },
  {
    tag: "openai",
    name: "OpenAI",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
  },
  {
    tag: "deepseek",
    name: "DeepSeek",
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
  },
];

const LEGACY_TAG_SET = new Set<string>(LEGACY_SPECS.map((s) => s.tag));

// Migration only needs these surface methods from Dexie tables.
export interface MigrationDB {
  agents: {
    toArray(): Promise<Agent[]>;
    put(agent: Agent): Promise<string>;
  };
  gateways: {
    toArray(): Promise<Gateway[]>;
    add(gateway: Gateway): Promise<string>;
  };
}

/**
 * 将旧 agent.model ∈ {claude|openai|deepseek} 标签数据迁移到占位 gateway：
 * - 按 tag seed 占位 gateway（名称 Claude/OpenAI/DeepSeek，官方 baseUrl，无 key）
 * - 回填 agent.gatewayId（侧通道写入，P02 会在 Agent interface 正式加字段）
 * - 将 agent.model 改为对应 defaultModel 真实 id 字符串
 * - 幂等：按 gateway name 唯一性复用已存在的占位，不重复 seed
 *
 * 注：签名接受可选 db 参数以便单测注入 mock；生产调用方使用 runStartupMigration()。
 */
export async function migrateLegacyAgentsToGateways(
  dbArg: MigrationDB = db,
): Promise<{ seeded: number; migrated: number }> {
  const agents = await dbArg.agents.toArray();
  if (agents.length === 0) {
    return { seeded: 0, migrated: 0 };
  }

  const existingGateways = await dbArg.gateways.toArray();
  const existingByName = new Map(existingGateways.map((g) => [g.name, g]));

  const presentTags = new Set<string>();
  for (const a of agents) {
    if (typeof a.model === "string" && LEGACY_TAG_SET.has(a.model)) {
      presentTags.add(a.model);
    }
  }
  if (presentTags.size === 0) {
    return { seeded: 0, migrated: 0 };
  }

  // 为出现的每个旧 tag 准备占位 gateway（已存在则复用）。
  const tagToGateway = new Map<string, Gateway>();
  let seeded = 0;
  for (const spec of LEGACY_SPECS) {
    if (!presentTags.has(spec.tag)) continue;
    const existing = existingByName.get(spec.name);
    if (existing) {
      tagToGateway.set(spec.tag, existing);
      continue;
    }
    const gw = createGateway({
      name: spec.name,
      type: spec.type,
      baseUrl: spec.baseUrl,
      defaultModel: spec.defaultModel,
    });
    await dbArg.gateways.add(gw);
    tagToGateway.set(spec.tag, gw);
    seeded += 1;
  }

  // 回填 agent：替换 model 标签为真实 model id，侧通道写入 gatewayId。
  let migrated = 0;
  for (const a of agents) {
    if (typeof a.model !== "string" || !LEGACY_TAG_SET.has(a.model)) continue;
    const spec = LEGACY_SPECS.find((s) => s.tag === a.model);
    const gw = tagToGateway.get(a.model);
    if (!spec || !gw) continue;
    const updated: Agent = {
      ...a,
      model: spec.defaultModel as Agent["model"],
    };
    (updated as Agent & { gatewayId?: string }).gatewayId = gw.id;
    await dbArg.agents.put(updated);
    migrated += 1;
  }

  return { seeded, migrated };
}

/**
 * 启动期 helper：调用真实 db 执行迁移，吞错并 console.warn。
 * P05 接入 main.tsx 时使用。
 */
export async function runStartupMigration(): Promise<void> {
  try {
    await migrateLegacyAgentsToGateways(db);
  } catch (err) {
    console.warn("[councilkit] gateway migration failed:", err);
  }
}
