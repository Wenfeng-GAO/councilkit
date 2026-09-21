# CouncilKit

Local-first rooms for multi-agent decisions.

CouncilKit 组织本地、结构化的多 Agent 讨论：用户创建 Room、加入可复用 Agent、运行多轮讨论，由显式指定的 Facilitator 生成可持久化的 Round Summary。浏览器从不直接调用模型供应商——所有模型执行都经过本机前台运行的 Runtime Host，Host 不可用时没有 browser-direct fallback。

## 前置条件

- macOS（V1 仅支持 macOS）。
- Node.js **22**（精确主版本；`cli/package.json` `engines.node=^22` 是下限，不以最新 patch 冒充 floor。Runtime Host 启动时校验，其他主版本会以结构化错误拒绝启动并退出）。
- pnpm。
- Chromium（仅 `pnpm test:e2e` 需要）。
- 至少一个已安装并登录的本机 CLI：
  - `cld`（Runtime Driver `claude-stream-json`，支持 `cld ant glm5.2` / `cld moonshot` / `cld deepseek` / `cld cfuse` 四条 route；`cld cfuse` 经 `cfuse-claude-code` 后端透传，不依赖 `claude` binary）。
  - Codex CLI（Runtime Driver `codex-app-server`，即官方 `codex app-server`）。
  - 本地 `kimi` CLI + coding plan 登录（Runtime Driver `kimi-stream-json`，模型 `kimi-code/k3`，发现路径含 `~/.kimi-code/bin`）。
  - 本地 `grok` CLI + `grok login`（Runtime Driver `grok-stream-json`，模型 `grok-4.6` / `grok-4.5`，发现路径含 `~/.grok/bin`）。
  - 本地 `cursor-agent` CLI + `cursor-agent login`（或 `CURSOR_API_KEY`）（Runtime Driver `cursor-stream-json`，默认模型 `auto`，发现路径含 `~/.local/bin`）。

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

CLI 不 spawn Runtime Host，也不直连模型供应商——除 `review` 外，所有执行仍经过本机前台运行的 Runtime Host（与浏览器共用同一个 `http://127.0.0.1:43127`）。所以先 `pnpm start`（或 `pnpm dev`）让 Host 跑起来，再开 CLI；浏览器可以关。Host 不可达时 `doctor`/`run` 以退出码 3 失败，CLI 永不自动拉起 Host。CLI 只保证与**同 checkout** 的 Host 互通（版本绑定）。

**例外：`councilkit review` / `councilkit ideate` / `councilkit apply` 不经 Host**——它们直接按 PATH 解析 `cld`/`kimi`/`codex`/`grok`/`cursor-agent` 并 spawn（见下「自主并行审查」），因此不需要 Host 运行，也不受退出码 3 约束。

### 命令

```bash
councilkit init [--force] [--json]                      # 发现本机 CLI，写入默认 pr-jury + product-jury
councilkit ideate "<idea>" [--background "<text>"] [--debate-rounds 0|1|2] [--council product-jury] [--models '<json>'] [--json]
councilkit doctor [--json]                              # Host 可达性 + installations + catalog 摘要
councilkit models [--json]                             # 当前可用 driver/route/model 闭集（实时 catalog）
councilkit agent create \
  --name <name> --persona-prompt <text> \
  --driver-id <claude-stream-json|codex-app-server|kimi-stream-json|grok-stream-json|cursor-stream-json> \
  --options '<json>' --model-id <id> --color <#rrggbb> [--disabled] [--json]
councilkit agent list|show <name|id>|delete <name|id> [--json]

councilkit council create \
  --name <name> --topic <text> [--background <text>] [--target-output <text>] \
  --agents '<["ref1","ref2"]>' --rounds <N> --reporter <ref> [--json]
councilkit council list|show <name|id>|delete <name|id> [--json]

councilkit run --council <name|id> [--rounds N] [--out path] [--json]
councilkit run --agents '<["ref1","ref2"]>' --topic <text> --reporter <ref> \
  [--background <text>] [--target-output <text>] [--rounds N] [--out path] [--json]

councilkit review <pr-url> [--repo <path>] [--council <name|id>] [--against <run-id>] [--timeout 45m] [--codex-timeout 90m] [--concurrency 10] [--json]
councilkit review --agents '<["ref1","ref2"]>' --aggregator <ref> \
  (--pr <url|number> | --task "<text>") [--focus "<text>"] [--against <run-id>] \
  [--timeout 45m] [--codex-timeout 90m] [--concurrency 10] [--out path] [--json]
councilkit review --council <name|id> \
  (--pr <url|number> | --task "<text>") [--focus "<text>"] [--against <run-id>] [--timeout 45m] [--codex-timeout 90m] [--concurrency 10] [--out path] [--json]
councilkit apply --run <ck-review-id> [--cluster <id>] [--all-clusters] [--agent <ref>] [--no-push] [--timeout 45m] [--json]
councilkit fix --run <ck-review-id> [--plan-only] [--no-re-review] [--no-push] [--json]
councilkit repair export --run <ck-review-id> --out <new-file.json> [--cluster <id>] [--json]

councilkit runs list [--json]                           # 列出 CLI 报告
councilkit runs open <run-id> [--json]                  # 打印 http://127.0.0.1:43127/reports/<id>
councilkit runs gc [--keep <days>] [--dry-run] [--all]  # 只清 workspaces
```

