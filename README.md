# CouncilKit

Local-first rooms for multi-agent decisions.

CouncilKit 组织本地、结构化的多 Agent 讨论：用户创建 Room、加入可复用 Agent、运行多轮讨论，由显式指定的 Facilitator 生成可持久化的 Round Summary。浏览器从不直接调用模型供应商——所有模型执行都经过本机前台运行的 Runtime Host，Host 不可用时没有 browser-direct fallback。

## 前置条件

- macOS（V1 仅支持 macOS）。
- Node.js **22**（精确主版本；Runtime Host 启动时校验，其他主版本会以结构化错误拒绝启动并退出）。
- pnpm。
- Chromium（仅 `pnpm test:e2e` 需要）。
- 至少一个已安装并登录的本机 CLI：
  - `cld`（Runtime Driver `claude-stream-json`，支持 `cld ant glm5.2` / `cld moonshot` / `cld deepseek` / `cld cfuse` 四条 route；`cld cfuse` 经 `cfuse-claude-code` 后端透传，不依赖 `claude` binary）。
  - Codex CLI（Runtime Driver `codex-app-server`，即官方 `codex app-server`）。
  - 本地 `kimi` CLI + coding plan 登录（Runtime Driver `kimi-stream-json`，模型 `kimi-code/k3`，发现路径含 `~/.kimi-code/bin`）。

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
2. 在 **Execution Profiles** 段创建两个或更多 Profile（例如一个基于 `claude-stream-json`（含 cfuse route），一个基于 `codex-app-server` 或 `kimi-stream-json`）。
3. 在 **Agents** 段创建两个 Agent，各自绑定一个 Profile 并从该 Driver 的闭集目录选择 `modelId`。
4. 进入 **New Room**，选择这两个 Agent、确认发言顺序并显式指定 Facilitator；可选填写「目标输出（targetOutput）」与「最大轮次（maxRounds，留空=不限）」，并选择讨论模式（brainstorm / planning / review，只影响引导方式与报告侧重，不改执行规则）。创建 Room。
5. 在 Room 页面点击 **开始新一轮**（首次为「发起讨论」）：Facilitator 先给本轮焦点方向，两个 Participant 依次发言，Facilitator 生成 Round Summary。
6. 收敛后查看并导出 **决策报告**（详见下节）。

全程不需要复制任何 secret。

## 决策报告流程

新 Room 可选三种 **讨论模式**（brainstorm / planning / review）与「目标输出」「最大轮次」。每轮的结构固定（不改执行规则，只改 Facilitator 引导与报告章节侧重）：

1. **Facilitator focus**（第 0 环）：Facilitator 先给出本轮探索方向 / 规划目标 / 评审维度。
2. **依次发言**：各 Participant 按确认顺序独立发言、可相互挑战与补充。
3. **Round Summary**：Facilitator 生成本轮总结，末行投出收敛投票（`收敛建议：是` / `收敛建议：否`）。

**收敛与报告**：当 Facilitator 投「是」且已至少完成一轮，或已达 `maxRounds`，房间自动生成九段 **决策报告**（背景 / 讨论目标 / 参与者 / 讨论摘要 / 关键共识 / 剩余分歧 / 建议 / 风险与异议 / 后续行动），房间进入 **concluded** 只读态。报告支持查看、复制 Markdown、下载 `<topic>-report.md`。concluded 后若想继续讨论，走「复制房间」——配置携带，历史不带。手动路径同样存在：在 Room 页面点击「总结并结束」可立即触发报告生成。

**轮间追问**：两轮之间可直接发送用户消息（先入上下文，再开新一轮）；运行中发送会弹确认（中断当前生成）。

### 端口被占用

Runtime Host 只绑定 canonical origin；端口被占用时启动会以结构化错误失败并退出，origin 永不迁移。定位占用进程：

```bash
lsof -nP -iTCP:43127 -sTCP:LISTEN
```

结束占用进程后重新 `pnpm start`。

## CLI（命令行，浏览器关闭时也能用）

