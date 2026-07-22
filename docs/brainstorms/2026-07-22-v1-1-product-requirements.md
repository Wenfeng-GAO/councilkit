# CouncilKit V1.1 产品迭代需求文档

> 日期：2026-07-22（grill-with-docs 评审后定稿）
> 输入：用户提出的 3 项新需求 + 刚完成的 cfuse route / kimi-stream-json driver 迭代（squad 20260721-cfuse-kimi-drivers-a7x2，已并入 main @ 9ce5619）
> 定位：V1.1 需求与设计基线，供排期实施。术语与 CONTEXT.md 保持一致（Driver Selection / Council / Reporter / Run 已入词汇表）。

## §0 背景与现状摘要

V1 已交付：Runtime Host（127.0.0.1:43127）+ 三个 Runtime Driver（claude-stream-json【含 ant-glm5.2 / moonshot / deepseek / **cfuse** 四条 route】、codex-app-server、**kimi-stream-json**），浏览器端讨论编排（Dexie + discussion-orchestrator），Agent 导入导出，决策报告。

与本文相关的现状事实：

- Agent 实体**已有 `color` 字段**（hex 字符串，`src/models/discussion/entities.ts:15-28`），编辑表单是 `#rrggbb` 裸文本输入 + 圆点预览（`src/components/settings/AgentFormModal.tsx:189-202`），卡片上仅渲染一个色点（`AgentConfigCard.tsx:22`）。
- Agent「测试」按钮当前只做 **Profile readiness 握手**（`AgentsSection.tsx:147-168` → `POST /api/v1/profiles/readiness`），结果行有固定尾注"仅验证执行环境，未调用模型生成"（e2e: `settings-agents.spec.ts:207-218`）。
- Host 的 scope/execute/ack/SSE 管线完整（`runtime-host/routes/scopes.ts`），但 **Room/Agent 数据与讨论编排全部在浏览器**（IndexedDB + `src/orchestrator/discussion-orchestrator.ts`），Host 不知道 Room 概念；Host 认证为 cookie + CSRF，仅通过加载文档页面下发（`server.ts:269-287`）。
- `installationId` 由 `name-sha256(realpath)[:12]` 确定性计算（`runtime-host/installations/registry.ts:432`），Host 重启后稳定，但二进制被替换/移动时会变。

## §0.1 裁决记录（2026-07-22，用户；grill 增补 Q7-Q14）

| # | 问题 | 裁决 |
|---|---|---|
| Q1 | 颜色自定义 hex | **严格预设闭集**，不提供自定义入口 |
| Q2 | 简易 avatar | 不做 |
| Q3 | CLI 持久化 agent/room 存储 | **需要**（CLI 侧本地存储） |
| Q4 | CLI 认证 | **V1.1 用 cookie/CSRF 提取**；token 端点留 V2 |
| Q5 | MCP server | **不做**，只要 CLI |
| Q6 | 测试按钮形态 | **并列两个按钮** |
| Q7 | CLI agent 的执行配置引用 | **Driver Selection**（driverId + 类型化 options + modelId），不存 installationId；每次 run 动态解析（≠ Execution Profile） |
| Q8 | CLI "room" 术语 | 静态配置命名 **Council**；Room 仍专属浏览器有状态讨论实例；CLI agent 保留称 agent |
| Q9 | CLI 讨论语义 | **最简子集**：固定 N 轮、无每轮摘要、无提前收敛；**Reporter**（council 必填）生成最终报告；无 Facilitator/Convergence/Decision Report 概念 |
| Q10 | CLI 失败/中断 | transcript 增量落盘 `runs/<run-id>/transcript.jsonl`；失败即停 + 非零退出 + 可输出部分报告；V1.1 不做 resume |
| Q11 | CLI 存储 schema | 对齐 `agent-io.ts` 导出格式（executionProfileId 换成 Driver Selection 字段），zod strict + version |
| Q12 | CLI 包形态 | 仓库内 `cli/` workspace 包，pnpm bin 暴露 `councilkit`；README + AGENTS.md 增加 CLI 章节 |
| Q13 | `run` 报告形态 | Markdown 落盘（默认 `runs/<run-id>/report.md`），章节对齐浏览器 Decision Report；`--json` 输出结构化 transcript + 终态元数据 |
| Q14 | 实施切分 | **两个 squad 任务**：任务 1 = 色板 + 真实调用测试；任务 2 = CLI |
| Q15 | 真实测试记录归属 | **不落 Dexie**——前端直接驱动 RuntimeClient，结果仅存内存 |
| Q16 | 探针与成功判定 | 固定 prompt `Reply with exactly: COUNCILKIT_OK`；成功 = `completed` + 非空输出（不要求精确匹配） |
| Q17 | 真实测试超时 | 60s 前端总超时（超时 cancel scope），Host 侧复用既有 turn 超时 |
| Q18 | 测试与讨论并发 | 允许，复用 Host 既有配额，配额满按结构化错误展示 |
| Q19 | 遗留/导入非预设色 | 渲染兼容、编辑不被动改色（未点色板保留旧值提交，点选即归入闭集）；新建必选预设 |

