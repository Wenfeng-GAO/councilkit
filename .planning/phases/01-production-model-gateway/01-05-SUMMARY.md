---
phase: 01-production-model-gateway
plan: 05
subsystem: infra
tags: [gateway, migration-wiring, dev-proxy-cleanup, cors, human-verify]

requires:
  - phase: 01-production-model-gateway/01-01
    provides: runStartupMigration (src/lib/gateway-migrate.ts)
  - phase: 01-production-model-gateway/01-02
    provides: anthropicAdapter with anthropic-dangerous-direct-browser-access header; collectText marked @deprecated
  - phase: 01-production-model-gateway/01-03
    provides: /settings page + gateway CRUD + test connection
  - phase: 01-production-model-gateway/01-04
    provides: 5-class GatewayError + runRound orchestration + ErrorBanner/MessageBubble
provides:
  - "main.tsx 接入 runStartupMigration (D-03 闭环)"
  - "dev proxy / model-proxy.mjs / .env.example / README 路径声明清理（SC#3 文档/源码侧）"
  - "collectText 孤儿函数删除（P02 @deprecated 清理）"
  - "Task 2 待人类实跑验证的证据槽位（D-13 + SC#1/#2/#3/#4）"
affects: [02-verification-gate-closure, Phase 2 VERIFY-03]

tech-stack:
  added: []
  patterns:
    - "fire-and-forget startup migration at app entry (no await, swallow + console.warn)"

key-files:
  created: []
  modified:
    - src/main.tsx
    - vite.config.ts
    - scripts/model-proxy.mjs
    - README.md
    - src/lib/stream.ts

key-decisions:
  - "runStartupMigration fire-and-forget：不 await，不阻塞首屏；runStartupMigration 内部 try/catch + console.warn 兜底（T-05-03 mitigation）。"
  - "vite.config.ts server.proxy 与 model-proxy.mjs 保留但显式标注 dev-only（不删，避免破坏 dev mock 验证）；production build 不含此路径（vite build 仅产 pure client bundle，SC#3 干净检出已 grep 验证）。"
  - "collectText 删除：dispatchMessage 自行 for-await 累加，无下游引用（rg src/ 零命中 + dist/ 零命中已验证）。"

patterns-established:
  - "App-entry migration wiring: 调用在 createRoot().render() 之前同步发起，不 await；首屏渲染不被 DB 迁移阻塞。"

requirements-completed: []  # GW-01 留待 Task 2 human-verify 通过后再 mark-complete；当前 plan 不算完成。

