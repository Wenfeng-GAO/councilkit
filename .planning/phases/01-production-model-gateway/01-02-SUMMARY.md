---
phase: 01-production-model-gateway
plan: 02
plan_id: 01-02
subsystem: model-gateway-transport
tags: [agent, gateway, adapters, gateway-error, dispatch, anthropic, openai-compatible]
requires:
  - "src/models/agent.ts (legacy ModelType reshape target)"
  - "src/services/{claude,openai,deepseek}.ts (legacy env-var services to delete)"
  - "src/services/dispatch.ts (ModelType-keyed registry to rewrite)"
  - "src/lib/crypto.ts (P01 multi-key AES — loadGatewayApiKey)"
  - "src/lib/db.ts (P01 db.gateways table)"
  - "src/lib/stream.ts (streamDeltas + 10s timeout)"
provides:
  - "Agent.gatewayId + Agent.model:string (D-02)"
  - "TemplateAgentConfig.gatewayId + model:string"
  - "Summary.gatewayId + model:string"
  - "GatewayError interface + GatewayErrorKind 5-union (D-09 契约层)"
  - "anthropicAdapter + openaiCompatibleAdapter + mapStreamErrorToGatewayError + normalizeBaseUrl (D-04)"
  - "dispatchStream(agent, req, onChunk?) / dispatchMessage(agent, req) / resolveGatewayAndKey (D-07)"
  - "tests/unit/adapters.test.ts (21 cases)"
affects:
  - "src/services/model-registry.ts (registry Map deleted; only interface remains)"
  - "src/lib/stream.ts (collectText @deprecated; streamDeltas unchanged)"
  - "src/lib/summary.ts (gatewayId+model signature)"
  - "src/stores/queries.ts (runRound for-await dispatchStream)"
  - "src/app/pages/NewRoomPage.tsx (transitional gatewayId+model mapping; P03 wires real picker)"
  - "src/types/index.ts (ModelType @deprecated)"
tech_stack:
  added: []
  patterns:
    - "adapter-by-gateway-type 分派取代 ModelType Map registry (D-04)"
    - "GatewayError 5-class structured error chunk up to onChunk; runRound throw→catch→offline preserved"
    - "OpenAI SSE parsed via dedicated streamOpenAIDeltas (clone of streamDeltas, swapped parseChunk) — Anthropic path untouched"
    - "apiKey via loadGatewayApiKey(gatewayId); zero import.meta.env.VITE_*_API_KEY in src/"
key_files:
  created:
    - src/services/gateway-adapters.ts
    - tests/unit/adapters.test.ts
  modified:
    - src/types/index.ts
    - src/models/agent.ts
    - src/models/template.ts
    - src/models/round.ts
    - src/models/index.ts
    - src/services/model-registry.ts
    - src/services/dispatch.ts
    - src/lib/stream.ts
    - src/lib/summary.ts
    - src/stores/queries.ts
    - src/app/pages/NewRoomPage.tsx
    - tests/unit/models.test.ts
    - tests/unit/gateway-crypto-migrate.test.ts
  deleted:
    - src/services/claude.ts
    - src/services/openai.ts
    - src/services/deepseek.ts
decisions:
  - "Task 1 transitional: queries.ts/summary.ts used `agent.model as ModelType` cast to keep tsc green while dispatch.ts still had the old signature; Task 2 GREEN replaced the casts with the new dispatchMessage(agent, req) signature."
  - "Aborted-AbortError detection in streamOpenAIDeltas: controller.signal.aborted OR err.name==='AbortError' — synchronously-thrown DOMException('aborted','AbortError') from mock fetch does not trip the controller's own signal, so the err.name check is required to map to GatewayError timeout."
  - "dispatchMessage no longer calls collectText (replaced by internal for-await + throw on GatewayError); collectText in src/lib/stream.ts marked @deprecated for P05 Task 1 to delete (ripgrep confirms zero internal callers after this plan)."
  - "model-registry.ts reduced to the ModelService interface only — registry Map + register/get functions deleted because adapter-by-gateway-type dispatch removes the need for a ModelType→service lookup."
  - "resolveGatewayAndKey returns GatewayError (kind:invalid_key) when gateway not found OR apiKey missing, instead of throwing; dispatchStream forwards the error chunk to onChunk + yields. P04 can classify by kind per UI copy."
metrics:
  duration: "12 min"
  completed: "2026-06-25T15:55:00Z"
  tasks: 3
  files: 16
status: complete
---

# Phase 1 Plan 2: Production Model Gateway — Transport Layer Summary

