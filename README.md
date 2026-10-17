# CouncilKit

**本地优先的多 Agent 决策产品**

CouncilKit 组织本地、结构化的多 Agent 讨论：用户创建 Room、加入可复用 Agent、运行多轮讨论，由显式指定的 Facilitator 生成可持久化的决策报告。所有模型执行都经过本机前台运行的 Runtime Host（`http://127.0.0.1:43127`），浏览器不直接调用模型供应商。

## 快速开始（60 秒）

### 前置条件

- **macOS 或 Linux**。`councilkit init` / `review` / `ideate` / `apply` / `fix` 在两者上都能跑。Host 的 launchd 安装脚本只覆盖 macOS，见 [Runtime Host 运维](docs/host-operations.md)。
- **Node.js 22.22.2 或更新**。根 `package.json` 的 `engines`、`.npmrc` 的 `engine-strict`、CLI 与 Host 的启动门禁写的是同一个下限 `>=22.22.2`。锁文件里的 jsdom 30 要求 `^22.22.2 || ^24.15.0 || >=26`：22.22.2 及以上的 22、24.15.0 及以上的 24，以及 26 可以安装；23、25 和早于 24.15.0 的 24 仍会被 jsdom 拒绝。CI 覆盖 22、24、26。低于 22.22.2 时，安装和 Host 启动会拒绝，并写出要升级到的版本。

  ```bash
  nvm install 22.22.2 && nvm use 22.22.2
  ```

  也可以从 [nodejs.org](https://nodejs.org) 下载 22.22.2 或更新的 LTS。
- **pnpm 10.34.6**。版本必须和根 `package.json` 的 `packageManager` 一致（`pnpm@10.34.6`）：

  ```bash
  npm install -g pnpm@10.34.6
  ```
- **至少一个已登录的本机 CLI**。`councilkit init` 会为每个已知 driver 打印是否找到、路径、版本，以及能不发起登录就检查到的登录状态；缺的或未登录的各给一句下一步。没建成的默认席位会写明，例如 `未创建席位 review-security：未找到 cld（安装后重新运行 init）`，并记在 Council 的 `skippedSeats` 里。
  - `cld`：Claude 包装器。route 是 `ant`、`moonshot`、`deepseek`、`cfuse`。`cfuse` 是 `cld` 的一条 route，不是 `cld` 本身；这条 route 通过环境变量 `CLD_CFUSE_BIN` 执行 `cfuse-claude-code`。PATH 上如果只有 `cfuse-claude`，也会把它当作这个后端。把名为 `cld` 的可执行文件放到 PATH 上，然后运行 `cld login`。CouncilKit 不附带 `cld`。
  - 独立的 `cfuse` CLI（`cfuse -p "…" --output-format text --skip-update`）在没有 `cld` 时，会被 `init` 收成 `review-security` 席位。Host 里的长会话仍然需要 `cld`。
  - Codex CLI：`npm install -g @openai/codex`，然后 `codex login`。
  - `kimi` CLI：安装到 PATH（也会查 `~/.kimi-code/bin`），然后 `kimi login`。
  - `grok` CLI：安装到 PATH（也会查 `~/.grok/bin`），然后 `grok login`。
  - `cursor-agent`：`curl https://cursor.com/install -fsS | bash`，然后 `cursor-agent login`（或设置 `CURSOR_API_KEY`）。

认证统一为 `installation-managed`：本机 Runtime Installation 自行解析凭据，CouncilKit 从不读取或存储 API Key。

### 启动

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start  # 启动 Runtime Host 在 http://127.0.0.1:43127
```

用 Chromium 打开 `http://127.0.0.1:43127`：

1. **Settings** → 检查 Host 可用且至少一个 Runtime Installation 处于 trusted
2. **Execution Profiles** → 创建两个或更多 Profile（例如基于 `claude-stream-json` 与 `kimi-stream-json`）
3. **Agents** → 创建两个 Agent，各自绑定一个 Profile 并选择 `modelId`
4. **New Room** → 选择 Agent、确认发言顺序、显式指定 Facilitator、可选填写目标输出与最大轮次
5. **开始新一轮** → Facilitator 给出焦点方向，Participant 依次发言，Facilitator 生成 Round Summary
6. 收敛后查看并导出 **决策报告**（九段结构化 Markdown）

全程不需要复制任何 secret。

## CLI 快速开始（浏览器可关）

`councilkit` CLI 让 coding agent 或脚本在**浏览器关闭**时也能管理 Agent/Council、发起多 Agent 多轮讨论并拿到 Markdown 报告。CLI 与浏览器**数据不互通**（独立本地存储）。

```bash
# 构建 CLI（需要先 pnpm install）
pnpm build:cli

# 一键写入默认审查班子（不经 Host；自动发现本机 CLI）
pnpm exec councilkit init --json

# 审查 PR（自主并行：N 个全能力 agent 独立审查 → Aggregator 汇总）
pnpm exec councilkit review <pr-url> --json

# Host 运行时打开报告页
# http://127.0.0.1:43127/reports/<run-id>

# 完整审查 → 修复 → 复审流程
pnpm exec councilkit fix --run <ck-review-id> --json
pnpm exec councilkit apply --run <ck-review-id> --json
pnpm exec councilkit review <url> --against <ck-review-id> --json

# 产品创意讨论（受限只读，不修改项目）
pnpm exec councilkit ideate "一句话创意" --json
```

详细命令与选项见 `councilkit --help` 或 **[CLI 手册](docs/cli-handbook.md)**。

## 端口被占用？

Runtime Host 只绑定 `http://127.0.0.1:43127`，端口被占用时启动会失败并退出，origin 永不迁移。定位占用进程：

```bash
lsof -nP -iTCP:43127 -sTCP:LISTEN
```

结束占用进程后重新 `pnpm start`。

## 验证与测试

```bash
pnpm typecheck   # 四个 tsc 程序：app、runtime-host、integration、cli
pnpm lint        # Biome
pnpm test        # Vitest 全量（unit + host + integration）
pnpm test:e2e    # Playwright，仅 Chromium，先构建再启动真实 Host
```

真实 CLI 冒烟（需要本机 `cld`/Codex 已登录）：

```bash
pnpm exec tsx tests/smoke/live-runtime-smoke.ts --route all
```

**注意**：真实冒烟与 `pnpm test` 不得并发运行（两者都会占用固定端口与真实 CLI 资源）。

## 文档导航

### 核心概念与设计
- **[领域词汇与边界](CONTEXT.md)** — 术语权威定义（Runtime Host、Council、Reporter、Autonomous Run 等）
- **[Runtime Host 设计](docs/runtime-host-design.md)** — 本地模型执行边界的详细设计
- **[架构决策记录 (ADR)](docs/adr/)** — 关键架构决策与历史背景
- **[产品文档](docs/product.md)** — 产品定位与功能概述

### 操作手册
- **[CLI 手册](docs/cli-handbook.md)** — 完整命令参考、退出码、认证模型、审查流程
- **[Runtime Host 运维](docs/host-operations.md)** — 启动、launchd 托管、诊断、端口管理
- **[报告页与账本](docs/report-page.md)** — 审查报告查看、finding 决策、修复流程

### Coding Agent 指南
- **[AGENTS.md](AGENTS.md)** — Coding agent 的最短路径与硬约束

### 开发参考
- **[技术设计](docs/technical-design.md)** — 架构概览
- **[验证记录](docs/verification/)** — 功能验收与测试记录
- **[Brainstorms](docs/brainstorms/)** — 功能需求与设计讨论
- **[设计文档](docs/design/)** — 详细设计方案
- **[文档索引](docs/INDEX.md)** — 完整文档目录与阅读指南

## 关键约束

- **macOS 或 Linux**（CLI）。launchd 托管 Host 的脚本是 macOS
- **Node.js 22.22.2 或更新**（与 `engines`、安装门禁、Host 门禁相同）
- **pnpm 10.34.6**（与 `packageManager` 相同；`npm install -g pnpm@10.34.6`）
- **Runtime Host 必须运行**（除 Autonomous Run（`review`/`ideate`/`apply`/`fix`/`repair`）与本地存储命令（`init`/`agent`/`council`/`jury`/`runs`/`findings`）外）
- **CLI 与浏览器数据不互通**
- **单一 canonical origin**：`http://127.0.0.1:43127`，永不迁移
- **Reporter/Facilitator 必填**，不静默 fallback
- **Council 人数** ≤ 8
- **凭据不落盘**：只存进程内存

## 管理面

- **房间管理**：Room 列表支持删除、重命名、复制（携带配置，不带历史）
- **Agent 资产**：启用/停用、JSON 导入导出、就绪握手验证
- **用量可见性**：每轮 Model Execution 记录 usage（input/output tokens）

## 快捷键

- **⌘/Ctrl + Enter**：发送当前输入 / 开始新一轮
- **Esc**：关闭当前弹窗

## License

MIT