首次使用审查：

```bash
pnpm exec councilkit init --json
pnpm exec councilkit review <url> --json
# Host 运行时打开 http://127.0.0.1:43127/reports
pnpm exec councilkit fix --run <ck-review-id> --json     # 方案陪审 → 一集群落地 → 对照账本复审
pnpm exec councilkit apply --run <ck-review-id> --json   # 默认落地第一个未落地集群（grok + push）
pnpm exec councilkit review <url> --against <ck-review-id> --json  # 增量陪审：closed / 回归 / 新洞
pnpm exec councilkit ideate "一句话创意" --json                     # 产品创意：并行盲提 → 串行辩论 → 中立决策
```

#### `councilkit ideate` — 产品创意决策（不经 Host）

浏览器从侧栏「产品创意」进入 `http://127.0.0.1:43127/ideate`，填写创意与背景、选择辩论轮次和席位后开始讨论。此入口独立于报告页；启动后打开实时过程和决策报告，最近讨论也可从产品创意页继续查看。新增 Host 接口后需重启同仓库 Host，浏览器刷新只更新前端。

`init` 在 PATH 上发现 grok/kimi/codex 后写入 `ideate-product` / `ideate-engineering` / `ideate-challenger` 与 Council `product-jury`。`ideate-challenger` 还需要可发现的 Codex 模型（`~/.codex/config.toml` 顶层 `model=`，否则 `models_cache.json`）；仅 PATH 有 `codex` 不够。已配置 Reporter 不静默换人；默认优先 Codex，其次 product，再 engineering。`--force` 会同时重建 `pr-jury` 与 `product-jury`。

```bash
pnpm exec councilkit init --json
pnpm exec councilkit ideate "一句话创意" --background "用户、约束、非目标" --debate-rounds 1 --json
# Host 运行时打开 http://127.0.0.1:43127/reports
```

- 编排：并行盲提 → 0–2 轮串行辩论 → 中立 Aggregator。`--debate-rounds 0` 是主动跳过，不算故障。
- 权限：受限讨论，不修改用户项目、不 commit/push；不继承 review 的 bypass 开关。Kimi headless 用 `-p` + `--agent-file`（不能与 `--plan` 同用）。
- `--models` 只覆盖本次席位/Reporter，不写回 `product-jury`。`--models` 不能与 `--council` / `--agents` 同用。
- 部分席位失败仍可汇总：`status=completed` + `incomplete:true`，报告与列表标降级。无 fix / apply / re-review。

- `--agents` 用 JSON 数组（不是逗号分隔），避免名字含逗号/空格歧义。
- **Reporter 必填**：Council 必须显式指定一个 reporter agent（且在 agents 中），不静默 fallback。
- 讨论固定 N 轮（`council.rounds`，`--rounds` 覆盖），每轮各 agent 按序发言一次；N 轮后 Reporter 做一次最终总结调用，产出九段 Markdown 报告（与浏览器报告同章节集）。
- `--json`：进度/诊断全走 stderr，stdout 只出一个最终 JSON 文档。

#### `councilkit review` — 自主并行审查（不经 Host）

