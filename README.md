# CouncilKit

Local-first rooms for multi-agent decisions.

CouncilKit 组织本地、结构化的多 Agent 讨论：用户创建 Room、加入可复用 Agent、运行多轮讨论，由显式指定的 Facilitator 生成可持久化的 Round Summary。浏览器从不直接调用模型供应商——所有模型执行都经过本机前台运行的 Runtime Host，Host 不可用时没有 browser-direct fallback。

## 前置条件

- macOS（V1 仅支持 macOS）。
- Node.js **22**（精确主版本；Runtime Host 启动时校验，其他主版本会以结构化错误拒绝启动并退出）。
- pnpm。
- Chromium（仅 `pnpm test:e2e` 需要）。
- 至少一个已安装并登录的本机 CLI：
  - `cld`（Runtime Driver `claude-stream-json`，支持 `cld ant glm5.2` / `cld moonshot` / `cld deepseek` 三条 route）。
  - Codex CLI（Runtime Driver `codex-app-server`，即官方 `codex app-server`）。

认证统一为 `installation-managed`：本机 Runtime Installation 自行解析凭据，CouncilKit 从不读取或存储 API Key，也不提供 browser-direct fallback。

## 快速开始

```bash
pnpm install
pnpm build
pnpm start
```

`pnpm start` 以生产模式在固定 canonical origin **http://127.0.0.1:43127** 启动前台 Runtime Host，同时提供构建后的 Web UI 与同源 `/api/v1`。开发模式使用 `pnpm dev`（经 Vite 中间件，同一 origin）。

用 Chromium 打开 `http://127.0.0.1:43127`，然后：

1. 打开 **Settings**，按「Host → Installations/登录能力 → Execution Profiles → Agents」四段检查：Host 可用，且至少一个 Runtime Installation 处于 trusted、对应 Driver 显示 ready。
2. 在 **Execution Profiles** 段创建两个 Profile（例如一个基于 `claude-stream-json`，一个基于 `codex-app-server`）。
3. 在 **Agents** 段创建两个 Agent，各自绑定一个 Profile 并从该 Driver 的闭集目录选择 `modelId`。
4. 进入 **New Room**，选择这两个 Agent、确认发言顺序并显式指定 Facilitator，创建 Room。
5. 在 Room 页面点击 **开始新一轮**：两个 Participant 依次发言，Facilitator 生成 Round Summary。

全程不需要复制任何 secret。

### 端口被占用

Runtime Host 只绑定 canonical origin；端口被占用时启动会以结构化错误失败并退出，origin 永不迁移。定位占用进程：

```bash
lsof -nP -iTCP:43127 -sTCP:LISTEN
```

结束占用进程后重新 `pnpm start`。

## 验证命令

```bash
pnpm typecheck   # 三个 tsc 程序：app、runtime-host、integration
pnpm lint        # Biome
pnpm test        # Vitest 全量（unit + host + integration）
pnpm test:e2e    # Playwright，仅 Chromium，先构建再启动真实 Host
```

真实 CLI 冒烟（需要本机 `cld`/Codex 已登录）：

```bash
pnpm exec tsx tests/smoke/live-runtime-smoke.ts --route all
```

注意：真实冒烟与 `pnpm test` 不得并发运行（两者都会占用固定端口与真实 CLI 资源）。

## 架构

- 调用链：RoomPage → 持久化 Discussion Orchestrator → Runtime Client → Runtime Host → Participant Driver 进程。UI 不拥有 Round 生命周期；Host 不理解 Room/Round 语义。
- Dexie `councilkit-runtime-v1` 是讨论的唯一事实源（Room/Round/Message/Summary/ModelExecution）；CLI thread/process 只是可丢弃的 Execution Session 缓存。
- Message/Summary 使用 persist → ACK 幂等提交：先 Dexie 事务成功，再 ACK Host；同一 `executionId` 的完成事件重放不会重复落库。
- Web Lock + `leaseEpoch` fencing 保证一个 Execution Scope 同时只有一个 Scope Controller 可以执行 Host mutation 与 Dexie 提交；其他标签页只读观察。
- 每个活跃 Participant 保持一个长期 Driver 进程和隔离的 Execution Session；纯追加轮次只向健康 Session 下发增量 Context Snapshot。
- 页面刷新使用同一 Scope 与 `executionId` 重连事件流，从最后收到的 `eventSeq` 继续，不重新调用模型。
- V1 只有两个内置 Runtime Driver：`claude-stream-json` 与 `codex-app-server`；legacy browser-direct Gateway 在目标路径不可达，将在 U7 删除。

## Legacy 数据说明

V1 不导入也不删除 legacy 站点数据。旧 origin 的 IndexedDB/localStorage 可能仍包含 legacy credential，CouncilKit 不会读取或迁移它们。如需清理，请在 Chromium 的站点数据设置中删除旧 origin 的数据——CouncilKit 不会自动执行该操作。

## 文档

- [领域词汇与边界](CONTEXT.md)
- [Runtime Host 详细设计](docs/runtime-host-design.md)
- [架构决策记录](docs/adr/)
- [验证记录](docs/verification/)

## License

MIT
