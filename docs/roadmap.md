# Roadmap

## Current Status

V1 已交付并完成全量验收。CouncilKit 是一个 local-first、纯客户端的 Web 应用，通过本机前台运行的 Runtime Host 统一获得模型执行能力，组织结构化多 Agent 讨论并产出可持久化的决策报告。

技术栈注记：早期规划中的 SwiftUI / macOS 原生方向已在 TECH.md 确认阶段否决（CR1，2026-06-24 复确），实际交付为 **React 18 + Vite 5 + TypeScript（strict）+ Tailwind 3 + React Router 6 + Zustand + TanStack Query + Dexie.js/IndexedDB**，纯客户端浏览器运行；模型执行经同源本机 **Runtime Host**（双 Driver：`claude-stream-json`、`codex-app-server`）。

V1 已交付物：

- **执行基座**：双 Driver 切流的 Runtime Host；Session/Scope 租约与 `leaseEpoch` fencing；浏览器风格的 session + CSRF 鉴权；canonical origin 固定。
- **决策内核**：三模式讨论（brainstorm / planning / review）；每轮 Facilitator focus → 依次发言 → Round Summary；收敛投票 + maxRounds 双触发的自动决策报告；九段 Markdown 报告与复制 / 下载。
- **可靠性**：失败可重试 / 跳过（Facilitator 不可跳过）；needs_rebase 一键轮转；探针 60s 缓存；profile 快照/rename lease；idle TTL 自动回收 + 显式「释放运行时」。
- **运维面**：launchd 后台托管（崩溃自动拉起、限频）；诊断包导出（敏感字段脱敏）。
- **管理面**：房间删除/重命名/复制（级联清零、legacy 零读取）；Agent 启停/导入导出/就绪握手测试；用量 badge。
- **体验打磨**：通知/标题/favicon 感知、参与者状态、接管与预检 UI、快捷键、无障碍。

门状态（验收时点）：`pnpm typecheck` 三程序全绿、`pnpm lint` 全绿、`pnpm test`（vitest 全量）全绿、`pnpm test:e2e`（Chromium）40/40 两遍无 flake；**真实冒烟矩阵 `--route all` 3/3 全通**（ant/deepseek 首轮通过；moonshot 外部环境阻塞经直连探测确诊 provider K3 id 二次漂移，cld+本仓映射修复后重跑通过）；soak 跨房间生命周期已验证，**≥15min 持续负载合同由 claude(cld)-facilitator 变体达成（932372ms、15 轮、10 房、不变量全绿）**，codex-facilitator 变体受 codex app-server 长会话边界未决故障外部阻塞（补齐性质），结果见 `docs/verification/2026-07-18-decision-core-acceptance.md`（两个显式开放项：codex-facilitator soak 变体待稳定窗口补齐、launchd 崩溃拉起待用户）。

## V1.1

- PDF 导出（在现有 Markdown 下载之上）。
- Room 模板（从已有房间沉淀可复用配置）。
- 报告版本历史。
- **盲评（per-participant 快照过滤）**：见 ADR-0010 有意推迟的协议级隔离，进入迭代。
- **协议级 lease 心跳续约**：handoff Q1 已立项，将把租约从「页面续租」升级到带心跳的协议级续约，降低长连接接管窗口风险。
- 更多 Provider 选项与更好取消/重试 UX。

## V1.2

- Discussion 过程可视化。
- 关键分歧追踪。
- 可复用的 Facilitator 策略。
- Agent 回应质量评分。

## V2

- 多端同步。
- 团队协作。
- 云端房间。
- Agent 市场。
- 自动化讨论工作流。