coverage:
  - id: D1
    description: "main.tsx 接入 runStartupMigration (D-03 闭环)"
    requirement: GW-01
    verification:
      - kind: unit
        ref: "rg -c 'runStartupMigration' src/main.tsx → 3 matches (import + call + comment)"
        status: pass
      - kind: other
        ref: "./node_modules/.bin/tsc --noEmit → 0 errors"
        status: pass
    human_judgment: false
  - id: D2
    description: "collectText 孤儿函数从 src/lib/stream.ts 删除"
    requirement: GW-01
    verification:
      - kind: other
        ref: "rg 'collectText' src/ → 0 matches; rg 'collectText' dist/ → 0 matches"
        status: pass
      - kind: unit
        ref: "tests/unit/round-errors.test.ts (12 tests) pass — dispatchMessage self-aggregate unaffected"
        status: pass
    human_judgment: false
  - id: D3
    description: "dev proxy / model-proxy.mjs / README 路径声明清理（SC#3 文档/源码侧）"
    requirement: GW-01
    verification:
      - kind: other
        ref: "vite.config.ts server.proxy 注释含 'Phase 1: 此 dev proxy 仅 dev 模式语法保留'"
        status: pass
      - kind: other
        ref: "scripts/model-proxy.mjs 头注释含 'Phase 1 Production Gateway, 2026-06-25: 生产路径不再依赖此 proxy'"
        status: pass
      - kind: other
        ref: "README.md 新增 'Production Setup (Phase 1)' 段含 4 步"
        status: pass
      - kind: other
        ref: "src/ 与 dist/ 均无 /api/claude 调用路径（rg 验证）"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-13 Anthropic CORS 浏览器直连实跑验证（anthropic-dangerous-direct-browser-access:true 头）"
    requirement: GW-01
    verification: []
    human_judgment: true
    rationale: "需要用户在 /settings 配真实 Anthropic API key，浏览器 DevTools Network 实际抓包验证 POST https://api.anthropic.com/v1/messages 返回 200 + 请求头含 anthropic-dangerous-direct-browser-access:true + 无 CORS 错误。执行器无有效 key 且沙箱不允许真实出网到第三方 endpoint，无法自动化。"
  - id: D5
    description: "SC#1 用户在 /settings 自持 key + 浏览器直达 endpoint"
    requirement: GW-01
    verification: []
    human_judgment: true
    rationale: "需真实 Anthropic + OpenAI/DeepSeek key 在 /settings 配置 + 测试连接实跑。"
  - id: D6
    description: "SC#2 完整 E2E 真实讨论流（建 room + 加 agent + run round + auto-summary + 追问第二轮）"
    requirement: GW-01
    verification: []
    human_judgment: true
    rationale: "端到端用户交互流，需真实模型流式输出，无法在无 key 沙箱中自动化。"
  - id: D7
    description: "SC#3 干净检出：无 model-proxy.mjs 进程 + Network 无 /api/claude + E2E 仍跑通"
    requirement: GW-01
    verification:
      - kind: other
        ref: "rg '/api/claude' src/ → 0; rg '/api/claude' dist/ → 0（已自动化验证源码与 build 产物侧）"
        status: pass
    human_judgment: true
    rationale: "源码/build 产物侧已自动化验证；运行时侧（8788 端口无进程 + 真实 E2E 跑通）需用户在实跑时确认。"
  - id: D8
    description: "SC#4 5 类 gateway 错误呈现 + 致命扩散 + 全离线跳总结"
    requirement: GW-01
    verification:
      - kind: unit
        ref: "tests/unit/round-errors.test.ts (12 tests pass) — 致命扩散/全离线跳总结逻辑已自动化测"
        status: pass
    human_judgment: true
    rationale: "自动化覆盖逻辑分支；用户可见文案（与 UI-SPEC copywriting 字面一致）+ 真实 invalid key 触发 401/403 需用户实跑对照。"

duration: 12min
completed: 2026-06-26
status: checkpoint-pending
---

# Phase 1 Plan 05: Production Gateway 收官接入 + 实跑验证 Summary

**Task 1 自动化部分（main.tsx 启动迁移接入 + dev proxy 路径清理 + collectText 孤儿删除 + README 生产说明）已落地全绿；Task 2 真实浏览器 + 真实 API key 实跑证据（D-13 Anthropic CORS + 4 条 ROADMAP SC）待人类验证。**

## Performance

- **Duration:** ~12 min（自动化部分；Task 2 实跑时间不计）
- **Started:** 2026-06-26
- **Completed:** 2026-06-26（自动化部分；Task 2 pending）
- **Tasks:** 1/2 完成（Task 2 checkpoint-pending）
- **Files modified:** 5

## Accomplishments

- **D-03 闭环**：`src/main.tsx` 在 `createRoot(...).render(...)` 之前同步调 `runStartupMigration()`（fire-and-forget，不 await；内部 try/catch + console.warn 兜底）。P01 产出的占位 gateway 迁移真正接入应用入口。
- **SC#3 源码/build 产物侧干净检出**：
  - `vite.config.ts` `server.proxy['/api/claude']` 块上方注释改为 Phase 1 dev-only 标注；proxy 字段保留（不破坏 dev mock），production build 不含此路径。
  - `scripts/model-proxy.mjs` 头注释追加 Phase 1 生产不依赖说明（保留脚本，不删）。
  - `README.md` 新增 `## Production Setup (Phase 1)` 段，4 步生产配置说明 + https 推荐指引；移除 Getting Started 中过时的 `cp .env.example .env.local` 步骤。
  - `rg '/api/claude' src/` 与 `rg '/api/claude' dist/` 均零命中（production path 无 /api/claude 调用）。
  - `rg 'VITE_(CLAUDE|OPENAI|DEEPSEEK)_API_KEY' src/` 零命中（src 无 env-var key 读取路径）。