`councilkit` CLI 让 coding agent 或脚本在**浏览器关闭**时也能查看模型、管理 Agent/Council、发起多 Agent 多轮讨论并拿到 Markdown 报告。CLI 与浏览器**数据不互通**：它有自己的本地存储（`~/.config/councilkit/`），不读写浏览器的 Dexie 数据。

### 构建与安装

CLI 是 `cli/` workspace 包，bin 是 `cli/bin/councilkit.mjs` thin launcher → 构建产物 `cli/dist/main.mjs`。`pnpm install` 后需构建一次：

```bash
pnpm install --frozen-lockfile
pnpm build:cli           # 单独构建 CLI（根 pnpm build 也会构建它）
pnpm exec councilkit --help
```

### Host 必须运行，浏览器可关

CLI 不 spawn Runtime Host，也不直连模型供应商——所有执行仍经过本机前台运行的 Runtime Host（与浏览器共用同一个 `http://127.0.0.1:43127`）。所以先 `pnpm start`（或 `pnpm dev`）让 Host 跑起来，再开 CLI；浏览器可以关。Host 不可达时 `doctor`/`run` 以退出码 3 失败，CLI 永不自动拉起 Host。CLI 只保证与**同 checkout** 的 Host 互通（版本绑定）。

### 命令

```bash
councilkit doctor [--json]                              # Host 可达性 + installations + catalog 摘要
councilkit models [--json]                             # 当前可用 driver/route/model 闭集（实时 catalog）
councilkit agent create \
  --name <name> --persona-prompt <text> \
  --driver-id <claude-stream-json|codex-app-server|kimi-stream-json> \
  --options '<json>' --model-id <id> --color <#rrggbb> [--disabled] [--json]
councilkit agent list|show <name|id>|delete <name|id> [--json]

councilkit council create \
  --name <name> --topic <text> [--background <text>] [--target-output <text>] \
  --agents '<["ref1","ref2"]>' --rounds <N> --reporter <ref> [--json]
councilkit council list|show <name|id>|delete <name|id> [--json]

councilkit run --council <name|id> [--rounds N] [--out path] [--json]
councilkit run --agents '<["ref1","ref2"]>' --topic <text> --reporter <ref> \
  [--background <text>] [--target-output <text>] [--rounds N] [--out path] [--json]

councilkit review --agents '<["ref1","ref2"]>' --aggregator <ref> \
  (--pr <url|number> | --task "<text>") [--focus "<text>"] \
  [--timeout 30m] [--concurrency 3] [--out path] [--json]
councilkit review --council <name|id> \
  (--pr <url|number> | --task "<text>") [--focus "<text>"] [--timeout 30m] [--concurrency 3] [--out path] [--json]
```

- `--agents` 用 JSON 数组（不是逗号分隔），避免名字含逗号/空格歧义。
- **Reporter 必填**：Council 必须显式指定一个 reporter agent（且在 agents 中），不静默 fallback。
- 讨论固定 N 轮（`council.rounds`，`--rounds` 覆盖），每轮各 agent 按序发言一次；N 轮后 Reporter 做一次最终总结调用，产出九段 Markdown 报告（与浏览器报告同章节集）。
- `--json`：进度/诊断全走 stderr，stdout 只出一个最终 JSON 文档。

#### `councilkit review` — 自主并行审查（不经 Host）

同一任务由 N 个全能力 agent（Attempt）在**隔离空 cwd**（`runs/<run-id>/workspaces/<attemptId>/`）中独立并行做一遍，再由 Aggregator 对比汇总，产出 `report.md`（确定性头部 + 五章节聚合正文 + `## Appendix: per-attempt outputs`）+ `transcript.jsonl`。