---

## §1 需求一：Agent 颜色预设选择器（P0）

**用户需求**：创建/编辑 Agent 时从几个预设颜色中选择，而不是手写 RGB。

### 设计（已定稿）

- **预设色板（闭集，Q1）**：8–10 个深色 UI 下区分度足够的颜色（建议：琥珀、天蓝、翠绿、紫罗兰、玫红、橙红、青绿、石灰、靛蓝、slate；具体色值实现时按 sketch-findings 的设计约定定，色弱常见的红绿对保持明度差）。不提供自定义 hex 入口。
- **交互**：色板圆形 swatch 网格 + 选中态描边；新建 Agent 必须选择一个预设色。
- **遗留与导入兼容（Q19）**：既有 Agent 或 `agent-io` 导入的 color 非预设成员时——正常渲染；编辑表单中色板不高亮任何 swatch 并提示"当前为遗留颜色，点选后归入预设"；用户未主动点色则保留旧值提交（不被动改色），点选即收敛进闭集。导入格式不变。
- **数据层**：无 Dexie 迁移——`color` 字段已存在（hex 字符串）；校验层收敛为预设集合 + 既有遗留值。
- **辐射面**：`AgentFormModal.tsx`（表单）、`AgentConfigCard.tsx`（色点）、房间内消息/参与者渲染（确认一致使用 `agent.color`）。

### 验收

1. 创建 Agent 只能通过色板选择；编辑时未点色板保留原值，点选后只能归入预设。
2. 既有/导入的非预设 hex 正常渲染，不被静默改写。
3. 色板在深色主题下两两可区分（含红绿明度差）。
4. e2e：创建 Agent 选色 → 卡片与房间参与者列表颜色一致；遗留色编辑不改名场景颜色不变。

---

## §2 需求二：Agent 真实模型调用测试（P0）

**用户需求**：测试不仅验证执行环境，还要发起真实模型调用。

### 设计（已定稿）

- **双档并列（Q6）**：
  - 「测试」（现状保留）：readiness 握手，秒级，不烧钱。
  - **「真实调用测试」（新增）**：前端直接驱动 RuntimeClient 创建一次性单 participant 测试 scope（persona 用 Agent 真实 persona，modelId 用 Agent 选定模型），发送固定探针 `Reply with exactly: COUNCILKIT_OK`（Q16），走 SSE 收终态，ack 后关闭 scope。**结果不落 Dexie**（Q15），仅内存展示，刷新即失。
- **成功判定（Q16）**：Host `completed` 终态 + 非空规范化输出；不要求精确匹配探针文本（persona 会影响回答格式），输出预览展示给用户判断。失败 = 任何 failed/interrupted 终态，按既有结构化错误分类（auth / installation / model_unavailable / timeout / crash / 配额）给出可操作提示。
- **结果展示**：成功/失败 + canonical/effective model、modelVerdict、toolState、首帧/总耗时、输出预览（截断）、usage（driver 有则显示，kimi 为 null 属预期）。两档结果在 UI 上明确区分。
- **超时与并发（Q17/Q18）**：60s 前端总超时（超时 cancel scope 并展示 timeout）；允许与进行中的讨论并存，复用 Host 既有配额（maxDriverProcesses 等），配额满按 Host 结构化错误如实展示。
- **成本与安全**：真实档消耗一次真实模型调用——按钮文案「真实调用测试」即明示成本，点击视为授权单次调用，不做二次确认弹窗。测试 scope 使用 participant 专用空 cwd，与讨论 scope 同安全约束。
- **kimi driver 特别注意**：kimi 是 per-turn 进程模型，真实测试天然验证 spawn + provider 探针 + turn 全链；toolState 应为 `none`（干净 turn），`completed/unknown` 如实展示。