同一任务由 N 个全能力 agent（Attempt）在**隔离 git worktree**（`runs/<run-id>/workspaces/<attemptId>/`，同一 PR commit，不各自 clone）中独立并行做一遍，再由 Aggregator 对比汇总，产出 `report.md`（确定性头部含 Attempts 五列表格 + 中文五章节聚合正文 + `## 过程对比` + `## 附录:各审查者交付物`）+ `transcript.jsonl`。PR 审查需要本机已有该仓库：`--repo <path>`、`repos.json` 记忆，或在匹配 remote 的 clone 里直接跑。`--task` 仍用空 cwd。

- **不经 Runtime Host**：CLI 直接按 PATH 解析 `cld`/`kimi`/`codex`/`grok`/`cursor-agent` 并 spawn，绕过 scope/SSE/ACK。claude 仅支持 `cld cfuse` 路由（其它 route 直接 usage 报错）；kimi 用 `-p`（无 `--auto`，自主权限由 config 提供）；codex 用 `exec -s workspace-write --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`；cursor-agent 用 `--print --output-format stream-json`，`auto` 省略 `--model`。
- **信任模型**：全能力 + auto-approve + 隔离 cwd。子进程以**用户本人权限**运行、继承正常用户环境，**信任级等同于你亲手敲这条命令**。不可信 PR = PR 代码会被执行（测试/lint/构建），与 CI 同级风险，你用一条命令显式发起即视为知情同意。替代 permission flow 的不是策略引擎，而是「隔离 cwd + 用户同级信任 + 显式发起」三件套。
- `--agents ... --aggregator <id>`：agentIds→Attempts、aggregator∈agents；`--council <ref>`：`council.agentIds`→Attempts、`council.reporterAgentId`→Aggregator、`council.rounds` 忽略、`council.topic` 注入任务模板。默认 Aggregator 是 grok（`review-adversarial`）。Aggregator 自身也先跑一遍 Attempt（其 findings 进对比），再做一次聚合 spawn。
- 失败 tolerate：单 Attempt 失败进入 `attemptFailures`，其余继续、聚合照常；**瞬态失败（<120s 内非零 EXIT）自动重试一次**（quota/auth/model、超时/无输出/探针失败不重试），transcript 记录 `attemptNumber`/`retryOf`；全失败 → 不聚合、确定性失败报告、exit 4；聚合失败 → INCOMPLETE 报告 + exit 4；SIGINT → 尽力落盘、exit 130。`--timeout` 默认 45m（cld/kimi/grok），`--codex-timeout` 默认 90m。`--concurrency` 默认 10。失败席：`councilkit review <url> --resume <run-id>` 只重跑失败 Attempt，成功席复用；恢复入口先读 `runs/<run-id>/invocation-manifest.v1.json`（含 `--focus`/`--task`，shell 单引号转义）。
- **Live Transcript**：每个 attempt 的 driver 过程事件写入 `runs/<run-id>/live/<attemptId>.jsonl`（观察层，不进 transcript/report）。审查模板在 `cli/src/auto/templates/review.ts`。报告页席位「过程」里运行时长用 receipt/elapsed，live span 单列，running 时不以 span 盖过 elapsed。
- **Finding 账本**：每次 review 产生 `findings.json`，`--against <prior-run>` 优先保留原问题 ID，并保留独立审查者报告的发现。失败、未覆盖、聚合报告未再提及都不会关闭旧问题。`fix` 的复审默认带 `--against`。
- **关闭证据**：`apply` 只记录 `repairClaim`。关闭需要成功的独立审查者提交结构化验证，绑定本次完整候选 SHA，并提供测试命令或代码位置；控制器核对审查 worktree 的 HEAD 与受跟踪文件没有变化。聚合器不能代写关闭凭据，仍成立的发现优先于关闭声明。旧 `closed` 没有验证凭据时显示“历史未验证”，重大项仍待处理。证据来自独立模型审查，不能理解为控制器已经重跑并认证了其所有测试。

#### `councilkit repair` — Squad 自动修复直到机器准出

```bash
pnpm exec councilkit repair run --from <ck-review-id> --profile <name> --json
pnpm exec councilkit repair status --run <ck-repair-id> --json
pnpm exec councilkit repair stop --run <ck-repair-id> --json
pnpm exec councilkit repair resume --run <ck-repair-id> --json
```