把模型传输层从「ModelType 枚举 + 三份硬编码 env-var service」原子重构为「Agent `{gatewayId, model}` + 按 `gateway.type` 分派的双 adapter + GatewayError 五类结构化错误透传 + multi-key crypto」。dispatch 路径完全切换到 gatewayId 解析；src/ 内零 `import.meta.env.VITE_*_API_KEY` 引用。

## What Was Built

### Task 1 — Agent/Template/Summary reshape + GatewayError contract (D-02 + D-09)
- `src/types/index.ts`: 新增 `GatewayErrorKind = 'invalid_key'|'rate_limit'|'upstream'|'timeout'|'network'` 与 `GatewayError { kind; message; httpStatus? }`；`ModelType` 加 JSDoc `@deprecated` 保留导出供迁移期。
- `src/models/agent.ts`: `Agent` 删 `model: ModelType` → 加 `gatewayId: string` + `model: string`；`validateAgent` 加 `gatewayId must be non-empty` / `model must be non-empty` 校验。
- `src/models/template.ts`: `TemplateAgentConfig` 同步为 `gatewayId + model`。
- `src/models/round.ts`: `Summary.gatewayId + model: string`。
- `src/models/index.ts`: `CreateAgentInput`/`CreateSummaryInput` 新签名；re-export `GatewayError`/`GatewayErrorKind`。
- `src/lib/summary.ts`: `generateSummary({gatewayId, model, ...})`。
- `src/stores/queries.ts`: `runRound` 改用 `dispatchStream(agent, ...)`（Task 2 完成签名交接），`agents[0]` 缺失时 early return（去掉旧 `'claude'` fallback hack）；createSummary 传入 `gatewayId+model`。
- `src/app/pages/NewRoomPage.tsx`: transitional `MODEL_OPTIONS` 列表映射 `tag → {gatewayId: 'legacy-<tag>', model: real-id}`；P03 settings UI 替换为真实 gateway 选择器。
- `tests/unit/models.test.ts`: 新增 2 个 reject 测试（空 gatewayId/空 model）+ createSummary 新签名断言 + GatewayError 5-kind 类型契约。
- `tests/unit/gateway-crypto-migrate.test.ts`: `legacyAgent` helper 加 `gatewayId: ''` 字段以适配新 Required 类型。

### Task 2 — 双 adapter + 契约升级 + dispatch 重写 + 删除旧 service (D-04 + D-07 + D-09 透传)
- `src/services/gateway-adapters.ts` (NEW):
  - `normalizeBaseUrl(baseUrl)` — strip 尾部 `/`，strip 单个 `/v1` suffix（兼容 `https://api.openai.com/v1` 与裸 host 两种填法）。
  - `mapStreamErrorToGatewayError({httpStatus?, errorCode?, errorMessage})` — 401/403→invalid_key、429→rate_limit、5xx→upstream、`errorCode==='timeout'`→timeout、else→network。
  - `anthropicAdapter` — POST `${normalizeBaseUrl}/v1/messages`；headers `x-api-key` + `anthropic-version: 2023-06-01` + `anthropic-dangerous-direct-browser-access: true` + `Content-Type`；body 含 system 抽出 + messages + stream + max_tokens:1024；走 `streamDeltas`，content_block_delta→yield text，error chunk→map GatewayError，message_stop→return。
  - `openaiCompatibleAdapter` — POST `${normalizeBaseUrl}/v1/chat/completions`；headers `Authorization: Bearer` + `Content-Type`；messages 保留 role；走 **新 `streamOpenAIDeltas`**（与 streamDeltas 同构，仅 parseChunk 改为识别 `choices[0].delta.content`），不动 src/lib/stream.ts 主路径。
  - `errorFromStreamCode(message, code)` — 把 stream.ts 的 `code:String(status)` 还原为数字 httpStatus 再调 mapStreamErrorToGatewayError；非数字 code 走 errorCode 路径（timeout/stream）。
- `src/services/model-registry.ts`: `ModelService.streamMessage` 返回 `AsyncIterable<string | GatewayError>`；删除 `registry Map`/`registerModelService`/`getModelService`，仅保留 `ModelService` interface 作为契约。
- `src/services/dispatch.ts` 重写:
  - `resolveGatewayAndKey(agent: Pick<Agent,'gatewayId'|'model'>)` — `db.gateways.get(agent.gatewayId)` 取 gateway 元数据；`loadGatewayApiKey(agent.gatewayId)` 取明文 key；失败时返回 `GatewayError{kind:'invalid_key'}`（gateway 缺失或 key 未配置）。
  - `dispatchStream(agent, req, onChunk?)` AsyncIterable<string | GatewayError> — 按 `gateway.type` 分派 anthropicAdapter / openaiCompatibleAdapter；onChunk 透传（含 GatewayError）。10s 超时由 streamDeltas/streamOpenAIDeltas 内部 AbortController 保证。
  - `dispatchMessage(agent, req)` Promise<string> — 内部 for-await；遇 GatewayError throw（保留 summary 失败抛错语义；summary.ts 已 try/catch 兜底）。
