---
phase: 01-production-model-gateway
plan: 03
plan_id: 01-03
subsystem: model-gateway-settings-ui
tags: [settings, gateway, design-tokens, statuspill, test-connection, sidebar, router, ui]
requires:
  - "src/lib/db.ts (P01 db.gateways + 5 helpers)"
  - "src/lib/crypto.ts (P01 save/load/clearGatewayApiKey + gatewayKeyStorageId)"
  - "src/models/gateway.ts (P01 Gateway + createGateway)"
  - "src/services/gateway-adapters.ts (P02 anthropicAdapter + openaiCompatibleAdapter)"
  - "src/models/agent.ts (P02 Agent.gatewayId+model)"
  - "src/components/ui/* (Button/Modal/Select/TextInput/EmptyState)"
provides:
  - "/settings route + SettingsPage (gateway 列表 + 空态 + CRUD Modal + 测试连接 4 态)"
  - "design tokens: --color-success/warn/error/info/surface-2 + Tailwind color 映射"
  - "src/components/shared/StatusPill.tsx (tone + text 通用 pill)"
  - "src/stores/gateways.ts (useGateways + 3 mutation hooks + 3 action 函数 + gatewayKeys)"
  - "src/lib/gateway-test.ts (testGatewayConnection 3 路径)"
  - "src/components/gateway/{GatewayCard,GatewayFormModal,TestConnectionButton,DeleteGatewayModal}.tsx"
  - "Sidebar 第 4 项「设置」footer NavLink (D-05)"
  - "NewRoomPage gateway Select + 模型 ID TextInput + 空 gateway notice (D-02 配套)"
  - "AgentConfigCard subtitle: gatewayName · model"
  - "gateway-adapters maxTokens 可选参数 (T-03-05 最小测试请求)"
affects:
  - "src/services/gateway-adapters.ts (maxTokens param additive, fallback default 1024)"
  - "src/components/ui/TextInput.tsx (help prop additive, 下游表单可复用)"
  - "P04 runRound (gateway.select 当 agent.gatewayId=空串时需处理 invalid_key 友好提示)"
  - "Phase 2 VERIFY-01 (共用同一组 semantic color tokens)"
tech_stack:
  added: []
  patterns:
    - "store = action 函数 (db+crypto) + useMutation wrapper，action 函数可独立单测 (node env, 无 React 渲染)"
    - "测试连接走最小 stream 请求 (maxTokens=1)；adapter 接受可选 maxTokens 参数透传到 body"
    - "useDeleteGateway mutationFn 主动 db.agents.where('gatewayId').equals(id).modify({gatewayId:''}) 清空 agent 字段，与 UI-SPEC 删除 Modal 文案一致 (T-03-03 mitigate)"
    - "apiKey 全程不显示明文；编辑态 placeholder '••••••••'，留空保留既有 cipher"
key_files:
  created:
    - src/components/shared/StatusPill.tsx
    - src/lib/gateway-test.ts
    - src/components/gateway/GatewayCard.tsx
    - src/components/gateway/GatewayFormModal.tsx
    - src/components/gateway/TestConnectionButton.tsx
    - src/components/gateway/DeleteGatewayModal.tsx
    - src/app/pages/SettingsPage.tsx
    - src/stores/gateways.ts
    - tests/unit/settings-store.test.ts
  modified:
    - src/styles/globals.css
    - tailwind.config.ts
    - src/services/gateway-adapters.ts
    - src/components/ui/TextInput.tsx
    - src/components/layout/Sidebar.tsx
    - src/app/router.tsx
    - src/components/agent/AgentConfigCard.tsx
    - src/app/pages/NewRoomPage.tsx
decisions:
  - "store 拆 action 函数 + hooks：useGateways/useCreateGateway/useUpdateGateway/useDeleteGateway 对应的 mutationFn 拆为 createGatewayAction/updateGatewayAction/deleteGatewayAction 三个独立导出，便于 node env 单测直接驱动；hooks 内 useMutation 仅做 wiring + onSuccess invalidate。"
  - "gateway-adapters 增加可选 maxTokens 参数：plan behavior 要求测试连接以 max_tokens=1 最小 stream 请求 (T-03-05)，原 adapter 硬编码 1024。additive 改动：anthropic body 用 `max_tokens: params.maxTokens ?? 1024`；openaiCompatible 只在传入时设置 max_tokens。fallback 默认行为未变 (T-02 既有 adapter 测试全绿)。"
  - "useDeleteGateway mutationFn 内 db.agents.where('gatewayId').equals(id).modify({gatewayId:''})：与 UI-SPEC DeleteGatewayModal 文案「gatewayId 将被清空并标记为离线」行为一致 (T-03-03 mitigate)；onSuccess 同时 invalidate gateways + agents + rooms 查询兜底刷新。P04 runRound 内 resolveGatewayAndKey 对空串 gatewayId 二次兜底 (既有逻辑已返 invalid_key)。"
  - "GatewayCard 用 div+role='button'+tabIndex 承载 Enter→onEdit (UI-SPEC keyboard)：含内部 action 按钮 (编辑/删除/测试)，<button> 外层会形成嵌套 interactive 内容，故用 biome-ignore suppression 维持 a11y 行为。"