父 Run 是 `ck-repair-<uuid>`。成功只认机器准出（`businessResult=approved`，exit 0）；`needs_attention` 非零；用户停止 130。Host 只 spawn 同 checkout 的 `councilkit repair …`，不 spawn `squadctl`、不读 `.squad/`。

`repair probe --json` 的 `version` 是协议版本 `squad-bridge.v1`；`toolVersion` 才是 `squadctl 2.1.0` 这类软件版本。生产 preflight 只认协议版本。首次子任务 intake 使用官方 `--new-repair-chain --project-id --repair-chain-id`。跨 outer-cycle 要求 `squadctl history capabilities --json` 声明 `squad-history-bridge.v1`；旧版本在生产入口说明升级。具备该契约时，前一 task 在 writer 终止后 `history export`，下一 task `intake --history` 加重复 `--origin-task-dir`，来源目录只来自官方 export 且必须属于本 parent 已冻结 task。官方内部修复轮次与 CK `outerUsed` 分列。resume 复用同一 grant。stop 先核验冻结进程指纹再对确认属于本任务的进程组 TERM → 有界等待 → KILL；PID 复用则拒绝发信号。隔离工作区同时冻结 fetch 与 push URL。真实 squadctl smoke 在未安装 skill 的 CI 上 skip；本机有 `scripts/squadctl` 时默认会跑。强制要求实桥：`COUNCILKIT_SQUAD_SMOKE=1`。

手工导出仍可用：

```bash
pnpm exec councilkit repair export --run <ck-review-id> --out /tmp/repair.json
# 也可用 --cluster <id> 选取已批准方案中的一个集群
```

导出要求审查完整成功且账本具有对应的完整 SHA；存在 `plan.lock.json` 时必须属于本轮且已批准。输出文件必须不存在。包保留问题 ID、来源 SHA、证据、修改范围、不变量和验收要求，范围外问题明确留待处理。

在目标仓库用 `hengzhuo-engineering-squad` 创建任务，`init --base-sha` 使用包中的 `source.sha`，随后执行：

```bash
"$SQUADCTL" intake --task-dir "$TASK_DIR" --package /tmp/repair.json
"$SQUADCTL" convergence --task-dir "$TASK_DIR"
```

`intake` 在尚未冻结的 briefing 阶段生成来源包、request 和 brief 草稿，不覆盖已有文件。Planner 核实草稿后再冻结计划和门禁；包中的命令是待核实输入。`convergence` 根据记录的修复轮次和问题 ID 提醒继续、诊断或预算耗尽，不产生 PASS。任务完成后仍需独立验收候选提交；本接口尚不自动把 CouncilKit 证据写成 Squad 门禁回执，也不自动发布本地候选。

报告列表按 PR 展示最近完整审查的证据 SHA、未决重大项、未验证修复和下一步。较新的失败审查单独提示恢复，不覆盖旧的有效证据；旧证据不代表远端当前 HEAD 已通过。对比与重复问题统计只沿同一 PR 的 `against` 链。详情页可复制导出命令。Host 继续只读 Squad sidecar，不接管其执行控制。

#### `councilkit fix` — 方案陪审 → 一集群落地 → 对照账本复审

审查找出问题之后，不要直接「按报告全改」。`fix` 先让 planner（默认 Grok）起草修复方案，同一套 pr-jury **审方案本身**（方案 Aggregator 默认是 correctness，避免自己批自己），最多两轮修订；**只有 approve 才 apply**。共识方案写入 `plan.lock.json`（每个集群有 `closes/files/gates`）。落地默认只做第一个未落地集群（一刀一 SHA，记入 `landings.jsonl`）；若 lock 里还有未落地集群，再次 `fix` 会跳过方案陪审直接下一刀。落地后默认再开一轮 jury，对照账本标 closed / 回归 / 新洞。浏览器报告页的「Squad 自动修复」会让 Host spawn `councilkit repair run`；次级「内置修复 / 只再审一遍」仍 spawn `councilkit fix`（Host 不跑 agent）。`--plan-only` 只出方案；`--no-re-review` 落地后不复审；`--re-review-only` 只开复审。

#### `councilkit apply` — 把锁定的一刀落到同一条 PR（不经 Host）

