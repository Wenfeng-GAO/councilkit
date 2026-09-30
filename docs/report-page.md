# 报告页与账本

本文档介绍 CouncilKit 的报告页功能、finding 账本、修复决策流程与验收机制。

## 目录

- [报告页概览](#报告页概览)
- [查看审查报告](#查看审查报告)
- [理解评审（Understanding Review）](#理解评审understanding-review)
- [Finding 决策](#finding-决策)
- [修复流程](#修复流程)
- [账本与闭环](#账本与闭环)
- [关闭证据](#关闭证据)
- [调整默认审查席位](#调整默认审查席位)

## 报告页概览

Host 运行时，浏览器打开 `http://127.0.0.1:43127/reports/<run-id>` 可查看：

- **审查报告**（`councilkit review` 产生的 `ck-review-*`）
- **讨论报告**（`councilkit run` 产生的 `ck-run-*`）
- **修复报告**（`councilkit repair` 产生的 `ck-repair-*`）
- **Squad 观察**（`squadctl --observe` 产生的 `ck-squad-*`）

CLI 命令 `councilkit runs open <run-id>` 会打印报告 URL。

## 查看审查报告

### 报告结构

`councilkit review` 产出的确定性 `report.md` 包含：

1. **Attempts 表格**（五列）：
   - Attempt（= agent 名称）
   - Driver/Model（= driverId/modelId）
   - 结果（ok 或 failed:code）
   - 耗时（持续时间）
   - 工具调用（tool call 次数或「无过程数据」）

2. **聚合正文**（中文五章节）：
   - 概览
   - 共识发现
   - 独有发现
   - 分歧
   - 结论

3. **过程对比**：各 Attempt 的执行过程差异

4. **附录：各审查者交付物**：每个 Attempt 的完整输出

### 实时过程

在报告页中，每个 attempt 卡片可以展开「过程」查看实时输出：

- **Live Transcript**：driver 过程事件（text/thinking/tool call）
- **运行时长**：receipt/elapsed（不以 live span 盖过 elapsed）
- **工具调用**：完整的工具调用记录

Host 端点 `GET /api/v1/cli-runs/:runId/attempts/:attemptId/live?afterSeq=N` 提供分页 + 坏行容忍的实时事件流。

### Durable Result

`GET /api/v1/cli-runs/:runId/attempts/:attemptId/result` 返回当前执行的 durable 全文：

- `executionRef`：执行引用
- `executionStatus`：执行状态
- `availability`：可用性
- `markdown`：Markdown 正文
- `truncated`：是否截断
- `failure`：失败信息（如有）
- `reusedFrom`：复用来源（如有）

kind=review 的报告页是固定席位工作台（三栏 + 单一 selectedAttempt），单席「报告」轴只认该端点，不认 live 正文； Aggregator 用 `attemptId="aggregator"`。

## 理解评审（Understanding Review）

打开 `/reports/<ck-review-id>`，点击「理解评审」。

### 功能

页面展示本次冻结区间的全部文件与变更片段，并在可信的旧/新侧源码位置插入意见：

- **完整 diff**：全部文件与变更片段
- **意见插入**：在旧/新侧源码位置插入审查意见
- **无意见的 diff**：仍保留，便于上下文理解
- **缺失位置**：无法确认的位置单独说明，不拿当前工作区代码冒充审查版本

### 看懂问题

「看懂问题」保留原评审，按需调用一个已配置模型生成解释：

- **默认模型**：使用 `pr-jury` Reporter
- **解释内容**：区分已有证据与条件推演
- **简单项**：显示建议代码
- **复杂项**：用固定 Canvas 流程/时序模板与等价文字
- **缓存复用**：相同源码、断言、模型及解释版本复用缓存，不重跑整个 Council

**注意**：模型建议不会直接修改代码，也不作为修复完成证明。无可用配置时显示错误。新增 Host 路由需构建并重启同 checkout 的 Host 后使用。

## Finding 决策

每条意见只有**两个选择**：

1. **打算修复**（`will_fix`）：导出修复任务包时会包含此项
2. **不修复**（`wont_fix`）：后续普通 review 和 `--against` 中跳过已确认的同一断言

可再次点击撤回为**待决定**（`undecided`），无需填写理由。

### CLI 命令

```bash
# 决定打算修复
councilkit findings decide --run <ck-review-id> --id <finding-id> --decision will_fix [--json]

# 决定不修复
councilkit findings decide --run <ck-review-id> --id <finding-id> --decision wont_fix [--json]

# 撤回为待决定
councilkit findings decide --run <ck-review-id> --id <finding-id> --decision undecided [--json]

# 旧的 accept 命令（标记为接受不修（须写理由）
councilkit findings accept --run <id> --id <finding-id> --reason <text> [--json]
```

### 决定记录

决定存于同一 PR 的权威记录：

- **打算修复**：用于导出修复与验收范围
- **不修复**：在后续普通 review 和 `--against` 中跳过已确认的同一断言
- **未知别名**、**新失败机制**或**不同 PR** 不继承跳过

**重要区分**：
- 选择修复 ≠ Builder 声称完成
- Builder 声称完成 ≠ 已验证关闭
- 这是三个不同的状态

## 修复流程

### 1. 导出任务包

```bash
# 导出全部或指定集群
councilkit repair export --run <ck-review-id> --out <file> [--cluster <id>] [--json]

# 只导出打算修复的选择集合
councilkit repair export --run <ck-review-id> --selected --out <file> [--json]
```

**约束**：
- 导出要求审查完整成功且账本具有对应的完整 SHA
- 存在 `plan.lock.json` 时必须属于本轮且已批准
- 输出文件必须不存在
- 未选择任何修复项时不能导出空任务包

**包内容**：
- 问题 ID
- 来源 SHA
- 证据
- 修改范围
- 不变量
- 验收要求
- 范围外问题明确留待处理

### 2. 执行修复

三种路径：

#### A. `councilkit fix`（推荐）

方案陪审 → 一集群落地 → 对照账本复审。详见 [CLI 手册](cli-handbook.md#councilkit-fix--方案陪审--一集群落地--对照账本复审)。

```bash
councilkit fix --run <ck-review-id> [--plan-only] [--no-re-review] [--no-push] [--json]
```

#### B. `councilkit apply`

直接落地锁定的一刀。详见 [CLI 手册](cli-handbook.md#councilkit-apply--把锁定的一刀落到同一条-pr不经-host)。

```bash
councilkit apply --run <ck-review-id> [--cluster <id>] [--all-clusters] [--agent <ref>] [--no-push] [--json]
```

#### C. `councilkit repair`

Squad 自动修复直到机器准出。详见 [CLI 手册](cli-handbook.md#councilkit-repair--squad-自动修复直到机器准出)。

```bash
councilkit repair run --from <ck-review-id> --profile <name> [--json]
councilkit repair status --run <ck-repair-id> [--json]
councilkit repair stop --run <ck-repair-id> [--json]
councilkit repair resume --run <ck-repair-id> [--json]
```

### 3. 验收

候选修复后，保持同一任务范围与来源断言进行验收：

```bash
councilkit review <pr-url> --against <ck-review-id> --repair-package <file> [--json]
```

## 账本与闭环

### Finding 账本

- 每次 review 产生 `findings.json`
- `--against <prior-run>` 优先保留原问题 ID，并保留独立审查者报告的发现
- 失败、未覆盖、聚合报告未再提及都不会关闭旧问题
- `fix` 的复审默认带 `--against`

### 账本更新规则

| 情况 | 账本行为 |
|---|---|
| 新发现的问题 | 分配新 ID，记入账本 |
| 仍存在的问题 | 保留原 ID，更新证据 |
| 失败的 Attempt | 不关闭问题 |
| 未覆盖的区域 | 不关闭问题 |
| 聚合报告未再提及 | 不关闭问题 |
| 缺席复审 | 不会变成 accept |

### 增量审查

```bash
councilkit review <url> --against <ck-review-id> [--json]
```

对照账本标记：
- **closed**：已解决
- **回归**：之前解决但又出现
- **新洞**：新发现的问题

## 关闭证据

### 关闭要求

关闭一个 finding 需要：

1. **成功的独立审查者**提交结构化验证
2. 绑定本次**完整候选 SHA**
3. 提供**测试命令或代码位置**

### 验证机制

控制器核对审查 worktree 的 HEAD 与受跟踪文件没有变化：

- `apply` 只记录 `repairClaim`（声称关闭）
- 关闭需要独立审查提供验证凭据
- 聚合器不能代写关闭凭据
- 仍成立的发现优先于关闭声明

### 历史未验证

旧 `closed` 没有验证凭据时显示**"历史未验证"**：

- 重大项仍待处理
- 需要新的审查提供验证凭据
- 证据来自独立模型审查，不能理解为控制器已经重跑并认证了其所有测试

### `apply` 落地记录

每刀在 `landings.jsonl` 记：
- `parentSha → candidateSha`
- 声称关闭的 finding id

## 调整默认审查席位

打开 `/reports` 即可查看 `pr-jury` 当前的默认角色、模型与汇总席位。

### 页面操作

1. 点击「调整席位」
2. 在每个角色的下拉框中选择：
   - 模型来源
   - 路由
   - 模型
3. 可以：
   - 添加已有 Agent
   - 移除非汇总席位
   - 指定新的汇总席位
4. 点击「保存默认席位」

页面不再提供自由输入模型 ID 或一次性模型组合。

### 模型选项来源

- 实时目录（`councilkit models`）
- 本机已保存的 Agent
- Codex 模型缓存

因此目录尚未同步的新模型（如 `gpt-6-astra`）也可直接下拉选择。启动审查时仍会探测实际可用性。

### 配置存储

- 配置原子写入 `councils.json` 中 `pr-jury` 的 `agentOverrides`
- 不修改共用 Agent 的角色职责与全局模型
- 不影响其他 Council 或已开始的 Run
- 至少保留 1 个席位、最多 8 个
- 汇总席位必须在班子内

### CLI 操作

```bash
# 查看实际默认配置
councilkit jury show --json

# 更新配置（过期 revision 会拒绝保存）
councilkit jury save --config '<json>'
```

`init --force` 重建 Council 时会清除这组覆盖配置。

## 报告列表

打开 `/reports` 查看所有 CLI 报告，按 PR 展示：

- 最近完整审查的证据 SHA
- 未决重大项
- 未验证修复
- 下一步建议

### 列表行为

- 较新的失败审查单独提示恢复，不覆盖旧的有效证据
- 旧证据不代表远端当前 HEAD 已通过
- 对比与重复问题统计只沿同一 PR 的 `against` 链
- 详情页可复制导出命令

## Squad Observe

`ck-squad-<uuid>` / `kind=squad` 是外部 `squadctl --observe` 写入的只读 sidecar（同一 `COUNCILKIT_HOME/runs`）：

- Host 不读 `.squad/`、不 spawn `squadctl`、不对 squad run 提供 fix/re-review
- 报告页走席位过程 + 只读 `handoff` 块 + sidecar 里的 brief/plan/评审/final，不走修复管线
- 旧 sidecar `interrupted` + 全席终态 + `phase≠done` 读时映射为 `awaiting_orchestrator`（「等待编排」）；显式收工为 `closed`（「已收工」）

看过程需要 Host（`pnpm start` 或 launchd）；前台 `pnpm dev` 被杀 ≠ 观察消失。Host 继续只读 Squad sidecar，不接管其执行控制。

## 另见

- [CLI 手册](cli-handbook.md) — 完整的 review/fix/apply/repair 命令参考
- [Runtime Host 运维](host-operations.md) — Host 启动与诊断
- [AGENTS.md](../AGENTS.md) — Coding agent 的最短路径
