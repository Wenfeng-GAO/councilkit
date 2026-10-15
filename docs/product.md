# CouncilKit 产品说明（当前）

> 与 [README](../README.md)、[CONTEXT.md](../CONTEXT.md) 保持一致；术语以 CONTEXT.md 为准。2026-06 的 MVP 原始规划已移到 [docs/history/2026-06-product-mvp-plan.md](history/2026-06-product-mvp-plan.md)（历史文档）。

## 一句话定位

本地优先的多 Agent 决策工具：让几位 AI（你本机已登录的 coding agent CLI）一起审 PR、修 PR、讨论产品创意或做决策，最后给出一份可读的 Markdown 报告。

## 目标用户

已经在用 coding agent 的开发者 / 独立开发者，主要场景是：
- 用多个 agent 并行审查自己的 PR，汇总成一份报告，再按报告修复和复审；
- 对一个产品创意做多视角讨论（只读，不改项目）；
- 在浏览器里组织一场有主持人、多轮、能收敛成决策报告的讨论。

## 形态与平台

- **形态**：浏览器 Web UI + 本机前台运行的 **Runtime Host**（`http://127.0.0.1:43127`），另有 `councilkit` CLI。没有原生桌面 app。
- **平台**：macOS 支持；Linux 可用（预览）；Windows 请用 WSL2。
- **模型从哪来**：只调用你本机已安装并登录的 CLI。当前五个内置 Driver：`claude-stream-json`（经内部 `cld`，可选）、`codex-app-server`、`kimi-stream-json`、`grok-stream-json`、`cursor-stream-json`。
- **凭据**：认证统一为 `installation-managed`，CLI 自己管登录；CouncilKit 从不读取或保存 API Key。

## 两条主线

### 1. CLI：审查 / 修复 / 创意（Autonomous Run，浏览器可关）

- `councilkit review <pr-url>`：N 个全能力 agent 独立审查 → Aggregator 汇总成报告；默认按仓库里的规格合同审查，没有合同时可加 `--no-require-spec`。
- `councilkit fix` / `apply` / `repair`：按报告生成修复、应用、复审。
- `councilkit ideate "<创意>"`：受限只读的产品创意讨论。
- `councilkit demo`：不需要任何账号的示例报告。
- 运行记录落在 `~/.config/councilkit/runs/`（`COUNCILKIT_HOME` 可改）。浏览器的「报告」「产品创意」页直接读这里。

### 2. 浏览器：多 Agent 讨论（Room）

- 导航：首页 / 新建讨论 / 产品创意 / 报告 / 设置。Execution Profile 和 Agent 在「设置」里管理。
- 新建讨论：选 Agent、确认发言顺序、显式指定主持人（Facilitator）、模式（头脑风暴 / 规划 / 评审）、可选最大轮次。
- 每轮：主持人给焦点 → Agent 依次发言 → 主持人写本轮总结；收敛投票或达到最大轮次后自动生成九段结构化**决策报告**，可复制 / 下载。
- 可暂停、追加发言、提前「总结并结束」；单个 Agent 失败可重试或跳过（主持人不可跳过）。
- Room、Execution Profile、Agent、轮次与决策报告存在浏览器 IndexedDB，只属于这个浏览器配置。

## 数据边界（准确说法）

| 数据 | 存放 | 谁能看到 |
|---|---|---|
| CLI 运行记录（审查 / 修复 / 创意 / 示例） | `~/.config/councilkit/runs/` | CLI + 浏览器「报告」「产品创意」页 |
| CLI 的 Agent / Council 配置 | `~/.config/councilkit/` | 只有 CLI |
| Room / Execution Profile / Agent / 讨论报告 | 浏览器 IndexedDB | 只有这个浏览器配置 |

## 原则

1. 本地优先：数据默认只在本机。
2. 有组织：讨论有主题、主持人、轮次和结束条件。
3. 可追溯：消息、执行和报告都结构化保存。
4. 不碰密钥：只借用本机 CLI 的登录。

## 暂不做

多端同步、团队协作、云端房间、Agent 市场（见 [roadmap](roadmap.md)）。
