# CouncilKit

**本地优先的多 Agent 决策产品**

CouncilKit 组织本地、结构化的多 Agent 讨论：用户创建 Room、加入可复用 Agent、运行多轮讨论，由显式指定的 Facilitator 生成可持久化的决策报告。所有模型执行都经过本机前台运行的 Runtime Host（`http://127.0.0.1:43127`），浏览器不直接调用模型供应商。

**适合谁**：已经在用 coding agent（Codex、Kimi、Grok、Cursor 等 CLI）的开发者。用它让几位 AI 一起审 PR、修 PR、讨论产品创意或做决策，最后拿到一份 Markdown 报告。

**平台**：macOS 支持；Linux 可用（预览）；Windows 请用 WSL2。

## 先看示例（约 1 分钟，不需要任何账号）

前置条件：`git`、**Node.js 22**、**pnpm 10**（仓库固定 `pnpm@10.34.6`）。

```bash
# 1. 装 Node 22（已有可跳过），例如用 nvm：
nvm install 22 && nvm use 22
# 2. 用 corepack 启用仓库指定的 pnpm 版本
corepack enable && corepack prepare pnpm@10.34.6 --activate

# 3. 获取代码并构建
git clone https://github.com/Wenfeng-GAO/councilkit.git
cd councilkit
pnpm install --frozen-lockfile
pnpm build

# 4. 启动本机 Runtime Host（保持这个终端开着）
pnpm start            # http://127.0.0.1:43127

# 5. 另开一个终端，在仓库目录里生成示例报告
pnpm exec councilkit demo
# → 示例报告已生成 http://127.0.0.1:43127/reports/ck-review-demo-…
```

用 Chromium 内核浏览器（Chrome / Edge）打开输出的链接，就能看到一份标着「示例 DEMO」的审查报告。示例不调用任何模型。

## 接入真实 AI（约 10 分钟）

至少装好并登录一个下面的 CLI。CouncilKit 只调用你本机已登录的 CLI，从不读取或保存 API Key。

| 席位 | 安装 | 登录 |
|---|---|---|
| Codex | `npm install -g @openai/codex` | `codex login` |
| Kimi | `curl -fsSL https://code.kimi.com/kimi-code/install.sh \| bash` | 运行 `kimi`，输入 `/login` |
| Grok | `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login`（无浏览器时加 `--device-auth`） |
| Cursor | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login`（或设置 `CURSOR_API_KEY`） |
| Claude（可选，内部） | 需要内部封装 `cld`（route：`ant-glm5.2` / `moonshot` / `deepseek` / `cfuse`） | 外部用户暂时用不了这个席位 |

`cld` / `cfuse`、AntCode（`antcode`）、`squadctl` 都是**可选的内部工具**，没有它们也能完整使用。各家订阅和计费以对应官网为准。

装好后：

```bash
pnpm exec councilkit doctor          # 检查哪些 CLI 可用
pnpm exec councilkit init            # 自动发现本机 CLI，写入默认审查班子
```

### 浏览器：多 Agent 讨论

打开 `http://127.0.0.1:43127`：

1. **设置** → 确认 Host 在线、至少一个 CLI 的状态是「就绪」
2. **设置 → 3. Execution Profiles** → 基于已登录的 CLI 创建两个或更多 Profile
3. **设置 → 4. Agents** → 创建两个 Agent，各自绑定一个 Profile 并选择模型
4. **新建讨论** → 选择 Agent、确认发言顺序、指定主持人（Facilitator），可选模式（头脑风暴 / 规划 / 评审）和最大轮次
5. **发起讨论** → 主持人给出焦点，Agent 依次发言，主持人写本轮总结
6. 收敛后自动生成 **决策报告**（九段结构化 Markdown），可复制或下载

### CLI：审查 / 修复 / 创意（浏览器可关）

`councilkit` CLI 让 coding agent 或脚本在**浏览器关闭**时也能发起多 Agent 审查、修复和讨论，拿到 Markdown 报告。

```bash
# 审查 PR（N 个 agent 独立审查 → Aggregator 汇总）
pnpm exec councilkit review <pr-url>
# 仓库里没有规格合同（docs/plans|design|vibespec|verification）时，加 --no-require-spec

# 报告页（Host 运行时）
# http://127.0.0.1:43127/reports/<run-id>

# 审查 → 修复 → 复审
pnpm exec councilkit fix --run <ck-review-id>
pnpm exec councilkit apply --run <ck-review-id>
pnpm exec councilkit review <url> --against <ck-review-id>

# 产品创意讨论（受限只读，不修改项目）
pnpm exec councilkit ideate "一句话创意"
```

加 `--json` 得到机器可读输出。详细命令与选项见 `councilkit --help` 或 **[CLI 手册](docs/cli-handbook.md)**。

### 数据放在哪里

- **CLI 的运行记录**（审查、修复、创意、示例报告）在 `~/.config/councilkit/runs/`（可用 `COUNCILKIT_HOME` 改位置）。浏览器的「报告」「产品创意」页直接读这里，所以 CLI 跑完就能在浏览器里看。
- **浏览器里的讨论**（Room、Execution Profile、Agent、轮次和决策报告）存在浏览器 IndexedDB 里，只属于这个浏览器配置。
- CLI 的 Agent / Council 配置和浏览器的 Profile / Agent / Room 是两套，互不同步。

## 端口被占用？

Runtime Host 只绑定 `http://127.0.0.1:43127`，端口被占用时启动会失败并退出，origin 永不迁移。定位占用进程：

```bash
lsof -nP -iTCP:43127 -sTCP:LISTEN   # macOS
ss -ltnp 'sport = :43127'           # Linux
```

结束占用进程后重新 `pnpm start`。

## 验证与测试

```bash
pnpm typecheck   # 四个 tsc 程序：app、runtime-host、integration、cli
pnpm lint        # Biome
pnpm test        # Vitest 全量（unit + host + integration）
pnpm test:e2e    # Playwright，仅 Chromium，先构建再启动真实 Host
```

真实 CLI 冒烟（内部用，需要本机 `cld`/Codex 已登录）：

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
- **[技术设计（历史）](docs/technical-design.md)** — 2026-06 原始 SwiftUI 方案，已否决；当前架构看 Runtime Host 设计
- **[验证记录](docs/verification/)** — 功能验收与测试记录
- **[Brainstorms](docs/brainstorms/)** — 功能需求与设计讨论
- **[设计文档](docs/design/)** — 详细设计方案
- **[文档索引](docs/INDEX.md)** — 完整文档目录与阅读指南

## 关键约束

- **平台**：macOS 支持；Linux 可用（预览）；Windows 请用 WSL2。后台托管（launchd）只在 macOS 上有，Linux 上请在前台运行 `pnpm start`
- **Node.js 22**
- **Runtime Host 必须运行**（除 Autonomous Run（`review`/`ideate`/`apply`/`fix`/`repair`）与本地存储命令（`init`/`agent`/`council`/`jury`/`runs`/`findings`/`demo`）外）
- **数据**：浏览器的报告页读 CLI 的运行记录；Room / Profile / Agent 只在浏览器 IndexedDB（见上文「数据放在哪里」）
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