- **collectText 孤儿函数删除**：`src/lib/stream.ts` 移除 P02 标 `@deprecated` 的 `collectText` 函数与 export；`rg 'collectText' src/`、`rg 'collectText' dist/` 均零命中。`dispatchMessage` 自行 for-await 累加，不受影响（`tests/unit/round-errors.test.ts` 12 tests 全绿）。
- **Task 2 自动化前置检查全部通过**：tsc 0 错；biome check src 0 错；vitest 5 文件 102 测试全绿；vite build 成功（pure client bundle，dist/ 干净）；/settings 路由存在；adapter 含 `anthropic-dangerous-direct-browser-access: true` header。

## Deviations from Plan

### 自动修复

无 Rules 1-3 触发。

### 环境限制（非偏差，需用户补完）

**.env.example 更新未完成**：本执行环境的权限设置拒绝 Read/Write/Bash 访问 `.env*` 路径（保护 secrets 的安全护栏）。Plan Task 1 要求在该文件为 `VITE_*`/`MODEL_PROXY_*` 加 `# dev-only optional` 标注。执行器无法直接写入。

**用户补完动作（轻量，仅需一次）**：按下方「.env.example 待补内容」段落的手写内容覆盖 `.env.example` 即可（纯模板文件，无 secrets）。本 plan 不阻塞 Phase 2，但 SC#3 文档侧完整闭环需要这一步。

## .env.example 待补内容（用户手动覆盖）

用户可执行：将 `.env.example` 覆盖为如下内容（与 Plan `<action>` 中 `.env.example` 步骤一致）：

```
# CouncilKit 环境变量示例。复制为 .env.local 并填入真实 API Key + endpoint（dev 验证用）。
# Key 仅存本地浏览器（AES 加密于 localStorage），不上传任何服务器。
# base_url 可覆写为任意 Anthropic/OpenAI 协议兼容网关（如 cld 配置的智谱/DeepSeek/zenmux）。
#
# Note (Phase 1 Production Gateway, 2026-06-25):
# Production 路径不再读 env：用户在 /settings 配置 gateway（name + type + baseUrl +
# AES 加密 key 存 localStorage），浏览器直连 model endpoint。下方 VITE_* 与
# MODEL_PROXY_* 仅保留为 dev-only optional，便于本地临时验证或 mock 场景。

# Anthropic Claude（或 Anthropic 协议兼容网关，如智谱 GLM 的 /anthropic 端点）
# dev-only optional (Phase 1 前)。Production 不读 env；用户在 /settings 配置 gateway + AES 加密 key 存 localStorage。
VITE_CLAUDE_API_KEY=
VITE_CLAUDE_BASE_URL=https://api.anthropic.com/v1/messages

# OpenAI (GPT)
# dev-only optional (Phase 1 前)。Production 不读 env；用户在 /settings 配置 gateway + AES 加密 key 存 localStorage。
VITE_OPENAI_API_KEY=
VITE_OPENAI_BASE_URL=https://api.openai.com/v1/chat/completions

# DeepSeek
# dev-only optional (Phase 1 前)。Production 不读 env；用户在 /settings 配置 gateway + AES 加密 key 存 localStorage。
VITE_DEEPSEEK_API_KEY=
VITE_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1/chat/completions

# dev-only (scripts/model-proxy.mjs)；production 不需要。
MODEL_PROXY_PORT=8788
# dev-only (scripts/model-proxy.mjs)；production 不需要。
MODEL_PROXY_URL=http://127.0.0.1:8788
```

## Automated Verification Results（执行器已实跑）