- **DELETE**: `src/services/{claude,openai,deepseek}.ts` — ripgrep 确认零剩余引用。
- `src/lib/stream.ts`: `collectText` 加 JSDoc `@deprecated Phase 1: dispatchMessage 不再调用；P05 Task 1 显式删除`；**streamDeltas 主路径未改动**（计划要求不动）。
- `src/stores/queries.ts` `runRound`: for-await dispatchStream — `typeof chunk === 'string'` → `local += chunk` + `appendDelta`；非 string (`GatewayError`) → `throw new Error(chunk.message)` → 外层 catch → `setError` + `setAgentStatus offline` + `continue`。**行为等价保持**，P04 再按 kind 分类。
- `tests/unit/adapters.test.ts` (NEW, 21 cases): mock fetch + ReadableStream SSE；覆盖 normalizeBaseUrl (4)、mapStreamErrorToGatewayError (7)、anthropicAdapter URL/headers/SSE/401 (4)、openaiCompatibleAdapter URL/Bearer/SSE/429/500/AbortError→timeout/TypeError→network (6)。

### Task 3 — Stale env-var 审计（无源码改动）
- `! rg -n "VITE_(CLAUDE|OPENAI|DEEPSEEK)_API_KEY" src/` → `clean`（SC#3 守门）。
- `! rg -n "VITE_(CLAUDE|OPENAI|DEEPSEEK)_BASE_URL" src/` → `clean-baseurl`。
- `rg "import.meta.env" src/` → 零命中（src/ 完全脱离 env-var key 路径）。
- `rg "services/(claude|openai|deepseek)|claudeService|openaiService|deepseekService|claudeComplete|openaiComplete|deepseekComplete" src/ tests/` → 零命中（旧 service 引用全清）。
- `vite.config.ts` 的 `/api/claude` dev proxy 与 `.env.example` 标注留 P05 处理（计划显式要求）。

## Verification Results

| Command | Result |
|---------|--------|
| `./node_modules/.bin/vitest run` | PASS — 78 tests (3 files: models 29 + adapters 21 + gateway-crypto-migrate 28) |
| `./node_modules/.bin/tsc --noEmit` | PASS — 0 errors |
| `./node_modules/.bin/biome check src tests` | PASS — clean (auto-fixed formatter + import sort; 1 manual `useLiteralKeys` fix on `headers.Authorization`) |
| `! rg -n "VITE_(CLAUDE\|OPENAI\|DEEPSEEK)_API_KEY" src/ && echo clean` | `clean` (SC#3) |
| `! rg -n "VITE_(CLAUDE\|OPENAI\|DEEPSEEK)_BASE_URL" src/ && echo clean-baseurl` | `clean-baseurl` |
| `ls src/services/` | `dispatch.ts  gateway-adapters.ts  model-registry.ts` (legacy 3 删除确认) |

注：vitest 在 node env 跑（无原生 fetch/IndexedDB）。Adapter 测试用 `vi.fn().mockResolvedValue(new Response(ReadableStream, {...}))` mock fetch；ReadableStream/Response 在 node 18+ 全局可用。DOMException('aborted','AbortError') 直接 throw 模拟 abort 路径。

## TDD Gate Compliance

Plan frontmatter `type: execute`（非 plan-level `type: tdd`），每 task 标 `tdd="true"`。Task 1/2 按 RED→GREEN 分别提交：

| Task | RED commit | GREEN commit |
|------|------------|--------------|
| 1 | `61e7e79` (test) | `e6514e2` (feat) |
| 2 | `61bba1e` (test) | `18b8eb5` (feat) |
| 3 | audit only — 无源码改动；验证套件复用 Task 2 GREEN 结果 |

RED 提交仅含测试 + 最小编译脚手架（types stubs / throw 实现）；在该 commit 上对应测试 fail。GREEN 提交实现后测试全绿。gate 合规。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking tsc] Task 1 引入 NewRoomPage.tsx transitional gatewayId+model 映射**
- **Found during:** Task 1 RED tsc 检查
- **Issue:** NewRoomPage.tsx 用旧 `{model: draftModel, role, color}` 调 `createAgent`，新 Required `gatewayId` 字段让 tsc fail。计划 `<files>` 未列入此 UI 文件，但 Task 1 verify `tsc --noEmit` 必须通过。
- **Fix:** NewRoomPage.tsx `MODEL_OPTIONS` 列表映射 `tag → {gatewayId: 'legacy-<tag>', model: real-id}`（claude→claude-sonnet-4 / openai→gpt-4o / deepseek→deepseek-chat），`draftModelTag` state 替换 `draftModel: ModelType`。属 P02 transitional — P03 settings UI 接入 gateway 选择器后此映射删除。
- **Files modified:** src/app/pages/NewRoomPage.tsx
- **Commit:** 61e7e79

