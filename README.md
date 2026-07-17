# CouncilKit

Local-first rooms for structured multi-agent decisions.

CouncilKit 让用户创建 Room、加入可复用 Agent、运行多轮讨论、指定 Facilitator，并生成可持久化的 Summary 与 Markdown 结果。产品重点不是自由聊天，而是有主题、参与者、轮次、恢复边界和收敛结果的结构化决策过程。

## Architecture Status

Runtime Host 目标架构已经确认，可以进入实现；当前仓库代码仍是 legacy 纯浏览器 Gateway 版本，尚未完成迁移。实现完成前，请区分：

- **目标架构**：前台本地 Runtime Host + React UI + Dexie Discussion Orchestrator。
- **当前实现**：Vite 页面直接调用 HTTP Gateway，仍包含旧 Gateway/API Key 数据模型。

新的架构与领域真源：

- [领域词汇与边界](CONTEXT.md)
- [Runtime Host 详细设计](docs/runtime-host-design.md)
- [架构决策记录](docs/adr/)

早期 VibeSpec 文档描述的是 legacy pure-client 方案，保留为实现历史，不再覆盖以上 Runtime Host 决策。

## Target V1

- macOS-only；讨论数据默认只在本机持久化，执行时选定的 Context Snapshot 会发送给对应模型服务商。
- 用户主动启动一个 Node.js/TypeScript 前台 Runtime Host；不安装 LaunchAgent，不引入 Tauri/Electron。
- Host 使用固定 loopback origin，同时提供构建后的 React UI 与 `/api/v1`。
- Discussion Orchestrator 在浏览器中负责 Room、Round、Participant、上下文、Summary 和 Dexie 持久化。
- 每个活跃 Participant 保持一个长期 Driver 进程和隔离的 Execution Session。
- V1 只有两个 Runtime Driver：
  - `claude-stream-json`：`cld ant glm5.2`、`cld moonshot`、`cld deepseek`
  - `codex-app-server`：官方 `codex app-server`
- Agent 固定绑定 `executionProfileId + modelId`；Participant 保存加入 Room 时的配置快照。
- 认证使用 `installation-managed`：本地 Installation 自行解析凭据，CouncilKit 不保存 API Key。
- 页面刷新可以重连正在执行的模型调用，Message 和 Summary 使用 `persist → ACK` 幂等提交。
- 生产执行不保留 Gateway/browser-direct fallback。

## Target Stack

- Runtime Host: Node.js 22, TypeScript, loopback HTTP JSON + authenticated fetch event stream
- UI: React 18, Vite 5, React Router 6, Tailwind CSS 3
- Client state: Zustand + TanStack Query
- Persistence: IndexedDB via Dexie.js
- Runtime protocols: Claude stream-json and Codex app-server JSONL
- Quality: Biome, Vitest, Playwright

## Product Principles

1. Local-first persistence: Room、Agent、Message、Summary 和报告默认只在本机持久化；模型执行仍会发送选定上下文，Codex 工具还可能按本地配置访问额外数据。
2. Structured: 每次讨论有明确主题、Participant 顺序、Facilitator、Round 和结束状态。
3. Recoverable: 页面刷新、流连接中断和 Driver 崩溃从持久化边界恢复。
4. Replayable: 完整 Message 是事实源，CLI thread/session 只是可丢弃缓存。
5. Interruptible: 用户可以暂停、补充上下文、重试、接管或结束讨论。
6. Focused V1: 不做云同步、团队协作、移动端、Runtime 市场或任意命令执行 Profile。

## Repository Status

现有 legacy 实现已经覆盖基础 Room、Agent、顺序发言和 Summary 页面流程，但其编排主要驻留内存，Gateway 由浏览器直连，数据模型也还没有 Participant、ModelExecution、幂等 execution 或可恢复 Round 游标。

下一阶段工作是按 [Runtime Host 设计](docs/runtime-host-design.md) 完成：

1. Dexie schema 与 legacy 数据迁移。
2. 固定 origin Runtime Host、loopback 安全和 Scope API。
3. `claude-stream-json` Driver。
4. `codex-app-server` Driver。
5. 可恢复 Round 状态机、事件重连和 `persist → ACK`。
6. 两个 Driver 的真实 smoke、故障恢复与长期运行验收。

## Development

当前代码仍通过 Vite 启动：

```bash
pnpm install
pnpm dev
```

验证命令：

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm build
```

在 Runtime Host 实现落地前，`pnpm dev` 仍运行 legacy browser-direct 路径；不要把它视为目标生产启动方式。

## Historical Documents

- [VibeSpec PRD](docs/vibespec/councilkit/PRD.md)
- [VibeSpec DESIGN](docs/vibespec/councilkit/DESIGN.md)
- [VibeSpec TECH](docs/vibespec/councilkit/TECH.md)
- [VibeSpec tasks](docs/vibespec/councilkit/TASKS.md)
- [Product document](docs/product.md)
- [Technical design](docs/technical-design.md)
- [Roadmap](docs/roadmap.md)

这些文件可能仍包含 SwiftUI、pure-client Gateway 或 API Key 方案；发生冲突时，以 `CONTEXT.md`、Runtime Host 设计和 ADR 为准。

## License

MIT
