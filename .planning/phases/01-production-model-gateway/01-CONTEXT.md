# Phase 1: Production Model Gateway - Context

**Gathered:** 2026-06-25
**Status:** Ready for planning

<domain>
## Phase Boundary

交付一条浏览器可直达的生产模型网关路径：用户在应用内 `/settings` 页配置自己的模型网关（命名 gateway + type + base_url + AES 加密的 API key + 默认模型），浏览器直接命中模型端点，取代 dev-only 的 `scripts/model-proxy.mjs` → `cld ant glm5.2` 路线。同时补齐网关错误处理——无效 key / 限流 / 上游故障 / 超时 / 网络错误 分类呈现，受影响 agent 标离线而其他 agent 继续。

**映射需求：** GW-01
**成功标准（ROADMAP）：**
1. 用户能在 settings 页填入自己的 API key（和 base_url），浏览器直达模型端点——无需 `cld ant glm5.2` 或 dev proxy 进程运行。
2. 完整讨论流（建房间 → 加 agent → 跑一轮 → 自动总结 → 追问）经生产网关端到端跑通，用户可见真实模型输出。
3. 干净检出、仅用用户配置的 key 即可运行；`scripts/model-proxy.mjs` 不再在生产运行路径上。
4. 网关错误（invalid key / rate limit / upstream / timeout）呈现清晰的用户可见消息，受影响 agent 标离线而其他 agent 继续。

**不在本 phase 范围（继承锁定）：** P1 agent 特性（R9 模板 / R10 独立回答 / R11 中途增删 agent）、VT 验证门禁闭合（Phase 2）、导出 Markdown/PDF（v2）。

</domain>

<decisions>
## Implementation Decisions

### Provider/Key 配置模型
- **D-01:** 采用**通用 gateway 列表**数据模型，而非固定 3 provider 枚举。用户可添加任意数量的命名 gateway，支持本地/自定义端点（Ollama/vLLM 等），贴合 CR1「多网关 + base_url 可配」。Gateway 字段：`{ id, name, type, baseUrl, defaultModel, createdAt }`。
- **D-02:** Agent 字段从 `model: ModelType` 改为 **`{ gatewayId: string, model: string }`**（`model` 为真实 API model id，如 `claude-sonnet-4` / `gpt-4o`）。新建 agent 时以所选 gateway 的 `defaultModel` 预填。`ModelType` 枚举废弃。
- **D-03:** 旧数据迁移——启动时检测旧 `agent.model` 为 `"claude"|"openai"|"deepseek"` 标签的记录，按 tag 自动 seed 三个占位 gateway（名称 Claude/OpenAI/DeepSeek，type 分别 anthropic/openai-compatible/openai-compatible，base_url 用官方默认，**需用户补 key**），并回填 `gatewayId`；旧 `model` 标签丢弃。
- **D-04:** gateway.type 仅两种：**`anthropic`**（契约 `/v1/messages` + `x-api-key` + `anthropic-version` + `content_block_delta` SSE）与 **`openai-compatible`**（契约 `/v1/chat/completions` + `Authorization: Bearer` + `choices[].delta.content` SSE，覆盖 OpenAI/DeepSeek/Ollama/vLLM）。现有 `claude.ts`/`openai.ts`/`deepseek.ts` 三份 service 收敛为两个通用 adapter，按 `gateway.type` 分派。

### 设置页与密钥 UX
- **D-05:** gateway 管理入口为 **sidebar 第 4 项「设置」→ `/settings` 路由**。草图锁定的 3 入口 sidebar 据此扩展为基础页第 4 项。
- **D-06:** 多 gateway key 加密策略 = **固定 passphrase + 多 key**。扩展现有 `src/lib/crypto.ts`（当前单 key、固定 passphrase `councilkit-local-v1`、AES）为按 `gatewayId` 存多条 cipher。沿用本地单用户固定 passphrase（TECH 安全边界已确认），**不引入** master passphrase 摩擦。
- **D-07:** gateway **元数据**（name/type/baseUrl/defaultModel）存 **Dexie `gateways` 表**（与 rooms/agents/templates 一致，`agent.gatewayId` 可引用）；**apiKey 仅存 localStorage**（AES 加密，按 gatewayId 索引）——符合 PROJECT.md「API keys AES-encrypted in localStorage」约束。
- **D-08:** settings 页有**「测试连接」按钮**——填完 key 后发一个最小流式请求（max_tokens 极小、stream:true），验证 HTTP 200 + 收到至少一个 delta。避免错误 key 拖到真实讨论时才暴露。