**2. [Rule 1 — Bug] streamOpenAIDeltas 缺 AbortError 显式检测**
- **Found during:** Task 2 GREEN —— 「yields GatewayError timeout when fetch aborts」用例 fail
- **Issue:** 计划依赖 stream.ts 把 abort 转 code:'timeout'，但 mock fetch 同步 throw `DOMException('aborted','AbortError')` 不会触发 `controller.signal.aborted`（streamOpenAIDeltas 自己的 AbortController 未被 abort），导致落到 network 分支而非 timeout。
- **Fix:** catch 内 `isAbort = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')`，覆盖两类 abort 来源（内部 10s 超时 vs 调用方 signal 传入 / 同步抛 AbortError）。
- **Files modified:** src/services/gateway-adapters.ts
- **Commit:** 18b8eb5

**3. [Rule 3 — Testability] legacyAgent helper 加 gatewayId:'' 适配新 Required 类型**
- **Found during:** Task 1 RED tsc 检查
- **Issue:** `tests/unit/gateway-crypto-migrate.test.ts` 的 `legacyAgent` 构造预迁移 agent，未设 `gatewayId`，新 Required 类型让 tsc fail。
- **Fix:** legacyAgent 默认 `gatewayId: ""`（预迁移占位；migrator 侧填真实 gw.id）；`model: model as Agent["model"]` 多余 cast 简化为 `model`（string）。
- **Files modified:** tests/unit/gateway-crypto-migrate.test.ts
- **Commit:** 61e7e79

## Threat Flags

无新增安全面超出 plan `<threat_model>`：
- T-02-01（adapter 透传 errorMessage 到 UI）— 已 mitigate：mapStreamErrorToGatewayError 仅保留 `HTTP ${status}` / `timeout` / err.message 短描述，不读取上游响应体；UI 文案在 P04 用 UI-SPEC copywriting 模板替换，runRound 当前 `setError(err.message)` 是 transitional，P04 充实。
- T-02-02（baseUrl 指向恶意端点截获 key）— accept：本地单用户自填 baseUrl（D-07 自担）。
- T-02-03（anthropic-dangerous-direct-browser-access 头就位）— 本 plan 仅注入 header；CORS 行为 P05 实跑验证。
- T-02-04/05/SC — 按计划 accept。

## Known Stubs

- `src/app/pages/NewRoomPage.tsx` `MODEL_OPTIONS` 用 hardcoded `gatewayId: 'legacy-<tag>'` 占位（无对应 gateway 实体存在于 db.gateways）。仅保证 UI 表单可编译 + 可创建 agent；runRound 调用此 agent 时 `dispatchStream` 会经 `resolveGatewayAndKey` 返回 `GatewayError{kind:'invalid_key', message:'gateway not found: legacy-claude'}` → runRound catch → 该 agent 标 offline。此 stub 是 P02→P03 settings UI transition 的明确占位，P03 在 `.planning/phases/03-agent-templates` 计划落地真实 gateway 选择器后清除（见 D-03 P01 migration seed 的占位 gateway 也可作为 P03 接入前的临时配置目标）。

## Self-Check: PASSED

- src/services/gateway-adapters.ts — FOUND (created)
- tests/unit/adapters.test.ts — FOUND (created)
- src/types/index.ts — FOUND (modified, GatewayError + @deprecated ModelType)
- src/models/{agent,template,round,index}.ts — FOUND (modified)
- src/services/dispatch.ts — FOUND (rewritten)
- src/services/model-registry.ts — FOUND (interface only)
- src/lib/stream.ts — FOUND (collectText @deprecated; streamDeltas 未改)
- src/lib/summary.ts / src/stores/queries.ts — FOUND (modified)
- src/services/{claude,openai,deepseek}.ts — confirmed DELETED (`git log --diff-filter=D`)
- Commits: 61e7e79, e6514e2, 61bba1e, 18b8eb5 — all FOUND in `git log --oneline`
