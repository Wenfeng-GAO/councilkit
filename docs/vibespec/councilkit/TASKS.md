---
phase: implement
status: in-progress
tech: docs/vibespec/councilkit/TECH.md
created: 2026-06-23
---

# CouncilKit - 实现任务列表

> 本 TASKS.md 由 VibeSpec Phase 4 Step 0a 基于 TECH.md + PRD P0 派生。
> 依赖排序遵循 Phase 4 固定 11 层：脚手架 → 入口/样式 → 类型/数据模型 → 数据层 → 服务/API → 工具函数 → 状态管理 → 布局 → 基础 UI → 页面 → 路由集成 → 质量收尾。
> 本轮端到端验证范围：**T1–T4**（构建 → 入口 → 数据模型 → 数据库层），并在 T4 刻意构造 WIRED 不达标场景以验证 Step 3.1 / Step 3.5 机制。T5–T12 列为后续 task，覆盖剩余 P0。

## 任务概览

- 总任务数: 12
- 本轮执行: T1–T4
- P0 任务: T1–T11（覆盖 R1–R8）
- P1 任务: T12（R9–R12 部分，含 Template）

---

## T1: 构建工具链脚手架

- 前置依赖: 无
- 允许修改范围:
  - `package.json`（新建）
  - `tsconfig.json`（新建）
  - `vite.config.ts`（新建）
  - `biome.json`（新建）
  - `index.html`（新建）
- 预期产出:
  - `package.json`: React18/Vite5/TS5/Tailwind3/Biome1/Dexie4/Zustand4/TanStackQuery5 依赖 + scripts(typecheck/lint/dev/build/test)
  - `tsconfig.json`: strict 模式, paths `@/*` → `src/*`
  - `vite.config.ts`: React 插件 + alias
  - `biome.json`: lint/format 规则
  - `index.html`: Vite 入口挂载 #root
- 验证方式:
  - [ ] `pnpm install` 成功
  - [ ] `pnpm typecheck` 通过（无源文件也应通过）
  - [ ] `pnpm lint` 通过
- 对应需求: 基础设施（支撑全部 P0）

> Scope note: 5 文件，符合 cap。

---

## T2: 应用入口、全局样式与路由骨架

- 前置依赖: T1
- 允许修改范围:
  - `src/main.tsx`（新建）
  - `src/styles/globals.css`（新建）
  - `tailwind.config.ts`（新建）
  - `postcss.config.js`（新建）
  - `src/app/router.tsx`（新建，React Router 占位 4 路由）
- 预期产出:
  - `main.tsx`: ReactDOM 挂载 + RouterProvider + QueryClientProvider
  - `globals.css`: Tailwind 指令 + 深色主题 CSS 变量
  - `tailwind.config.ts`: content 扫描 src，darkMode class
  - `router.tsx`: / , /rooms/new, /rooms/:roomId, /templates 四路由占位组件
- 验证方式:
  - [ ] `pnpm typecheck` 通过
  - [ ] `pnpm lint` 通过
  - [ ] `pnpm build` 通过
- 对应需求: 基础设施

---

## T3: 核心数据模型与校验（Room / Agent / Message）

- 前置依赖: T1
- 允许修改范围:
  - `src/types/index.ts`（新建，共享枚举与 ModelRequest/StreamChunk 契约类型）
  - `src/models/room.ts`（新建）
  - `src/models/agent.ts`（新建）
  - `src/models/message.ts`（新建）
  - `src/models/index.ts`（新建，聚合导出 + 校验函数）
- 预期产出:
  - `types/index.ts`: ModelType(claude/openai/deepseek)、SenderType、RoomStatus、RoundStatus、AgentStatus、ModelRequest、ModelMessage、StreamChunk
  - `room.ts`: Room 接口 + `validateRoom(room): Result`（topic 非空 ≤200，agentIds ≥1）
  - `agent.ts`: Agent 接口 + `validateAgent`
  - `message.ts`: Message 接口 + `validateMessage`（senderType=user 时 senderId 固定 "user"）
  - `models/index.ts`: re-export + `createRoom`/`createAgent`/`createMessage` 工厂（UUID + 时间戳 + 调校验）
- 验证方式:
  - [ ] `pnpm typecheck` 通过
  - [ ] `pnpm lint` 通过
  - [ ] Step 3.1: 工厂函数被 index 导出且引用校验（WIRED）
- 对应需求: R1, R2, R4（数据基座）

> Scope note: 5 文件，符合 cap。Round/Summary/Template(P1) 见 T（后续补）——核心三实体先落地支撑端到端链路。

---

## T4: Dexie 数据库层与模型 service 抽象（本轮 WIRED 验证靶）

- 前置依赖: T3
- 允许修改范围:
  - `src/lib/db.ts`（新建，Dexie schema 定义 + CRUD）
  - `src/services/model-registry.ts`（新建，模型路由 + 调度接口）