### 错误呈现粒度
- **D-09:** 网关错误五类结构化：`{ kind: "invalid_key"|"rate_limit"|"upstream"|"timeout"|"network", message, httpStatus? }`。映射：401/403 → invalid_key，429 → rate_limit，5xx → upstream，AbortController abort → timeout，fetch throw（非 abort）→ network。在 service 层把 `streamDeltas` 当前被静默丢弃的 `{type:"error"}` chunk 转成该结构透传给 `dispatchStream`/`runRound`。
- **D-10:** 呈现位置双重——**该 agent 气泡内联**显示错误状态（如「⚠ 密钥无效，已离线」）+ **顶部 banner/toast** 汇总本轮错误。
- **D-11:** 离线粒度——**致命错误（invalid_key）扩散到整个 gateway**：同 gateway 的其他 agent 在本轮跳过并内联提示「gateway 已离线」，避免重复 401 浪费配额。**可恢复错误（timeout/rate_limit/upstream/network）只标该 agent 离线**，其他 agent 继续。
- **D-12:** 本轮编排行为——沿用 10s 超时（R7 locked，不改）。全 agent 离线时**跳过总结**，顶部 banner 提示「本轮无有效发言，未生成总结」，round 标 `completed` 但无 summary。部分 agent 成功则基于成功发言正常总结。`runRound` 现为顺序执行，「其他 agent 继续」在结构上天然成立。

### 生产传输方式（继承锁定，未单独讨论）
- **D-13:** 生产传输 = **浏览器直连**所有 provider（SC#1/SC#3 字面锁定「浏览器直达、无 proxy 进程」）。Anthropic 走 `anthropic-dangerous-direct-browser-access: true` 头启用浏览器 CORS 直连；OpenAI-compatible 原生支持浏览器 fetch。本地单用户模型下 key 已在浏览器 localStorage，直连可接受。**需 researcher 验证** Anthropic CORS 头方案在当前 `stream.ts` fetch 路径下可行，以及各 provider 的 CORS/`dangerouslyAllowBrowser` 现状。

### Claude's Discretion
- gateway 元数据 Dexie 表结构细节、crypto.ts 多 key 的具体 localStorage key 命名（如 `councilkit.gateways.{id}.enc`）、baseUrl 是否自动补 `/v1/...` 路径 vs 用户填全 URL（建议：用户只填 host，代码按 type 拼路径，与现有 `claude.ts` 一致）。
- 测试连接请求的具体 model/max_tokens 取值（用 gateway.defaultModel、max_tokens=1 之类极小值）。
- 五类错误的中英文案措辞。
- sidebar 第 4 项的图标/位置（底部 vs 顺序第 4）。

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 项目定义与约束
- `.planning/PROJECT.md` — Core Value / Constraints（tech stack locked / Secrets AES-localStorage / Model gateway base_url 可配 CR1）/ Key Decisions（dev model-proxy pending、CR1 closed）
- `.planning/REQUIREMENTS.md` — GW-01 定义；P0 R1–R8 validated（locked，改动需 CR）；Out of Scope 表
- `.planning/ROADMAP.md` §「Phase 1: Production Model Gateway」— Goal / Success Criteria（4 条）/ Depends on / UI hint

### VibeSpec 产物（产品定义 source of truth）
- `docs/vibespec/councilkit/TECH.md` — 技术栈与安全边界（CR1 re-confirmed 2026-06-24）；AES passphrase「本地单用户」依据
- `docs/vibespec/councilkit/PRD.md` — 产品定义（模型选择 / agent 配置语义）
- `docs/vibespec/councilkit/DESIGN.md` — 设计方向（settings 页落点参考）

### 设计方向
- `.planning/sketches/MANIFEST.md` — sidebar 三入口布局（本 phase 扩展为第 4 项「设置」）、极简暗色 Linear/Notion 美学
- `.claude/skills/sketch-findings-councilkit/SKILL.md` — 已验证设计决策（agent 一级实体、暗色气泡、色系）