- **不经 Runtime Host**：CLI 直接按 PATH 解析 `cld`/`kimi`/`codex` 并 spawn，绕过 scope/SSE/ACK。claude 仅支持 `cld cfuse` 路由（其它 route 直接 usage 报错）；kimi 用 `-p`（无 `--auto`，自主权限由 config 提供）；codex 用 `exec -s workspace-write --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`。
- **信任模型**：全能力 + auto-approve + 隔离 cwd。子进程以**用户本人权限**运行、继承正常用户环境，**信任级等同于你亲手敲这条命令**。不可信 PR = PR 代码会被执行（测试/lint/构建），与 CI 同级风险，你用一条命令显式发起即视为知情同意。替代 permission flow 的不是策略引擎，而是「隔离 cwd + 用户同级信任 + 显式发起」三件套。
- `--agents ... --aggregator <id>`：agentIds→Attempts、aggregator∈agents；`--council <ref>`：`council.agentIds`→Attempts、`council.reporterAgentId`→Aggregator、`council.rounds` 忽略、`council.topic` 注入任务模板。Aggregator 自身也先跑一遍 Attempt（其 findings 进对比），再做一次聚合 spawn。
- 失败 tolerate：单 Attempt 失败不重试，进入 `attemptFailures`，其余继续、聚合照常；全失败 → 不聚合、确定性失败报告、exit 4；聚合失败 → INCOMPLETE 报告 + exit 4；SIGINT → 尽力落盘、exit 130。`--timeout` 形如 `30m|600s|1h|5000ms`，`--concurrency` 默认 `min(3, N)`。

### 报告位置与凭据生命周期

- 报告与 transcript 默认在 `runs/<run-id>/`（`report.md` + `transcript.jsonl`）；`--out` 再原子复制一份到用户路径。`report.md` 始终保留（部分报告在 run 失败时也写盘并标注 `INCOMPLETE`）。
- 凭据（session cookie + CSRF）只存活于 CLI 进程内存，Host 重启后自动重取一次；**不落盘**、不出现在 `agents.json`/`councils.json`/transcript/报告/日志/`--json` 输出中。
- `agents.json`/`councils.json` 不含 `installationId`/凭据——installation 每次 run/doctor/models 实时从 Host 解析（`state=trusted` 且 driverId 匹配；多个时取 Host 顺序第一个）。

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 用法 / schema / 引用 / 校验（reporter 必填、悬空引用等） |
| 3 | Run 开始前 Host 不可达 / 认证 / installation / readiness 不可用 |
| 4 | Run 执行失败（turn / Reporter / ACK / SSE / Host 重启 / cleanup） |
| 5 | 本地 store / report IO |
| 7 | Host 配额拒绝 |
| 130 | SIGINT（先做有界 cleanup，再退出） |

### 端口独占

`run` 的 live smoke 与浏览器/Host 共用 43127，且要求独占串行（不可与 vitest/playwright 并发）。端口被占用时用 `lsof -nP -iTCP:43127 -sTCP:LISTEN` 定位；CLI 不 kill 任何非自身进程。

## 后台托管（launchd，macOS）

前台 `pnpm start` 之外，可以把 Runtime Host 交给 launchd 托管：登录后自动启动、崩溃自动拉起（KeepAlive，限频 10 秒）。先确保已 `pnpm build`（托管入口是 `dist-host/main.mjs`），然后：

```bash
node scripts/install-service.mjs            # 写入 plist（--dry-run 只打印不写盘）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.councilkit.host.plist
```

安装脚本只写 `~/Library/LaunchAgents/com.councilkit.host.plist`，**绝不代为 load**——上面的 `bootstrap` 需要你显式执行（旧版 macOS 用 `launchctl load -w`）。plist 把 Node 路径固定为运行脚本时的解释器，并注入常见 PATH 以保住 CLI 发现；**更换 Node 版本或移动仓库目录后必须重跑安装脚本**。托管后端口被占时会结构化退出、由 launchd 每 10 秒重拉，先用 `lsof`（见上节）排查占用。

验证托管生效：`launchctl list | grep councilkit` 出现非 `-` 的 PID，`curl http://127.0.0.1:43127/api/v1/health` 返回 200，且 Settings 页 Installations 仍为 trusted。日志在 `~/Library/Logs/CouncilKit/host.out.log` 与 `host.err.log`。

