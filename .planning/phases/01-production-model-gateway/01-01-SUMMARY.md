---
phase: 01-production-model-gateway
plan: 01
plan_id: 01-01
subsystem: model-gateway-data-layer
tags: [gateway, dexie, crypto, migration, data-model]
requires:
  - "src/models/agent.ts (legacy model tag source for migration)"
  - "src/lib/crypto.ts (existing AES + passphrase)"
  - "src/lib/db.ts (Dexie v1 schema)"
provides:
  - "Gateway interface + createGateway + validateGateway (src/models/gateway.ts)"
  - "Dexie v2 schema with gateways table + 5 helpers (src/lib/db.ts)"
  - "per-gatewayId AES crypto: save/load/clearGatewayApiKey + gatewayKeyStorageId (src/lib/crypto.ts)"
  - "migrateLegacyAgentsToGateways + runStartupMigration (src/lib/gateway-migrate.ts)"
affects:
  - "src/models/index.ts (re-exports)"
tech_stack:
  added: []
  patterns:
    - "gateway 元数据 Dexie 表 + apiKey 仅 localStorage AES cipher（D-07 边界）"
    - "v2 schema 保留 v1 stores 字段以兼容已存在数据库"
    - "迁移函数接受可选 db 参数支持单测注入 mock（生产走 runStartupMigration 用真实 db）"
key_files:
  created:
    - src/models/gateway.ts
    - src/lib/gateway-migrate.ts
    - tests/unit/gateway-crypto-migrate.test.ts
  modified:
    - src/models/index.ts
    - src/lib/db.ts
    - src/lib/crypto.ts
decisions:
  - "migrateLegacyAgentsToGateways 接受可选 db 参数（deviation from plan no-arg signature）以支持单测注入 mock，生产 runStartupMigration 走真实 db"
  - "loadGatewayApiKey 对 corrupt cipher 返回空字符串的情况视为 null（真实 API key 非空）"
  - "迁移侧通道写入 agent.gatewayId via cast；P02 会在 Agent interface 正式加字段后无需 cast"
metrics:
  duration: "5 min"
  completed: "2026-06-25T15:37:01Z"
  tasks: 3
  files: 6
status: complete
---

# Phase 1 Plan 1: Production Model Gateway — Data Foundation Summary

落地生产模型网关的数据基座：通用 gateway 数据模型 (D-01)、Dexie `gateways` v2 表、固定 passphrase 多 key AES 加密 (D-06/D-07)、以及旧 `agent.model` 标签到占位 gateway 的启动迁移 (D-03)。后续 plan（agent 字段改造、adapter 分派、settings 页）依赖此 gateway 实体。

## What Was Built

### Task 1 — Gateway model + Dexie v2 gateways 表 + helpers
- `src/models/gateway.ts`: `GatewayType = 'anthropic' | 'openai-compatible'`、`Gateway` interface、`validateGateway`（name 非空且 ≤50、type ∈ 集合、baseUrl `^https?://`、defaultModel 非空）、`createGateway`（crypto.randomUUID + Date.now + assertValid）。
- `src/models/index.ts`: re-export `Gateway`/`GatewayType`/`createGateway`/`validateGateway`。
- `src/lib/db.ts`: `CouncilKitDB` 增加 `gateways!: Table<Gateway, string>`；新增 `this.version(2).stores({...})` 含 `gateways: 'id, type'`，**保留 v1 全部 stores 字段**以兼容已存在 IndexedDB。新增 helpers `addGateway`/`getGateway`/`listGateways`（按 createdAt 升序）/`updateGateway`/`deleteGateway`。

### Task 2 — 多 key crypto（per-gatewayId AES，D-06/D-07）
- `src/lib/crypto.ts` 新增 `gatewayKeyStorageId(gatewayId)` → `councilkit.gateways.{id}.enc`；`saveGatewayApiKey`/`loadGatewayApiKey`/`clearGatewayApiKey`。沿用固定 passphrase `councilkit-local-v1`，不引入 master passphrase。
- 保留旧 `saveApiKey`/`loadApiKey`/`clearApiKey`/`encryptApiKey`/`decryptApiKey` 供迁移期读取 `councilkit.key.enc`。
- `loadGatewayApiKey` 对 corrupt cipher 解出空字符串的情况返回 `null`（真实 API key 非空）。

### Task 3 — 启动迁移 migrateLegacyAgentsToGateways（D-03）
- `src/lib/gateway-migrate.ts`: `migrateLegacyAgentsToGateways(dbArg = db)` — 扫描 `agent.model ∈ {claude,openai,deepseek}` 标签集合；仅对出现的 tag seed 占位 gateway（Claude/OpenAI/DeepSeek，type anthropic/openai-compatible，官方 baseUrl，**无 key**）；按 gateway name 幂等复用；回填 agent.model 为真实 model id（claude→`claude-sonnet-4`、openai→`gpt-4o`、deepseek→`deepseek-chat`）并侧通道写入 `agent.gatewayId`；返回 `{seeded, migrated}`。
- `runStartupMigration()`: 调用真实 db，吞错并 `console.warn`，供 P05 接入 main.tsx。