### 验收

1. 真实档对 cfuse / kimi / codex 各 driver 各完成一次真实模型 round-trip 并展示证据（live 验证）。
2. 失败路径可读：auth 过期、profile 未绑定、模型不在目录、超时、配额忙，各有明确提示。
3. 测试 scope 完整关闭，无进程/scope 泄漏；Dexie 无任何测试残留（host/前端测试断言）。
4. e2e：fake driver 下真实档全链路（scope→execute→SSE→ack→渲染）；60s 超时路径有测试。

---

## §3 需求三：CLI 接口（P0）

**用户需求**：暴露 CLI，让 claude 或其他 coding agent 能快速创建 agent 和 room，并发起讨论。

### 3.1 架构决策（已定稿）：CLI-as-orchestrator

CLI 自带简化讨论编排，直接驱动 Host scope/execute/SSE/ack 管线。**CLI 与浏览器是两个数据世界**（Q8）：

- CLI 静态讨论配置称 **Council**（topic、background、目标输出、agent 组合、轮次配置、reporter）；执行一个 Council 产生的讨论实例称 **Run**（transcript + 报告）。
- Room / Facilitator / Convergence / Decision Report 仍是浏览器上下文专有概念；CLI 上下文不启用（Q9）。
- 编排下沉 Host（多客户端共享 Room 数据模型）是 V2 方向，本版本不做。
- 术语已入 CONTEXT.md：**Driver Selection**、**Council**、**Reporter**、**Run**。

### 3.2 形态与命令面（Q12）

- **形态**：仓库内 `cli/` workspace 包（Node/TS 同栈），pnpm bin 暴露 `councilkit`；README + AGENTS.md 增加 CLI 章节（coding agent 读 AGENTS.md 即可学会用法）；**不做 MCP server**（Q5）。
- **命令面**：
  - `councilkit doctor [--json]`：Host 可达性 + installations + catalog 摘要（自描述能力）。
  - `councilkit models [--json]`：当前可用 driver/route/model 闭集。
  - `councilkit agent create|list|show|delete`：管理 CLI 侧 agent（name + personaPrompt + Driver Selection + modelId + color + enabled）。
  - `councilkit council create|list|show|delete`：管理 CLI 侧 council（topic、background、目标输出、agent 引用列表、rounds、reporter【必填，不可静默 fallback】）。
  - `councilkit run --council <name|id> [--rounds N] [--out report.md] [--json]`：发起 Run——创建 scope、按 council 定义跑 N 轮、Reporter 最终总结、输出报告。也支持 `--agents <inline>` 免 council 一次性运行。

### 3.3 CLI 本地存储（Q3/Q11）

- 位置：`~/.config/councilkit/`（XDG；`COUNCILKIT_HOME` 可覆盖）。
- `agents.json` + `councils.json`：zod strict + version 字段；agent 记录对齐浏览器 `agent-io.ts` 导出格式，但 `executionProfileId` 替换为 **Driver Selection**（`{ driverId, options }`，Q7/Q11）；secret-free（不存任何凭据）。
- `runs/<run-id>/`：`transcript.jsonl`（每完成一个 turn 增量追加，Q10）+ `report.md`。
- 与浏览器 Dexie 不做双向同步（V1.1）。

### 3.4 认证（Q4）

- **V1.1 方案**：CLI `GET /` 解析 `<meta name="councilkit-csrf">` + 内存 cookie jar 保存 HttpOnly session cookie；mutation 请求带精确 Host/`Origin: http://127.0.0.1:43127` + `x-councilkit-csrf` 头（loopback 下合法，已实证可行）。
- 遇 401/403 自动重新提取，对用户无感；cookie/CSRF 不落盘、日志与 `--json` 输出一律脱敏。
- **V2 候选**：UI 内签发 CLI token 的专用端点（可撤销、跨重启稳定；需 Host 新增持久化面）。

