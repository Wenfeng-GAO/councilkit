# Roadmap

> 与 [README](../README.md)、[docs/product.md](product.md)、[CONTEXT.md](../CONTEXT.md) 保持一致（2026-10 更新）。

## 当前状态

CouncilKit 是本地优先的多 Agent 决策工具：浏览器 Web UI + 本机 Runtime Host + `councilkit` CLI。

- **平台**：macOS 支持；Linux 可用（预览）；Windows 请用 WSL2。
- **Driver**：五个内置 Driver：`claude-stream-json`（经内部 `cld`，可选）、`codex-app-server`、`kimi-stream-json`、`grok-stream-json`、`cursor-stream-json`。只调用本机已登录的 CLI，不读取或保存 API Key。
- **技术栈**：React 18 + Vite 5 + TypeScript（strict）+ Tailwind 3 + React Router 6 + Zustand + TanStack Query + Dexie.js/IndexedDB；早期的 SwiftUI / macOS 原生方向已否决（CR1，2026-06-24）。

已交付：

- **CLI / Autonomous Run**：`review`（多 agent 并行审查 + Aggregator 汇总、规格合同绑定）、`fix` / `apply` / `repair`（审查 → 修复 → 复审）、`ideate`（只读创意讨论）、`demo`（无账号示例报告）、`init` / `doctor` / `runs` / `findings`。
- **报告页**：浏览器直接读 CLI 运行记录，查看报告、对 finding 做决策。
- **浏览器讨论**：三模式（头脑风暴 / 规划 / 评审）；每轮 Facilitator 焦点 → 依次发言 → Round Summary；收敛投票 + maxRounds 自动生成九段决策报告，复制 / 下载。
- **执行基座**：Runtime Host、Scope 租约与 `leaseEpoch` fencing、session + CSRF 鉴权、canonical origin 固定。
- **可靠性与运维**：失败重试 / 跳过、needs_rebase 轮转、idle 回收与「释放运行时」；macOS launchd 后台托管、诊断包导出。

质量门：CI 在 Linux + macOS 上跑 `pnpm lint`、`pnpm typecheck`（四个 tsc 程序：app、runtime-host、integration、cli）、`pnpm build`、单元测试，以及无账号的示例路径冒烟。

开放项：

- launchd 崩溃自动拉起仍待用户侧验证；Linux 上没有对应的后台托管，请前台运行。
- 关闭标签页会中断浏览器里正在生成的决策报告（编排目前在浏览器里，计划移到 Host）。
- Playwright 端到端测试尚未进 CI。

## 下一步

- 报告生成 / 提交的编排从浏览器移到 Host，关页不丢结果。
- `npx` 一行安装；Linux 正式支持。
- PDF 导出、Room 模板、报告版本历史。
- 盲评（per-participant 快照过滤，见 ADR-0010）。
- 协议级 lease 心跳续约。

## 更远

- Discussion 过程可视化、关键分歧追踪、可复用的 Facilitator 策略、Agent 回应质量评分。
- 多端同步、团队协作、云端房间、Agent 市场、自动化讨论工作流。

## 历史

V1 验收记录（2026-07）见 `docs/verification/2026-07-18-decision-core-acceptance.md`；2026-06 MVP 原始规划见 [docs/history/2026-06-product-mvp-plan.md](history/2026-06-product-mvp-plan.md)。