patterns-established:
  - "Action function + hook：store 模块拆 action 函数，便于单测；hook 仅做 useMutation/queryClient wiring"
  - "测试连接约定 maxTokens=1 与 ping message，封装在 testGatewayConnection 内"
  - "StatusPill 通用化：tone × text，调用方负责文案携带含义 (颜色非唯一信号)"
requirements-completed: [GW-01]
metrics:
  duration: "12 min"
  completed: "2026-06-26T00:11:00Z"
  tasks: 3
  files: 17
status: complete
---

# Phase 1 Plan 3: Production Model Gateway — Settings UI Summary

落地用户可见的网关配置入口：扩展设计 token (globals.css + Tailwind 5 色)、新增 /settings 页面承载 gateway CRUD 与「测试连接」4 态、Sidebar 第 4 项「设置」入口、router 挂载，以及 NewRoomPage/AgentConfigCard 同步走 gateway 选择。

## What Was Built

### Task 1 — 设计 token 扩展 + StatusPill 通用组件
- `src/styles/globals.css:root` 新增 5 个 CSS 变量：`--color-success:#22c55e`、`--color-warn:#d29922`、`--color-error:#f85149`、`--color-info:#58a6ff`、`--color-surface-2:#1e2128`。（与 Phase 2 VERIFY-01 协调，全 milestone 同一组值，不发散。）
- `tailwind.config.ts` `theme.extend.colors` 增 5 项映射：`success/warn/error/info → var(--color-*)` + `"surface-2": "var(--color-surface-2)"`（连字符键名用字符串引号）。
- `src/components/shared/StatusPill.tsx`：`{ tone: 'muted'|'info'|'success'|'error'|'warn'; text; className? }`，5 种 tone 对应 bg/tone-10 + border + text 类。基础类 `inline-flex items-center rounded px-2 py-0.5 text-xs leading-snug`，不含 emoji/glyph（颜色不作为唯一信号由调用方在 text 携带含义文字）。

### Task 2 — useGateways store + testGatewayConnection + Settings 页 CRUD 组件（TDD）
- `src/stores/gateways.ts` (NEW)：
  - `gatewayKeys = { list: ['gateways'], detail: (id)=>['gateway', id] }`
  - `useGateways()` — `useQuery({ queryKey: gatewayKeys.list, queryFn: listGateways })`
  - `createGatewayAction(input)` — `createGateway + addGateway + saveGatewayApiKey(id, plain)`，独立可测
  - `updateGatewayAction({id, changes, apiKey?})` — `updateGateway + (apiKey 非空时) saveGatewayApiKey`
  - `deleteGatewayAction(id)` — `db.agents.where('gatewayId').equals(id).modify({gatewayId:''})` → `deleteGateway` → `clearGatewayApiKey`（**T-03-03 mitigate**：与 UI-SPEC 删除 Modal 文案「gatewayId 将被清空」行为一致）
  - 三个 hook (useCreateGateway/useUpdateGateway/useDeleteGateway) useMutation 包装 action，`onSuccess` invalidate `gatewayKeys.list`（delete 同步 invalidate `agents` + `rooms` 兜底）。
- `src/lib/gateway-test.ts` (NEW)：`testGatewayConnection(gateway): Promise<{ok:true}|{ok:false, error:GatewayError}>`
  - (1) `loadGatewayApiKey(gateway.id) === null` → `{ok:false, error:{kind:'invalid_key', message:'未配置 API 密钥'}}`，不调 fetch
  - (2) 按 `gateway.type` 选 anthropicAdapter / openaiCompatibleAdapter，构造 `messages=[{role:'user',content:'ping'}]` + `maxTokens:1`，for-await：收到 string chunk → `{ok:true}`；收到 GatewayError → `{ok:false, error}`
  - (3) 流正常结束无 chunk（max_tokens=1 可能 0 delta）→ `{ok:true}`
  - (4) 任意 throw → `{ok:false, error:{kind:'network', message: err.message}}`