### 3.5 讨论语义子集（Q9/Q10）

- 固定 N 轮（council.rounds，`--rounds` 可覆盖）；每轮各 agent 按序发言一次；每 turn 由 CLI 组装全量上下文快照提交（Host SessionReconciler 自动做全量/增量优化）。
- 无每轮摘要、无提前收敛；N 轮结束后 **Reporter**（必填指定）做一次最终总结调用。
- 失败语义：任一 turn 失败即停止该 Run、非零退出码、保留 transcript，可用 `--out` 输出已完成部分的报告；V1.1 不做断点续跑（`--resume` 留 V1.2）。

### 3.6 报告输出（Q13）

- 默认写 `--out` 指定路径（未指定则 `runs/<run-id>/report.md`），Markdown 章节结构对齐浏览器 Decision Report。
- `--json` 输出结构化 transcript + 每 turn 终态元数据（effectiveModel、modelVerdict、toolState、耗时、usage），供程序消费。

### 3.7 验收

1. `councilkit run` 在浏览器关闭的情况下，用真实 driver（cfuse/kimi）完成一场 2+ agent、2 轮 Run 并产出 Markdown 报告（live 验证）。
2. `agent`/`council` CRUD 与持久化：CLI 重启后数据仍在；非法输入被 schema 拒绝；reporter 必填校验。
3. 无凭据泄露：磁盘无 cookie/CSRF 明文；日志/JSON 输出脱敏；文档写明凭据生命周期。
4. 失败语义：Host 重启中断的 Run 保留 transcript.jsonl、非零退出、可输出部分报告。
5. Host 测试：CLI 认证路径与 scope 生命周期（建/执行/关）契约测试。
6. 切片建议：认证 + doctor/models → agent/council 存储 → run 单 agent 单轮 → 多 agent 多轮 + Reporter + 报告。

---

## §4 附加迭代建议（本次迭代中暴露/既有积压）

### P1（建议进 V1.2）

1. **Provider 漂移修复引导**：moonshot（K2.5→K3→k3）与 kimi catalog 都有漂移史；Agent modelId 不在当前 catalog 时，编辑页给出"重绑定到 X"的引导（`docs/brainstorms/2026-07-18-next-iteration-directions.md` 已列）。
2. **dispatchAckMs 可配置**：5s 窗口对慢 provider 偏紧（cfuse 冒烟两次首跑失败、重试即过）；支持 per-route/per-driver 覆盖（`shared/runtime/contracts.ts:47`）。
3. **Room 导出/分享**：Room + transcript 导出为 Markdown/JSON bundle（与 CLI 报告格式对齐）。
4. **Room/Council 模板**：预设 agent 组合一键建房；CLI council 与浏览器模板格式可对齐。
5. **CLI `--resume`**：从 transcript.jsonl 断点续跑（§3.5 已留位）。

### P2（backlog）

6. **kimi driver 硬化 ticket**：drain 句柄重构（squad D11 残余 P2）、close 期间 probe 误标 AUTH_REQUIRED（P3）、close 不 resolve execute promise（P3 defer）；kimi 协议若输出 usage/model 字段应接入。
7. **Agent 级模型参数**：kimi `supportEfforts`（low/high/max）、codex reasoningEffort——按讨论角色覆盖。
8. **CK-001**：SSE resume 乱序既有 bug ticket。
9. **讨论预设指令库**：常用 focus/总结指令模板。

---

## §5 里程碑与实施切分（Q14）

- **V1.1 任务 1（先行）**：§1 色板 + §2 真实调用测试（前端为主，Host 零新增端点）。
- **V1.1 任务 2**：§3 CLI（按 §3.7 切片）。
- **V1.2**：§4 P1 五项。
- **V2**：编排下沉 Host、多客户端统一、CLI token 端点。

## §6 开放问题

无。Q1–Q19 已全部裁决（§0.1）。