| Check | Command | Result |
|-------|---------|--------|
| TypeScript | `./node_modules/.bin/tsc --noEmit` | 0 errors |
| Lint | `./node_modules/.bin/biome check src` | 52 files, 0 errors |
| Unit tests | `./node_modules/.bin/vitest run` | 5 files / 102 tests pass |
| Production build | `./node_modules/.bin/vite build` | success, dist/index-*.js 581 kB |
| collectText removed (src) | `rg 'collectText' src/` | 0 matches |
| collectText removed (dist) | `rg 'collectText' dist/` | 0 matches |
| migration wired | `rg -c 'runStartupMigration' src/main.tsx` | 3 (import + call + comment) |
| proxy annotated | `rg -c 'Phase 1: 此 dev proxy' vite.config.ts` | 1 |
| model-proxy header note | `rg 'Phase 1 Production Gateway' scripts/model-proxy.mjs` | 1 |
| /settings route exists | `rg 'path.*settings' src/app/router.tsx` | line 18 |
| D-13 header in adapter | `rg 'anthropic-dangerous-direct-browser-access' src/services/gateway-adapters.ts` | line 77 |
| no /api/claude in src | `rg '/api/claude' src/` | 0 matches |
| no /api/claude in dist | `rg '/api/claude' dist/` | 0 matches |
| no VITE_*_API_KEY in src | `rg 'VITE_(CLAUDE\|OPENAI\|DEEPSEEK)_API_KEY' src/` | 0 matches |

## Human-Verify Pending（Task 2 — 需用户在真实浏览器 + 真实 API key 下完成）

下列 7 步实跑验证无法在执行器沙箱内完成（无有效 Anthropic/OpenAI API key，且沙箱不允许出网到第三方 model endpoint）。Plan 已把 Task 2 设为 `checkpoint:human-verify gate="blocking"`。

### 前置准备（用户）

- 拥有有效 **Anthropic API key**（`sk-ant-…`）和 **OpenAI 或 DeepSeek API key** 之一
- 停止任何在 :8788 跑的 model-proxy.mjs：`pkill -f model-proxy.mjs` 或 `lsof -ti:8788 | xargs kill`
- 项目根 `pnpm dev` 启动（仅 vite，不启动 proxy）

### 步骤 1 — 启动迁移接入验证（D-03 实跑侧）

- 浏览器开 http://localhost:5173
- DevTools Console 看无报错；若有旧 dev 数据（IndexedDB councilkit 中 agents 表含 `model:'claude'` 等标签），刷新后 DevTools Application → IndexedDB → councilkit → `gateways` 表应含 Claude/OpenAI/DeepSeek 占位（无 key），`agents` 表中对应记录的 `model` 字段已变 `claude-sonnet-4`/`gpt-4o`/`deepseek-chat`，且有 `gatewayId` 字段
- 若干净 DB（无旧 agent），gateways 表为空且无报错即可

### 步骤 2 — SC#1 + D-13 Anthropic CORS 直连验证（关键）

- 导航 `/settings` → 「+ 添加网关」→ 填：名称 `Claude 主账号` / 类型 `Anthropic` / Base URL `https://api.anthropic.com` / API 密钥 `<真实 sk-ant-...>` / 默认模型 ID `claude-sonnet-4-20250514` → 「保存网关」
- DevTools Network 面板开启 → 点该 gateway 卡的「测试连接」按钮
- 期望：
  - 按钮 transient 「测试中…」disabled
  - Network 出现 `POST https://api.anthropic.com/v1/messages` → **200 OK**
  - 请求 Headers 含 `x-api-key`、`anthropic-version: 2023-06-01`、**`anthropic-dangerous-direct-browser-access: true`** ← D-13 关键验证点
  - 无 CORS 错误
  - 按钮变「已连接」+ success 绿 tint + 状态 pill「已连接」绿色
- 若 CORS 报错或返回 401/403 → 失败 → 检查 key 与 header 实际是否在请求中（D-13 不通过则需回 01-02 修 adapter）

### 步骤 3 — SC#1 OpenAI 兼容验证