- `src/services/gateway-adapters.ts` (MODIFIED, additive)：两个 adapter 增加可选 `maxTokens?: number` 参数。anthropic body：`max_tokens: params.maxTokens ?? 1024`；openaiCompatible 仅在传入时设置 `max_tokens`。fallback 默认 1024 未变，T-02 既有 adapter 测试全绿。
- `src/components/gateway/TestConnectionButton.tsx` (NEW)：5 状态（idle/testing/success/failed-fatal/failed-other）按钮，文案与 UI-SPEC 完全一致：`测试连接 / 测试中… / 已连接 (disabled, success tint) / 重试测试 (failed 红 tint)`。failed-fatal 与 failed-other 共用外观，failedKind 传入 `aria-label` 区分「密钥无效」/「连接失败」。
- `src/components/gateway/GatewayCard.tsx` (NEW)：rounded border-edge bg-surface px-4 py-3 + hover:border-accent；左 = 首字母圆 avatar + name (14px font-semibold) + type StatusPill (muted) + baseUrl (mono, muted) + defaultModel (muted)；右 = TestConnectionButton + 编辑网关 + 删除 (text-error)。`div role='button' tabIndex={0}` Enter→onEdit (UI-SPEC keyboard)，biome-ignore 维持 a11y 行为（含内部嵌套按钮）。
- `src/components/gateway/GatewayFormModal.tsx` (NEW)：5 字段 (name/Select type/TextInput baseUrl/TextInput password apiKey/TextInput defaultModel) 全部 label/placeholder/help 文案与 UI-SPEC copywriting 表对齐；编辑态 apiKey placeholder `••••••••`（留空保留既有 cipher）；表单校验失败文案 `请填写名称、类型、base URL 与 API 密钥。`；底部「取消」+「保存网关」(primary h-10)；Modal title = `添加网关` / `编辑网关`。
- `src/components/gateway/DeleteGatewayModal.tsx` (NEW)：Modal title `删除网关「{name}」？`，body 含 N (agentCount) + 「gatewayId 将被清空并标记为离线。密钥将从本机删除。此操作不可撤销。」；取消/删除两按钮，useEffect focus ref 到「取消」（安全选择），ESC 走 Modal 内置。
- `src/app/pages/SettingsPage.tsx` (NEW)：mx-auto max-w-2xl 容器，h1 `设置` → section `模型网关` + sub 文案 → `+ 添加网关` CTA (primary h-10) → 列表 (gateway × N，空态 EmptyState + CTA) → form/delete modal orchestration；per-gateway status map (`Record<id, {status, failedKind}>`) 驱动 TestConnectionButton；openDelete 前 `db.agents.where('gatewayId').equals(g.id).count()` 传 real agentCount；handleTest 设 testing → 调 testGatewayConnection → 据 error.kind 分 failed-fatal/failed-other。
- `src/components/ui/TextInput.tsx` (MODIFIED, additive)：新增 `help?: ReactNode` 渲染为 label 内输入框下 `<span class=text-xs text-muted>`，下游表单字段提示复用。
- `tests/unit/settings-store.test.ts` (NEW, 12 cases)：mock db + crypto + adapter + @tanstack/react-query，逐项验证：
  - gatewayKeys list/detail factory
  - createGatewayAction → addGateway + saveGatewayApiKey(id, key)
  - updateGatewayAction 三路径（无 apiKey / 有 apiKey / 空串）
  - deleteGatewayAction → agents.where.modify + deleteGateway + clearGatewayApiKey
  - hooks 注册 onSuccess invalidate gateways list
  - testGatewayConnection 5 路径：无 key、string chunk、GatewayError chunk、openaiCompatible 选用、maxTokens=1 + ping message

### Task 3 — Sidebar 第 4 项 + router /settings + NewRoomPage gateway select + AgentConfigCard subtitle
- `src/components/layout/Sidebar.tsx` (MODIFIED)：在 `<nav>` 后、footer `<p>` 前插入 `<div className="border-t border-edge my-2" />` 分隔 + `<div className="px-2"><NavLink to="/settings">设置</NavLink></div>`。footer 文案保留。
- `src/app/router.tsx` (MODIFIED)：`import { SettingsPage }`，新增 `{ path: "/settings", element: withShell(<SettingsPage/>) }`。
- `src/app/pages/NewRoomPage.tsx` (MODIFIED)：删除 transitional `MODEL_OPTIONS` 常量与 `draftModelTag` state；引入 `useGateways()`；state 新增 `draftGatewayId: string` + `draftModel: string`；Modal 字段：保留 角色/立场 TextInput + 新增 `网关 Select` (options=gateways) + `模型 ID TextInput` (gateway switch 自动预填 defaultModel)；`gateways.length===0` 显示 `<div class=border-warn bg-warn/10 p-4>` 通知块「尚未配置任何网关…前往「设置」…」+ `前往设置` 链接 (navigate('/settings'))；确认添加按钮 disabled 当 `draftRole.trim() === '' || !draftGatewayId`；`createAgent({gatewayId: draftGatewayId, model, role, color})`。
- `src/components/agent/AgentConfigCard.tsx` (MODIFIED)：props 加 `gatewayName?: string`；subtitle 行从 `{agent.model}` 改为 `{gatewayName ? \`${gatewayName} · ${agent.model}\` : agent.model}`；NewRoomPage 渲染处 `gatewayName={gateways.find(g => g.id === a.gatewayId)?.name}`。