### 现有代码（侦察得到的可复用资产与集成点）
- `src/services/{claude,openai,deepseek}.ts` — 三个硬编码 service，本 phase 收敛为两个 type adapter
- `src/services/dispatch.ts` / `src/services/model-registry.ts` — `ModelService` 契约 + registry，需按 type 重构
- `src/lib/stream.ts` — `streamDeltas`（10s 超时、SSE 解析、error chunk 产出）；`StreamChunk` 类型
- `src/lib/crypto.ts` — `saveApiKey/loadApiKey`（单 key、固定 passphrase），需扩多 key
- `src/stores/queries.ts` `runRound` — 顺序编排、错误兜底（catch→offline→continue）；总结环节
- `src/stores/discussion.ts` — `agentStatus`/`lastError`/`drafting` 状态
- `src/models/index.ts` / `src/models/agent.ts` — `Agent` 模型（`model: ModelType` 待改）、Dexie schema
- `src/app/router.tsx` — 路由（无 `/settings`，需新增）
- `vite.config.ts` — dev proxy `/api/claude`（仅 dev，生产移除/保留 dev-only）
- `scripts/model-proxy.mjs` — dev-only，生产路径不再依赖

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/crypto.ts`：AES 加密 + localStorage 已实现，扩展为多 key（按 gatewayId）即可，passphrase 沿用。
- `src/lib/stream.ts` `streamDeltas`：SSE 解析 + 10s 超时 + error chunk 产出已就绪，错误链路只差 service 层不丢弃 error chunk 并结构化透传。
- `src/services/model-registry.ts` `ModelService` 契约（`streamMessage: AsyncIterable<string>`）：可沿契约改为按 type 注册 adapter，但需把 error 透传——建议契约返回类型从 `AsyncIterable<string>` 升级为 `AsyncIterable<string | GatewayError>`。
- `src/stores/discussion.ts`：`agentStatus`/`lastError`/`setAgentStatus` 已有，错误呈现可直接复用。
- Dexie schema（`src/models/index.ts` + `src/lib/db.ts`）：加 `gateways` 表与现有 rooms/agents/templates 同构。

### Established Patterns
- 所有实体走「model 文件（interface + create + validate）+ Dexie 表」模式——gateway 沿用。
- service 通过 registry 注册、dispatch 按需 resolve——type adapter 沿用此模式。
- 暗色极简 UI（sketch-findings）——settings 页遵循。

### Integration Points
- `runRound`（`src/stores/queries.ts`）是错误处理接入点：dispatchStream 需把结构化错误回传，runRound 按 kind 决定「扩散 gateway 离线」vs「单 agent 离线」vs「跳过总结」。
- `Agent` 模型字段改造波及 `createAgent`/`validateAgent`、NewRoomPage 的 agent 创建 UI、template（Phase 3 会用到）。
- router 新增 `/settings` 路由 + sidebar 第 4 项。

</code_context>

<specifics>
## Specific Ideas

- 浏览器直连 Anthropic 需 `anthropic-dangerous-direct-browser-access: true` 请求头（researcher 验证）。
- gateway.type 决定一切契约差异（URL 后缀、鉴权头、SSE 解析路径），是 adapter 分派的唯一键。
- 测试连接用 gateway.defaultModel + max_tokens 极小的 stream 请求。
- 旧数据迁移按 tag seed 三个占位 gateway——用户必须补 key 才能用（占位 gateway 无 key 时该 gateway 下的 agent 直接 invalid_key 离线）。

</specifics>

<deferred>
## Deferred Ideas

- 「测试连接」之外的 gateway 健康监控（后台周期性 ping、延迟展示）——过度设计，留待有需要时再做。
- gateway 级别的速率限制自适应退避——当前仅按 429 标离线，自适应退避延后。
- model 选择器从手填 model id 升级为下拉（拉取 `/v1/models`）——anthropic 无 models list，兼容性差，延后；V1 手填 + defaultModel 预填。
- 生产放宽超时（30s）——与 R7「首条 ≤10s」冲突，需重开 R7（CR），不在本 phase。

### Reviewed Todos (not folded)
- `.planning/todos/pending/mock-ui-dev-tasks.md`（「Mock UI 开发任务」，score 0.4，关键词 agent/cld）——STATE.md 已标 likely stale（mock UI 已在 MVP 交付），与生产网关 scope 无关，不折叠。建议在 Phase 1 planning 时 prune。

</deferred>

---

*Phase: 1-Production Model Gateway*
*Context gathered: 2026-06-25*