### Tests — `tests/unit/gateway-crypto-migrate.test.ts`（28 tests）
- createGateway/validateGateway: 8 行为断言（含 http(s) 校验、type 集合、name 长度）。
- CouncilKitDB v2 schema: gateways 表存在 + id/type 索引。
- 多 key crypto: 写入非明文 cipher、load 还原、缺失/corrupt 返回 null、clear、跨 gatewayId 隔离、旧 API 兼容（含 localStorage Map shim）。
- 迁移: claude+deepseek seed + 回填、openai seed、无 key 入 localStorage、幂等、real-model-id 不触碰、空 db、混合 agent 仅迁移 legacy。

## Verification Results

| Command | Result |
|---------|--------|
| `./node_modules/.bin/vitest run` | PASS — 53 tests (2 files: models.test.ts 25 + gateway-crypto-migrate.test.ts 28) |
| `./node_modules/.bin/tsc --noEmit` | PASS — 0 errors |
| `./node_modules/.bin/biome check src tests` | PASS — clean (after auto-fix: import sort + formatter + delete→undefined) |

注：vitest 在 node env 跑（无原生 localStorage/IndexedDB）。测试用 Map-backed LocalStorageShim 覆盖 crypto 路径；迁移测试用 in-memory mock db 注入（未引入 fake-indexeddb 等新依赖，符合 plan 威胁模型 T-01-SC「无包安装」）。Dexie schema 测试通过构造期暴露的 `db.gateways.schema` 检查（不打开真实 IndexedDB）。

## TDD Gate Compliance

Plan frontmatter `type: execute`（非 `type: tdd` plan-level），但每 task 标记 `tdd="true"`。每 task 按 RED→GREEN 分别提交：

| Task | RED commit | GREEN commit |
|------|------------|--------------|
| 1 | 4a8dfc9 (test) | cdefdc3 (feat) |
| 2 | 019d02b (test) | 2279da5 (feat) |
| 3 | cb610a4 (test) | feaf83a (feat) |

RED 提交仅含测试文件（实现未提交），在该 commit 上测试 fail；GREEN 提交实现后测试全绿。gate 合规。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Testability] `migrateLegacyAgentsToGateways` 接受可选 db 参数**
- **Found during:** Task 3 RED
- **Issue:** Plan 签名为 `migrateLegacyAgentsToGateways(): Promise<...>`，无参使用模块级 `db`。vitest node env 无 IndexedDB，无法对真实 Dexie 跑迁移单测；同文件又需真实 db 跑 v2 schema 测试，故不能整体 `vi.mock("@/lib/db")`。
- **Fix:** 签名改为 `migrateLegacyAgentsToGateways(dbArg: MigrationDB = db)`，导出 `MigrationDB` interface（仅含迁移用到的 4 个方法）。生产调用方 `runStartupMigration()` 仍无参使用真实 db，plan 意图保留。
- **Files modified:** src/lib/gateway-migrate.ts
- **Commit:** feaf83a

**2. [Rule 1 — Bug] `loadGatewayApiKey` corrupt cipher 返回空字符串而非 null**
- **Found during:** Task 2 GREEN
- **Issue:** CryptoJS.AES.decrypt 对非合法 cipher 不抛错而是返回空 bytes，`bytes.toString(Utf8)` 为 `""`，导致 `loadGatewayApiKey` 返回 `""` 而非 `null`。
- **Fix:** 解密结果为空字符串时返回 `null`（真实 API key 非空，空等同缺失）。
- **Files modified:** src/lib/crypto.ts
- **Commit:** 2279da5

## Threat Flags

无新增安全面超出 plan `<threat_model>`。T-01-02（迁移篡改）已由幂等 + real-model-id no-op + 单测覆盖 mitigate；T-01-01（localStorage cipher）仍 accept（plan 已论证）；T-01-SC（无新依赖）遵守——未引入 fake-indexeddb，改用 mock 注入。

## Known Stubs

无。本 plan 是数据基座，不渲染 UI；所有 gateway/crypto/migration 路径均由真实实现 + 单测覆盖，无 placeholder 数据流向 UI。

## Self-Check: PASSED

- src/models/gateway.ts — FOUND
- src/lib/gateway-migrate.ts — FOUND
- tests/unit/gateway-crypto-migrate.test.ts — FOUND
- src/models/index.ts — FOUND (modified)
- src/lib/db.ts — FOUND (modified)
- src/lib/crypto.ts — FOUND (modified)
- Commits: 4a8dfc9, cdefdc3, 019d02b, 2279da5, cb610a4, feaf83a — all FOUND in `git log --oneline`