## Verification Results

| Command | Result |
|---------|--------|
| `./node_modules/.bin/vitest run` | PASS — 90 tests (4 files: models 29 + adapters 21 + gateway-crypto-migrate 28 + settings-store 12) |
| `./node_modules/.bin/tsc --noEmit` | PASS — 0 errors |
| `./node_modules/.bin/biome check src tests` | PASS — clean (auto-fixed formatter + const/import) |
| `rg 'path: "/settings"' src/app/router.tsx` | matched （/settings route present） |
| `rg 'to="/settings"' src/components/layout/Sidebar.tsx` | matched （sidebar entry present） |
| Plan token verify: 5 css vars + tailwind map | 全部 FOUND |

注：vitest 在 node env 跑（无 DOM / IndexedDB / localStorage）。store 测试通过 mock `@/lib/db`/`@/lib/crypto`/`@/services/gateway-adapters`/`@tanstack/react-query`，捕获 useMutation config + 直接驱动 action 函数 + testGatewayConnection 三路径。Hook wiring 用 `useMutation` mock 截获 onSuccess 验证 invalidateQueries 调用。删除 useDeleteGateway mutationFn `{gatewayId: ''}` 实际 modify 调用由 mock `db.agents.where().equals().modify()` 记录断言。

## TDD Gate Compliance

Plan frontmatter `type: execute`（非 plan-level `type: tdd`），Task 2 标 `tdd="true"`。

| Task | RED commit | GREEN commit |
|------|------------|--------------|
| 1 | (Task 1 非 TDD；直接落 token + 组件) | — |
| 2 | `e664ef6` (test) | `63d2840` (feat) |
| 3 | (Task 3 非 TDD；UI wiring) | — |

Task 2 RED 在落实现前运行确认 fail（module not found），GREEN 落地后 12 测试全绿。gate 合规。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Critical (T-03-05)] adapter 接受 maxTokens 参数**
- **Found during:** Task 2 实现 testGatewayConnection
- **Issue:** Plan behavior 要求测试连接发 max_tokens=1 最小请求（T-03-05 mitigate），但 anthropicAdapter 硬编码 `max_tokens: 1024`，openaiCompatibleAdapter 不设 max_tokens。adapter 签名未列入 plan `<files_modified>`，但mitigation 必须落地。
- **Fix:** 两个 adapter 增加可选 `maxTokens?: number` 参数（additive, back-compat）。anthropic body：`max_tokens: params.maxTokens ?? 1024`；openaiCompatible 仅在传入时 set body.max_tokens。T-02 既有 adapter 21 测试全绿。
- **Files modified:** src/services/gateway-adapters.ts
- **Commit:** 63d2840

**2. [Rule 3 — Blocking] TextInput 缺 help prop 承载 UI-SPEC 字段说明文案**
- **Found during:** Task 2 实现 GatewayFormModal
- **Issue:** UI-SPEC copywriting 表给每个字段配了 help 文案（如「AES 加密后存于 localStorage…」「只填 host…」），既有 TextInput 仅支持 `label`。passing `help` via `...rest` 会落到 `<input>` 上变成非法属性。
- **Fix:** TextInput 新增 `help?: ReactNode`，渲染为 input 下 `<span class=text-xs text-muted>`。additive，back-compat（避免下游表单复制粘贴说明 JSX）。
- **Files modified:** src/components/ui/TextInput.tsx
- **Commit:** 63d2840