- 预期产出:
  - `db.ts`: `class CouncilKitDB extends Dexie`，定义 rooms/agents/messages 表，导出 `db` 单例 + `addRoom`/`getRoom`/`addMessage`/`getMessagesByRound`
  - `model-registry.ts`: `interface ModelService` + `getModelService(model: ModelType)` 注册表（具体实现延后 T5），导出 `dispatchMessage`
- 验证方式:
  - [ ] `pnpm typecheck` 通过
  - [ ] `pnpm lint` 通过
  - [ ] Step 3.1 EXISTS/SUBSTANTIVE/WIRED（本轮刻意构造场景，见验证记录）
- 对应需求: R1, R4, R6, R12（持久化与服务调度基座）

> WIRED 验证靶：本轮第一遍实现将在 `model-registry.ts` 引入一个未接线的 `dispatchMessage` 导出占位（声明但未真正路由到任何实现的 service，且未被任何地方引用），用以验证 Step 3.1 是否能抓到 WIRED=failed 并触发 faultType=unwired-stub。修复后重跑自检应 passed。

---

## T5: 模型 API service 实现（claude/openai/deepseek）

- 前置依赖: T4
- 允许修改范围: `src/services/claude.ts`, `openai.ts`, `deepseek.ts`（新建）
- 验证方式: typecheck/lint + 集成测试 mock（延后）
- 对应需求: R2, R4, R7

## T6: 工具函数（crypto / context / summary / stream）

- 前置依赖: T3, T4
- 允许修改范围: `src/lib/{crypto,context,summary,stream}.ts`
- 对应需求: R5, R8, SC-4（10s 超时）

## T7: 状态管理（Zustand ui/discussion + React Query）

- 前置依赖: T3, T4
- 允许修改范围: `src/stores/{ui,discussion,queries}.ts`
- 对应需求: R4, R6

## T8: 布局组件（AppShell / Sidebar）

- 前置依赖: T2
- 允许修改范围: `src/components/layout/{AppShell,Sidebar}.tsx`
- 对应需求: 基础设施

## T9: 基础 UI 组件

- 前置依赖: T2
- 允许修改范围: `src/components/ui/{Button,TextInput,Textarea,Select,Modal}.tsx`
- 对应需求: 基础设施

## T10: 房间与讨论页面组件

- 前置依赖: T7, T8, T9
- 允许修改范围: `src/components/{room,agent,message}/*`, `src/app/rooms/*`
- 对应需求: R1, R2, R3, R4, R8

## T11: 路由集成与核心流程贯通

- 前置依赖: T5, T6, T7, T10
- 允许修改范围: `src/app/router.tsx`(更新), 页面组件接线
- 对应需求: R1–R8 全 P0 流程

## T12: 质量收尾（响应式 / 深色 / a11y / Template P1）

- 前置依赖: T11
- 允许修改范围: 各组件 polish + `src/models/template.ts`
- 对应需求: R9–R13 (P1/P2)

---

### T1 完成总结

- 完成时间: 2026-06-23T20:05:00Z
- 创建/修改的文件: package.json, tsconfig.json, vite.config.ts, biome.json, index.html, src/vite-env.d.ts, .npmrc
- 自检结果:
  - typecheck ✓ (`./node_modules/.bin/tsc --noEmit` exit 0)
  - lint ✓ (`./node_modules/.bin/biome check src` Checked 1 file, No fixes applied)
  - Step 3.1 MUST-HAVE ✓ (6 files EXISTS/SUBSTANTIVE/WIRED 全 passed)
  - faultType: n/a（自检通过）
- scope note: 6 文件含脚手架固有 vite-env.d.ts，超 3-5 cap 1，记录为 cap vs 脚手架固有文件数的张力。
- 环境发现: pnpm 11 不读 package.json `pnpm` 字段，`pnpm run` 前置 deps-check 与 ignored-builds 冲突阻塞；验证改用 .bin 直调。详见 state.json environmentNotes。

### T2 完成总结

- 完成时间: 2026-06-23T20:20:00Z
- 创建/修改的文件: src/main.tsx, src/app/router.tsx, src/styles/globals.css, tailwind.config.ts, postcss.config.js
- 自检结果（attempt 2 passed）:
  - attempt 1 FAILED, faultType=lint-error: globals.css font-family 多行 + main.tsx import 未排序（2 个 formatter 错误）
  - attempt 2 PASSED: `biome check --write src` 自动修复；typecheck ✓ / lint ✓ / build ✓（81 modules, 673ms）
  - Step 3.1 MUST-HAVE ✓（5 文件 EXISTS/SUBSTANTIVE/WIRED 全 passed；build 产出 CSS 证明 tailwind/postcss wired）
- 机制观察: 真实展示了 faultType=lint-error 分类 + retry 链路；attempt 1 失败未达 Step 3.5 触发条件（consecutiveFailures 仅 1）。