卸载（脚本只删 plist，不代为 unload、不删日志）：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.councilkit.host.plist
node scripts/uninstall-service.mjs
```

### 诊断包

排查 Host 问题时，在 **Settings → Host** 段点击「导出诊断包」，下载单个 JSON 文件（也可 `GET /api/v1/diagnostics`，session 鉴权）。内容：Host 健康信息与 Driver 状态、Installations（state/detail）、Scope/Execution 的分类计数、非敏感配置（mode/port/Node 版本/uptime）、最近 50 条 warn/error 结构化日志（已过 sanitize）。

注意：诊断包可能包含本机绝对路径（Installations 的可执行文件 **realpath** 与日志上下文中的路径）——这是本机自诊的必需信息，属同机用户边界，请勿把诊断包发到公开渠道。诊断包**绝不包含** prompt 正文、模型输出、token、Cookie、API Key 或环境变量：入环的 warn/error 日志已对 `token=`、`Cookie:`、`"api_key":` 等秘密形态的**值**统一脱敏为 `[redacted]`。

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

# 单 driver 真实冒烟（kimi CLI；与 --route/--soak 互斥）
TSX_TSCONFIG_PATH=tsconfig.integration.json pnpm exec tsx tests/smoke/live-runtime-smoke.ts \
  --driver kimi-stream-json --rounds 1
```

注意：真实冒烟与 `pnpm test` 不得并发运行（两者都会占用固定端口与真实 CLI 资源）。

## 快捷键

房间页支持两个全局快捷键（弹窗打开时静默）：

- **⌘/Ctrl + Enter**：焦点在发言框 → 发送当前输入；其他焦点 → 开始新一轮（首次为「发起讨论」）。发送复用发言框既有校验（内容非空、未禁用），不会绕过门控。
- **Esc**：关闭当前弹窗（既有行为，由弹窗组件自身处理）。

## 架构

- 调用链：RoomPage → 持久化 Discussion Orchestrator → Runtime Client → Runtime Host → Participant Driver 进程。UI 不拥有 Round 生命周期；Host 不理解 Room/Round 语义。
- Dexie `councilkit-runtime-v1` 是讨论的唯一事实源（Room/Round/Message/Summary/ModelExecution/DecisionReport）；CLI thread/process 只是可丢弃的 Execution Session 缓存。
- Message/Summary 使用 persist → ACK 幂等提交：先 Dexie 事务成功，再 ACK Host；同一 `executionId` 的完成事件重放不会重复落库。
- Web Lock + `leaseEpoch` fencing 保证一个 Execution Scope 同时只有一个 Scope Controller 可以执行 Host mutation 与 Dexie 提交；其他标签页只读观察。
- 每个活跃 Participant 保持一个 Driver 实例和隔离的 Execution Session；Claude/Codex 为长期进程，Kimi 为每 turn 短进程 + `-S` 跨进程 resume（ADR-0012）；纯追加轮次只向健康 Session 下发增量 Context Snapshot。
- 页面刷新使用同一 Scope 与 `executionId` 重连事件流，从最后收到的 `eventSeq` 继续，不重新调用模型。
- V1 有三个内置 Runtime Driver：`claude-stream-json`、`codex-app-server`、`kimi-stream-json`；legacy browser-direct Gateway 已在 U7 删除，Runtime Host 是唯一执行路径。

## 管理面

- **房间管理**：Room 列表项支持删除 / 重命名 / 复制（「（副本）」房间携带原配置，不带历史消息，可直接跑完一轮）。
- **Agent 资产**：Agent 支持启用/停用、JSON 导入导出，以及在不进入房间的情况下用所选 Profile + modelId 跑一次「仅验证执行环境」的就绪握手（行内 ready pill，不发实质消息）。
- **用量可见性**：每轮的 Model Execution 记录 `usage`（input/output tokens），以用量 badge 的形式在房间内可见（本机自诊，不上传）。

## Legacy 数据说明

V1 不导入也不删除 legacy 站点数据。旧 origin 的 IndexedDB/localStorage 可能仍包含 legacy credential，CouncilKit 不会读取或迁移它们。如需清理，请在 Chromium 的站点数据设置中删除旧 origin 的数据——CouncilKit 不会自动执行该操作。

## 文档

- [领域词汇与边界](CONTEXT.md)
- [Runtime Host 详细设计](docs/runtime-host-design.md)
- [架构决策记录](docs/adr/)
- [验证记录](docs/verification/)

## License

MIT