**3. [Rule 3 — Blocking tsc] Gateway/GatewayType 从 @/types 导入失败**
- **Found during:** Task 2 GREEN tsc
- **Issue:** 初版组件 import 从 `@/types` 取 `Gateway/GatewayType`，但实际经 `@/models` re-export。
- **Fix:** 组件 import 改用 `@/models`（Gateway/GatewayType），`@/types` 仅取 `GatewayError/GatewayErrorKind/GatewayError`。stores/gateways.ts re-export `Gateway` 便于 SettingsPage 统一从 store 取。
- **Files modified:** src/lib/gateway-test.ts, src/components/gateway/*.tsx, src/stores/gateways.ts, src/app/pages/SettingsPage.tsx
- **Commit:** 63d2840

**4. [Rule 1 — A11y] GatewayCard role="button" on div 触发 biome useSemanticElements**
- **Found during:** Task 2 biome check
- **Issue:** UI-SPEC 要求 Enter on focused GatewayCard → 编辑，但卡片含内部 action 按钮（编辑/删除/测试连接）；用 `<button>` 外层会形成嵌套 interactive 内容（HTML invalid）。
- **Fix:** 保持 `<div role="button" tabIndex={0} onKeyDown={Enter→onEdit}>`，加 `// biome-ignore lint/a11y/useSemanticElements: ...` 注释说明 nesting 冲突。Enter→编辑 a11y 行为保留。
- **Files modified:** src/components/gateway/GatewayCard.tsx
- **Commit:** 63d2840

**5. [Rule 3 — Test runner] settings-store.test capturedConfigs `let → const`**
- **Found during:** Task 3 全量 biome check
- **Issue:** `let capturedConfigs = []` 仅 `.push()` 未 reassign，biome lint/style/useConst 触发。
- **Fix:** `const capturedConfigs = [...]`（push 仍可 mutate）。同步 auto-format 跨行 type annotation。
- **Files modified:** tests/unit/settings-store.test.ts
- **Commit:** 0e57a44

## Threat Flags

无新增安全面超出 plan `<threat_model>`：
- T-03-01（apiKey 明文显示）— mitigate：GatewayFormModal apiKey `type='password'` + 编辑态 placeholder `••••••••`；GatewayCard 不渲染 key 字段；StatusPill 不渲染 key。
- T-03-03（删除清字段 vs UI 文案）— mitigate：deleteGatewayAction mutationFn 主动 `db.agents.where('gatewayId').equals(id).modify({gatewayId:''})`，与 UI-SPEC DeleteGatewayModal 文案「gatewayId 将被清空」行为一致；P04 runRound 内 resolveGatewayAndKey 对空串 gatewayId 已返 invalid_key（既有逻辑）。
- T-03-04（测试连接暴露 key 跨域）— accept：用户主动配置 endpoint（D-07 自担），单次最小请求 (maxTokens=1)。
- T-03-05（频点测试消耗配额）— mitigate：maxTokens=1 最小请求 + 按钮 testing 状态 disabled 防 4 态重复，但未引入节流（按 plan 不过度设计）。
- T-02 adapter maxTokens 参数变更 — additive，fallback 默认 1024 未变，既有 21 case 全绿。

## Known Stubs

无。本 plan 全部 UI 路径接入真实 store + Dexie + crypto + adapter：
- SettingsPage CRUD 走 useGateways/useCreateGateway/useUpdateGateway/useDeleteGateway + db.gateways + localStorage cipher
- TestConnectionButton 走 testGatewayConnection → anthropicAdapter/openaiCompatibleAdapter（与 runRound 同一 adapter 路径，无 mock 桩）
- NewRoomPage Model Select 完全替换 P02 transitional `MODEL_OPTIONS`，agent 创建走真实 `gatewayId: draftGatewayId`

## Self-Check: PASSED

- src/styles/globals.css — FOUND (modified, 5 new CSS vars)
- tailwind.config.ts — FOUND (modified, 5 new color mappings)
- src/components/shared/StatusPill.tsx — FOUND (created)
- src/lib/gateway-test.ts — FOUND (created)
- src/components/gateway/{GatewayCard,GatewayFormModal,TestConnectionButton,DeleteGatewayModal}.tsx — FOUND (created)
- src/app/pages/SettingsPage.tsx — FOUND (created)
- src/stores/gateways.ts — FOUND (created)
- src/components/layout/Sidebar.tsx / src/app/router.tsx — FOUND (modified, /settings + footer NavLink)
- src/components/agent/AgentConfigCard.tsx / src/app/pages/NewRoomPage.tsx — FOUND (modified, gatewayName subtitle + gateway select)
- src/services/gateway-adapters.ts — FOUND (modified, maxTokens param additive)
- src/components/ui/TextInput.tsx — FOUND (modified, help prop additive)
- tests/unit/settings-store.test.ts — FOUND (created, 12 cases)
- Commits: aad25e2 (Task 1)、e664ef6 (Task 2 RED)、63d2840 (Task 2 GREEN)、0e57a44 (Task 3) — FOUND in `git log --oneline`