读已完成的 `ck-review-*` 报告，在隔离目录检出该 PR 源分支，默认用 **Grok**（`review-adversarial`，可用 `--agent` 覆盖）只落地 **第一个未落地集群** 并 `git commit`，然后 **默认 `git push`** 回同一条源分支。`--cluster <id>` 指定集群；`--all-clusters` 才一次做完全部（旧行为）。`--no-push` 只留本地改动。不发 PR 评论、不另开 PR、不 force-push。每刀在 `landings.jsonl` 记 `parentSha → candidateSha` 和声称关闭的 finding id。

- GitHub 需要 `gh` + `git`；AntCode 需要 `antcode` + `git`（`antcode` 那条命令会清代理）。
- 工作区在 `runs/<review-id>/workspaces/apply/`，结果写 `apply.json`。
- 审查进行中时 `status.json` 会写入席位耗时和最近一条工具/命令（包括 `--json`）；浏览器报告页轮询展示。

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

## 在报告页调整默认审查席位

打开 `/reports` 即可查看 `pr-jury` 当前的默认角色、模型与汇总席位。点击「调整席位」，在每个角色的下拉框中选择模型来源、路由与模型；也可以添加已有 Agent、移除非汇总席位，或指定新的汇总席位。点击「保存默认席位」后，后续 PR 审查使用这份配置。页面不再提供自由输入模型 ID 或一次性模型组合。

模型选项来自实时目录、本机已保存的 Agent 与 Codex 模型缓存，因此目录尚未同步的新模型（如 `gpt-6-astra`）也可直接下拉选择。启动审查时仍会探测实际可用性。

配置原子写入 `councils.json` 中 `pr-jury` 的 `agentOverrides`，不修改共用 Agent 的角色职责与全局模型，也不影响其他 Council 或已开始的 Run。至少保留 1 个席位、最多 8 个；汇总席位必须在班子内。CLI 可用 `councilkit jury show --json` 查看实际默认配置，用 `jury save --config '<json>'` 更新；过期 revision 会拒绝保存，避免覆盖另一个页面的调整。`init --force` 重建 Council 时会清除这组覆盖配置。

## 后台托管（launchd，macOS）

前台 `pnpm start` 之外，可以把 Runtime Host 交给 launchd 托管：登录后自动启动、崩溃自动拉起（KeepAlive，限频 10 秒）。先确保已 `pnpm build`（托管入口是 `dist-host/main.mjs`），然后：

```bash
node scripts/install-service.mjs            # 写入 plist（--dry-run 只打印不写盘）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.councilkit.host.plist
```

安装脚本只写 `~/Library/LaunchAgents/com.councilkit.host.plist`，**绝不代为 load**——上面的 `bootstrap` 需要你显式执行（旧版 macOS 用 `launchctl load -w`）。plist 把 Node 路径固定为运行脚本时的解释器，并注入常见 PATH 以保住 CLI 发现；**更换 Node 版本或移动仓库目录后必须重跑安装脚本**。托管后端口被占时会结构化退出、由 launchd 每 10 秒重拉，先用 `lsof`（见上节）排查占用。

验证托管生效：`launchctl list | grep councilkit` 出现非 `-` 的 PID，`curl http://127.0.0.1:43127/api/v1/health` 返回 200，且 Settings 页 Installations 仍为 trusted。日志在 `~/Library/Logs/CouncilKit/host.out.log` 与 `host.err.log`。

观察 **squad / review** 过程需要 Host 读 `COUNCILKIT_HOME/runs` sidecar。`councilkit review` / `apply` / `fix`（Autonomous Run）不经 Host 跑 agent，但浏览器打开 `http://127.0.0.1:43127/reports/<runId>` 必须有 Host。前台 `pnpm dev` 被杀 ≠ 观察消失——launchd 托管的 Host 仍应响应 `GET /api/v1/cli-runs/ck-squad-…`。Host 未起时 observe 写盘不失败；浏览器打开失败会提示「Host 未在 127.0.0.1:43127」，不是空白页。

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
pnpm typecheck   # 四个 tsc 程序：app、runtime-host、integration、cli
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
- V1 有五个内置 Runtime Driver：`claude-stream-json`、`codex-app-server`、`kimi-stream-json`、`grok-stream-json`、`cursor-stream-json`；legacy browser-direct Gateway 已在 U7 删除，Runtime Host 是唯一执行路径。

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
