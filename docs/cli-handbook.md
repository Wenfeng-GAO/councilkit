# CLI 手册

`councilkit` CLI 让 coding agent 或脚本在**浏览器关闭**时也能查看模型、管理 Agent/Council、发起多 Agent 多轮讨论并拿到 Markdown 报告。CLI 与浏览器**数据不互通**：它有自己的本地存储（`~/.config/councilkit/`），不读写浏览器的 Dexie 数据。

## 目录

- [构建与安装](#构建与安装)
- [Host 依赖与例外](#host-依赖与例外)
- [命令参考](#命令参考)
- [自主并行审查 (`review`)](#自主并行审查-review)
- [修复流程 (`fix` / `apply` / `repair`)](#修复流程-fix--apply--repair)
- [产品创意讨论 (`ideate`)](#产品创意讨论-ideate)
- [退出码](#退出码)
- [凭据生命周期](#凭据生命周期)
- [端口独占](#端口独占)

## 构建与安装

CLI 是 `cli/` workspace 包，bin 是 `cli/bin/councilkit.mjs` thin launcher → 构建产物 `cli/dist/main.mjs`。`pnpm install` 后需构建一次：

```bash
pnpm install --frozen-lockfile
pnpm build:cli           # 单独构建 CLI（根 pnpm build 也会构建它）
pnpm exec councilkit --help
```

## Host 依赖与例外

CLI 不 spawn Runtime Host，也不直连模型供应商——**大部分命令**仍经过本机前台运行的 Runtime Host（与浏览器共用 `http://127.0.0.1:43127`）。所以先 `pnpm start`（或 `pnpm dev`）让 Host 跑起来，再开 CLI；浏览器可以关。Host 不可达时 `doctor`/`run` 以退出码 3 失败，CLI 永不自动拉起 Host。CLI 只保证与**同 checkout** 的 Host 互通（版本绑定）。

### 例外：Autonomous Run（不经 Host）

以下命令**不经 Runtime Host**——它们直接按 PATH 解析本机 CLI 并 spawn agent 子进程：

- `councilkit review`
- `councilkit ideate`
- `councilkit apply`
- `councilkit fix`
- `councilkit repair`

这些命令不需要 Host 运行，也不受退出码 3 约束。详见 [自主并行审查](#自主并行审查-review)。

## 命令参考

### 初始化与发现

#### `councilkit init [--force] [--json]`

发现本机 CLI（`cld`/`kimi`/`grok`/`cursor-agent`/`codex`），写入默认审查班子。

- **默认 Agent**：
  - `review-security`
  - `review-correctness`
  - `review-maintainability`
  - `review-adversarial`（PATH 上有 `grok` 时）
  - `review-cursor`（PATH 上有 `cursor-agent` 时，model = `auto`）

- **默认 Council**：
  - `pr-jury`（reporter = `review-adversarial`（grok），缺 grok 则 `review-correctness`，再缺则已发现的第一个；`review-cursor` 不是 preferred reporter）
  - `product-jury`（PATH 上有 grok/kimi 时另写 `ideate-product` / `ideate-engineering`；`ideate-challenger` 还要 PATH 有 `codex` **且**能从 `CODEX_HOME`/`~/.codex` 发现模型；Reporter 优先 Codex）

- **行为**：
  - 已存在的 `pr-jury` 会补进新发现的默认 Agent 并把 reporter 切到 grok（若有）
  - `--force` 先删 `pr-jury` 与 `product-jury` 再重建

### 诊断与发现

#### `councilkit doctor [--json]`

自检 Host + installations + catalog 摘要。讨论 Run 才需要；review 不需要。

#### `councilkit models [--json]`

当前可用 driver/route/model 闭集（实时 catalog）。

`models --json` 每条含 `driverId / route / installationId / catalog / cachedAt / error`。从实时 catalog 选 modelId（不要硬编码）：

```jsonc
// models --json 片段
{ "driverId":"claude-stream-json", "route":"cfuse", "catalog":["antchat/GLM-5.2[1m]", "..."], "error":null }
{ "driverId":"kimi-stream-json", "route":null, "catalog":["kimi-code/k3"], "error":null }
{ "driverId":"grok-stream-json", "route":null, "catalog":["grok-4.6","grok-4.5"], "error":null }
{ "driverId":"cursor-stream-json", "route":null, "catalog":["auto","composer-2.5", "..."], "error":null }
```

### Agent 管理

#### `councilkit agent create`

```bash
councilkit agent create \
  --name <name> --persona-prompt <text> \
  --driver-id <claude-stream-json|codex-app-server|kimi-stream-json|grok-stream-json|cursor-stream-json> \
  --options '<json>' --model-id <id> --color <#rrggbb> [--disabled] [--json]
```

建 Agent（Driver Selection = driverId + 类型化 options；不含凭据/installationId）。

每条 `agent create --json` 返回 `{ "id":"...", "name":"...", "driverId":"..." }`。后续命令用 id 或 name 引用（id 精确优先；name 唯一时也可）。

#### `councilkit agent list|show <name|id>|delete <name|id> [--json]`

列出、查看、删除 Agent。Agent 被 Council 引用时不可删除（先删 Council）。

### Council 管理

#### `councilkit council create`

```bash
councilkit council create \
  --name <name> --topic <text> [--background <text>] [--target-output <text>] \
  --agents '<["ref1","ref2"]>' --rounds <N> --reporter <ref> [--json]
```

建 Council（reporter 必填且在 agents 中；--agents 是 JSON 数组）。

**Reporter 必填**：Council 必须显式指定一个 reporter agent（且在 agents 中），不静默 fallback。

#### `councilkit council list|show <name|id>|delete <name|id> [--json]`

列出、查看、删除 Council。

### 讨论 Run

#### `councilkit run --council <name|id> [--rounds N] [--out path] [--json]`

发起 Run（固定 N 轮 + 一次 Reporter 总结；报告落 `runs/<run-id>/report.md`）。

`run --json` 成功时 stdout 是 `RunOutcome`：

```jsonc
{
  "status":"completed", "exitCode":0, "runId":"ck-run-...",
  "reportPath":".../runs/ck-run-.../report.md",
  "transcriptPath":".../runs/ck-run-.../transcript.jsonl",
  "turns":[{"role":"message",...},{"role":"message",...},...,{"role":"report",...}],
  "incomplete":false, "failure":null,
  "installations":{"<agentId>":"<installationId>"}
}
```

2 Agent × 2 轮 = 4 个 `message` turn + 1 个 `report` turn。失败时 `status` 为 `failed`/`interrupted`、`exitCode` 非零、`incomplete:true`、`failure:{phase,code,message}`，且 `report.md` 仍写盘并标注 `INCOMPLETE`，`transcript.jsonl` 保留已完成的 turn。

#### 一次性 Run（免存 Council）

```bash
councilkit run --agents '["<A-id>","<B-id>"]' --topic "..." \
  --reporter "<B-id>" --rounds 2 [--out path] [--json]
```

讨论固定 N 轮，每轮各 agent 按序发言一次；N 轮后 Reporter 做一次最终总结调用，产出结构化 Markdown 报告。

`--json`：进度/诊断全走 stderr，stdout 只出一个最终 JSON 文档。

### Run 管理

#### `councilkit runs list [--json]`

列出 CLI 报告（`runs/` 下的所有 run）。

#### `councilkit runs open <run-id> [--json]`

打印 `http://127.0.0.1:43127/reports/<run-id>`（Host 运行时可在浏览器中打开）。

#### `councilkit runs gc [--keep <days>] [--dry-run] [--all]`

只清 `runs/<id>/workspaces`，`report.md`/`transcript.jsonl` 永久保留。

### 审查席位管理

#### `councilkit jury show [--council product-jury] [--json]`

读 `pr-jury` 或 `product-jury` 当前默认席位配置。

## 自主并行审查 (`review`)

同一任务由 N 个全能力 agent（Attempt）在**隔离 git worktree**（`runs/<run-id>/workspaces/<attemptId>/`，同一 PR commit，不各自 clone）中独立并行做一遍，再由 Aggregator 对比汇总，产出确定性 `report.md`（头部含 Attempts 五列表格 + 中文五章节聚合正文 + `## 过程对比` + `## 附录:各审查者交付物`）+ `transcript.jsonl`。

### 基础用法

```bash
# 使用默认 pr-jury
councilkit review <pr-url> [--repo <path>] [--json]

# 指定 agents 与 aggregator
councilkit review --agents '<["ref1","ref2"]>' --aggregator <ref> \
  (--pr <url|number> | --task "<text>") [--json]

# 使用保存的 council
councilkit review --council <name|id> \
  (--pr <url|number> | --task "<text>") [--json]
```

PR 审查需要本机已有该仓库：`--repo <path>`、`repos.json` 记忆，或在匹配 remote 的 clone 里直接跑。`--task` 仍用空 cwd。

### 关键特性

#### 不经 Runtime Host

CLI 直接按 PATH 解析 `cld`/`kimi`/`codex`/`grok`/`cursor-agent` 并 spawn，绕过 scope/SSE/ACK：

- **claude**：仅支持 `cld cfuse` 路由（其它 route 直接 usage 报错）
- **kimi**：用 `-p`（无 `--auto`，自主权限由 config 提供）
- **codex**：用 `exec -s workspace-write --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`
- **grok**：直接 spawn
- **cursor-agent**：用 `--print --output-format stream-json`，`auto` 省略 `--model`

#### 信任模型

- **全能力 + auto-approve + 隔离 cwd**
- 子进程以**用户本人权限**运行、继承正常用户环境，**信任级等同于你亲手敲这条命令**
- 不可信 PR = PR 代码会被执行（测试/lint/构建），与 CI 同级风险，你用一条命令显式发起即视为知情同意
- 替代 permission flow 的不是策略引擎，而是「隔离 cwd + 用户同级信任 + 显式发起」三件套

#### Aggregator 配置

`--agents ... --aggregator <id>`：agentIds→Attempts、aggregator∈agents；`--council <ref>`：`council.agentIds`→Attempts、`council.reporterAgentId`→Aggregator。默认 Aggregator 是 grok（`review-adversarial`）。**Aggregator 自身也先跑一遍 Attempt**（其 findings 进对比），再做一次聚合 spawn。

#### 失败容错

- 单 Attempt 失败进入 `attemptFailures`，其余继续、聚合照常
- **瞬态失败（<120s 内非零 EXIT）自动重试一次**（quota/auth/model、超时/无输出/探针失败不重试）
- transcript 记录 `attemptNumber`/`retryOf`
- 全失败 → 不聚合、确定性失败报告、exit 4
- 聚合失败 → INCOMPLETE 报告 + exit 4
- SIGINT → 尽力落盘、exit 130

#### 恢复失败席位

```bash
councilkit review <url> --resume <run-id> [--json]
```

只重跑失败 Attempt，成功席复用。恢复入口先读 `runs/<run-id>/invocation-manifest.v1.json`（含 `--focus`/`--task`，shell 单引号转义）。

#### 选项

- `--timeout 45m`：默认 45 分钟（cld/kimi/grok）
- `--codex-timeout 90m`：默认 90 分钟
- `--concurrency 10`：默认并发 10
- `--focus "<text>"`：审查焦点（注入任务模板）
- `--against <run-id>`：增量陪审，优先保留原问题 ID
- `--repair-package <file>`：与 `--against` 配合，验证不可变的选定修复任务

#### 账本与闭环

- **Finding 账本**：每次 review 产生 `findings.json`
- `--against <prior-run>` 优先保留原问题 ID，并保留独立审查者报告的发现
- 失败、未覆盖、聚合报告未再提及都不会关闭旧问题
- `fix` 的复审默认带 `--against`

#### 关闭证据

- `apply` 只记录 `repairClaim`
- 关闭需要成功的独立审查者提交结构化验证，绑定本次完整候选 SHA，并提供测试命令或代码位置
- 控制器核对审查 worktree 的 HEAD 与受跟踪文件没有变化
- 聚合器不能代写关闭凭据，仍成立的发现优先于关闭声明
- 旧 `closed` 没有验证凭据时显示"历史未验证"，重大项仍待处理
- 证据来自独立模型审查，不能理解为控制器已经重跑并认证了其所有测试

#### Live Transcript

每个 attempt 的 driver 过程事件（text/thinking/tool call）增量写入 `runs/<runId>/live/<attemptId>.jsonl`（CLI 侧 `cli/src/auto/live-events.ts`，写失败静默、2MB 上限）：

- grok 用 `streaming-messages-json` 与 claude 共用解析器
- cursor-agent 用 `stream-json`，`auto` 省略 `--model`
- probe 仍用单对象 `json`

Host 端点 `GET /api/v1/cli-runs/:runId/attempts/:attemptId/live?afterSeq=N`（分页 + 坏行容忍）；`/reports/<runId>` 的 attempt 卡片展开「过程」即可看实时输出。该 sidecar 是观察层，不进 transcript/report。

审查模板在 `cli/src/auto/templates/review.ts`。报告页席位「过程」里运行时长用 receipt/elapsed，live span 单列，running 时不以 span 盖过 elapsed。

#### 工作区与结果

- 工作区在 `runs/<review-id>/workspaces/<attemptId>/`
- 结果写 `status.json`（审查进行中时会写入席位耗时和最近一条工具/命令）
- 浏览器报告页轮询展示

## 修复流程 (`fix` / `apply` / `repair`)

### Finding 决策

打开 `/reports/<ck-review-id>`，点击「理解评审」。页面展示本次冻结区间的全部文件与变更片段，并在可信的旧/新侧源码位置插入意见。

每条意见只有「打算修复」「不修复」两个选择，可再次点击撤回为待决定，无需填写理由：

```bash
# 与页面使用同一决定记录，无须 reason；undecided 可撤回
councilkit findings decide --run <ck-review-id> --id <finding-id> --decision will_fix [--json]
councilkit findings decide --run <ck-review-id> --id <finding-id> --decision wont_fix [--json]
councilkit findings decide --run <ck-review-id> --id <finding-id> --decision undecided [--json]

# 旧的 accept 命令（标记为接受不修，须写理由）
councilkit findings accept --run <id> --id <finding-id> --reason <text> [--json]
```

未选择任何修复项时不能导出空任务包。任务范围外的观察单独保留；选中项通过不代表整个 PR 通过。

### `councilkit fix` — 方案陪审 → 一集群落地 → 对照账本复审

```bash
councilkit fix --run <ck-review-id> [--plan-only] [--no-re-review] [--no-push] [--json]
```

审查找出问题之后，不要直接「按报告全改」。`fix` 先让 planner（默认 Grok）起草修复方案，同一套 pr-jury **审方案本身**（方案 Aggregator 默认是 correctness，避免自己批自己），最多两轮修订；**只有 approve 才 apply**。

- 共识方案写入 `plan.lock.json`（每个集群有 `closes/files/gates`）
- 落地默认只做第一个未落地集群（一刀一 SHA，记入 `landings.jsonl`）
- 若 lock 里还有未落地集群，再次 `fix` 会跳过方案陪审直接下一刀
- 落地后默认再开一轮 jury，对照账本标 closed / 回归 / 新洞

浏览器报告页的「Squad 自动修复」会让 Host spawn `councilkit repair run`；次级「内置修复 / 只再审一遍」仍 spawn `councilkit fix`（Host 不跑 agent）。

选项：
- `--plan-only`：只出方案
- `--no-re-review`：落地后不复审
- `--re-review-only`：只开复审

### `councilkit apply` — 把锁定的一刀落到同一条 PR（不经 Host）

```bash
councilkit apply --run <ck-review-id> [--cluster <id>] [--all-clusters] [--agent <ref>] [--no-push] [--timeout 45m] [--json]
```

读已完成的 `ck-review-*` 报告，在隔离目录检出该 PR 源分支，默认用 **Grok**（`review-adversarial`，可用 `--agent` 覆盖）只落地 **第一个未落地集群** 并 `git commit`，然后 **默认 `git push`** 回同一条源分支。

- `--cluster <id>` 指定集群
- `--all-clusters` 才一次做完全部（旧行为）
- `--no-push` 只留本地改动
- 不发 PR 评论、不另开 PR、不 force-push
- 每刀在 `landings.jsonl` 记 `parentSha → candidateSha` 和声称关闭的 finding id
- GitHub 需要 `gh` + `git`；AntCode 需要 `antcode` + `git`（`antcode` 那条命令会清代理）
- 工作区在 `runs/<review-id>/workspaces/apply/`，结果写 `apply.json`

### `councilkit repair` — Squad 自动修复直到机器准出

```bash
councilkit repair run --from <ck-review-id> --profile <name> [--run-id <ck-repair-id>] [--max-outer-cycles 10] [--timeout 30m] [--json]
councilkit repair status --run <ck-repair-id> [--json]
councilkit repair stop --run <ck-repair-id> [--json]
councilkit repair resume --run <ck-repair-id> [--json]
```

父 Run 是 `ck-repair-<uuid>`。成功只认机器准出（`businessResult=approved`，exit 0）；`needs_attention` 非零；用户停止 130。Host 只 spawn 同 checkout 的 `councilkit repair …`，不 spawn `squadctl`、不读 `.squad/`。

`repair probe --json` 的 `version` 是协议版本 `squad-bridge.v1`；`toolVersion` 才是 `squadctl 2.1.0` 这类软件版本。生产 preflight 只认协议版本。首次子任务 intake 使用官方 `--new-repair-chain --project-id --repair-chain-id`。

跨 outer-cycle 要求 `squadctl history capabilities --json` 声明 `squad-history-bridge.v1`；旧版本在生产入口说明升级。具备该契约时，前一 task 在 writer 终止后 `history export`，下一 task `intake --history` 加重复 `--origin-task-dir`，来源目录只来自官方 export 且必须属于本 parent 已冻结 task。官方内部修复轮次与 CK `outerUsed` 分列。resume 复用同一 grant。stop 先核验冻结进程指纹再对确认属于本任务的进程组 TERM → 有界等待 → KILL；PID 复用则拒绝发信号。隔离工作区同时冻结 fetch 与 push URL。真实 squadctl smoke 在未安装 skill 的 CI 上 skip；本机有 `scripts/squadctl` 时默认会跑。强制要求实桥：`COUNCILKIT_SQUAD_SMOKE=1`。

#### 手工导出

```bash
# 导出全部或指定集群的修复任务包
councilkit repair export --run <ck-review-id> --out <file> [--cluster <id>] [--json]

# 只导出打算修复的选择集合及其原断言、反例、验收依据
councilkit repair export --run <ck-review-id> --selected --out <file> [--json]

# 候选修复后，保持同一任务范围与来源断言进行验收
councilkit review <pr-url> --against <ck-review-id> --repair-package <file> [--json]
```

导出要求审查完整成功且账本具有对应的完整 SHA；存在 `plan.lock.json` 时必须属于本轮且已批准。输出文件必须不存在。包保留问题 ID、来源 SHA、证据、修改范围、不变量和验收要求，范围外问题明确留待处理。

在目标仓库用 `hengzhuo-engineering-squad` 创建任务，`init --base-sha` 使用包中的 `source.sha`，随后执行：

```bash
"$SQUADCTL" intake --task-dir "$TASK_DIR" --package /tmp/repair.json
"$SQUADCTL" convergence --task-dir "$TASK_DIR"
```

`intake` 在尚未冻结的 briefing 阶段生成来源包、request 和 brief 草稿，不覆盖已有文件。Planner 核实草稿后再冻结计划和门禁；包中的命令是待核实输入。`convergence` 根据记录的修复轮次和问题 ID 提醒继续、诊断或预算耗尽，不产生 PASS。任务完成后仍需独立验收候选提交；本接口尚不自动把 CouncilKit 证据写成 Squad 门禁回执，也不自动发布本地候选。

报告列表按 PR 展示最近完整审查的证据 SHA、未决重大项、未验证修复和下一步。较新的失败审查单独提示恢复，不覆盖旧的有效证据；旧证据不代表远端当前 HEAD 已通过。对比与重复问题统计只沿同一 PR 的 `against` 链。详情页可复制导出命令。Host 继续只读 Squad sidecar，不接管其执行控制。

### Squad 角色配置

```bash
councilkit repair roles show [--json]
councilkit repair roles set --reviewer cursor:<model> | codex:<model> [--json]
councilkit repair roles reset [--json]
```

Show 或 change Squad repair role runtime/model。

## 产品创意讨论 (`ideate`)

```bash
councilkit ideate "<idea>" [--background "<text>"] [--debate-rounds 0|1|2] [--council product-jury] [--models '<json>'] [--json]
```

浏览器从侧栏「产品创意」进入 `http://127.0.0.1:43127/ideate`，填写创意与背景、选择辩论轮次和席位后开始讨论。此入口独立于报告页；启动后打开实时过程和决策报告，最近讨论也可从产品创意页继续查看。新增 Host 接口后需重启同仓库 Host，浏览器刷新只更新前端。

### 编排与权限

- **编排**：并行盲提 → 0–2 轮串行辩论 → 中立 Aggregator
- `--debate-rounds 0` 是主动跳过，不算故障
- **权限**：受限讨论，不修改用户项目、不 commit/push；不继承 review 的 bypass 开关
- Kimi headless 用 `-p` + `--agent-file`（不能与 `--plan` 同用）
- 部分席位失败仍可汇总：`status=completed` + `incomplete:true`，报告与列表标降级
- 无 fix / apply / re-review

### 选项

- `--models` 只覆盖本次席位/Reporter，不写回 `product-jury`
- `--models` 不能与 `--council` / `--agents` 同用
- `--agents` 用 JSON 数组（不是逗号分隔），避免名字含逗号/空格歧义

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 用法 / schema / 引用 / 校验（reporter 必填、悬空引用等） |
| 3 | Run 开始前 Host 不可达 / 认证 / installation / readiness 不可用 |
| 4 | Run 执行失败（turn / Reporter / ACK / SSE / Host 重启 / cleanup） |
| 5 | 本地 store / report IO |
| 7 | Host 配额拒绝 |
| 130 | SIGINT（先做有界 cleanup，再退出） |

## 凭据生命周期

- 报告与 transcript 默认在 `runs/<run-id>/`（`report.md` + `transcript.jsonl`）；`--out` 再原子复制一份到用户路径
- `report.md` 始终保留（部分报告在 run 失败时也写盘并标注 `INCOMPLETE`）
- 凭据（session cookie + CSRF）只存活于 CLI 进程内存，Host 重启后自动重取一次；**不落盘**、不出现在 `agents.json`/`councils.json`/transcript/报告/日志/`--json` 输出中
- `agents.json`/`councils.json` 不含 `installationId`/凭据——installation 每次 run/doctor/models 实时从 Host 解析（`state=trusted` 且 driverId 匹配；多个时取 Host 顺序第一个）

## 端口独占

`run` 的 live smoke 与浏览器/Host 共用 43127，且要求独占串行（不可与 vitest/playwright 并发）。端口被占用时用 `lsof -nP -iTCP:43127 -sTCP:LISTEN` 定位；CLI 不 kill 任何非自身进程。

## 调整默认审查席位

打开 `/reports` 即可查看 `pr-jury` 当前的默认角色、模型与汇总席位。点击「调整席位」，在每个角色的下拉框中选择模型来源、路由与模型；也可以添加已有 Agent、移除非汇总席位，或指定新的汇总席位。点击「保存默认席位」后，后续 PR 审查使用这份配置。页面不再提供自由输入模型 ID 或一次性模型组合。

模型选项来自实时目录、本机已保存的 Agent 与 Codex 模型缓存，因此目录尚未同步的新模型（如 `gpt-6-astra`）也可直接下拉选择。启动审查时仍会探测实际可用性。

配置原子写入 `councils.json` 中 `pr-jury` 的 `agentOverrides`，不修改共用 Agent 的角色职责与全局模型，也不影响其他 Council 或已开始的 Run。至少保留 1 个席位、最多 8 个；汇总席位必须在班子内。CLI 可用 `councilkit jury show --json` 查看实际默认配置，用 `jury save --config '<json>'` 更新；过期 revision 会拒绝保存，避免覆盖另一个页面的调整。`init --force` 重建 Council 时会清除这组覆盖配置。

## 另见

- [Runtime Host 运维](host-operations.md) — launchd 托管、诊断、端口管理
- [报告页与账本](report-page.md) — 审查报告查看、finding 决策、修复流程
- [AGENTS.md](../AGENTS.md) — Coding agent 的最短路径