- 再「+ 添加网关」→ 名称 `OpenAI` / 类型 `OpenAI 兼容` / Base URL `https://api.openai.com` / API 密钥 `<真实 sk-...>` / 默认模型 ID `gpt-4o-mini` → 保存
- 点「测试连接」→ 期望「已连接」+ Network `POST https://api.openai.com/v1/chat/completions` 200 + `Authorization: Bearer sk-...`

### 步骤 4 — SC#2 完整 E2E 真实讨论流

- 导航 `/rooms/new` → 话题 `Phase 1 网关方案评审`
- 加 agent 1：角色 `产品经理` → 网关 `Claude 主账号` → 模型 `claude-sonnet-4-20250514` → 确认
- 加 agent 2：角色 `架构师` → 网关 `OpenAI` → 模型 `gpt-4o-mini` → 确认
- 「创建并进入」→ 「发起讨论」
- 期望：两 agent 依次 typing 流式文字（真实模型响应非空）→ 自动生成 summary 在 SummaryBlock 显示 → 无 agent offline
- UserInputBar 输入「请补充安全考虑」→ 提交 → 「开始新一轮」→ 第二轮 agent 看到 summary + 用户消息后继续发言

### 步骤 5 — SC#3 干净检出运行时侧验证

- DevTools Network 面板过滤 `/api/claude` → 应为空
- `lsof -i:8788` 应无输出（全程无 model-proxy.mjs 进程）
- 步骤 4 的 E2E 在此前提下完整跑通

### 步骤 6 — SC#4 错误处理验证

- `/settings` 编辑 Claude 主账号，把 API 密钥改成 `sk-ant-INVALID` → 保存
- `/rooms/new` 建 2 agent 都选 Claude 主账号 → 发起讨论
- 期望：
  - 第一个 agent inline 红「⚠ 密钥无效，已离线」+ body「网关 Claude 主账号 的 API 密钥被拒绝。请在「设置」更新密钥。」
  - 第二个 agent 不调请求，inline 红「⚠ 网关已离线」+ body「网关 Claude 主账号 已被标记离线，本轮跳过该 agent。」
  - 顶部 ErrorBanner 红 `role=alert`：「网关「Claude 主账号」已离线：密钥无效。该网关下 2 个 agent 本轮已跳过。」
  - 无 summary，额外黄 banner「本轮无有效发言，未生成总结。」
- 再建 1 agent Claude（错 key）+ 1 agent OpenAI（对 key）→ 发起讨论 → Claude 红 inline + OpenAI 正常发言 → summary 基于 OpenAI 发言生成
- `/settings` 把 Claude key 改回正确 → 测试连接「已连接」→ 重开一轮 → 全部正常

### 步骤 7 — 删除流程

- `/settings` 任意 gateway「删除」→ 确认 Modal 显示正确 gateway 名 + 「N 个 agent 的 gatewayId 将被清空」+ 「此操作不可撤销」+ 取消默认 focus + ESC 关闭
- 确认删除 → gateway 从列表消失 + DevTools Application localStorage 中 `councilkit.gateways.<id>.enc` 被清除

### 通过判据

全部 7 步符合预期，特别是步骤 2 (D-13 Anthropic CORS 200 + 已连接)、步骤 4 (SC#2 E2E)、步骤 5 (SC#3 无 /api/claude)、步骤 6 (SC#4 错误呈现与 UI-SPEC 一致)。

### Resume Signal

用户输入 `approved` 表示全部 7 步通过 → 执行器把 GW-01 + 01-05 plan mark-complete、Phase 1 关闭、进入 Phase 2。
或描述具体失败步骤与 DevTools Network/Console 输出，便于回退到对应 01-02/01-03/01-04 plan 修正。

## Known Stubs

无新增 stub。本 plan 仅启动接线 + 文档清理 + 孤儿删除，未引入新数据源或组件。

## Threat Flags

无新增威胁面。本 plan 的源码改动仅一行 `runStartupMigration()` 与若干注释/文档/孤儿函数删除；D-13 直连面已在 01-02 验证 header 就位，T-05-01..T-05-05 在 threat register 中已有 disposition。
