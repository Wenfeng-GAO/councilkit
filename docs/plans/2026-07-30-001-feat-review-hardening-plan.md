# 计划:Review 能力加固(探针/代理/简历跑/过程可见/专业 Reviewer 团队)

日期:2026-07-30
前置:`docs/brainstorms/2026-07-29-autonomous-parallel-review.md`(权威设计)、2026-07-29 三次真实 run 的复盘(见 §0)
状态:待 grill-with-docs 敲定细节后开发。前置条件:review 分支(`squad/20260729-autonomous-review-a7x2`)完成集成。

## 0. 复盘结论(计划依据)

三次真实 run(PR#1 全员成功;AntCode run1 清代理翻车;AntCode run2 codex 超时)暴露的问题,按价值排序:

| # | 问题 | 证据 |
|---|---|---|
| R1 | driver 后端不可达时不 fail-fast,codex 403 白烧 275s + Aggregator 白烧 30min | run1 g4-progress.log |
| R2 | 无 resume,run1 失败后 run2 全额重跑(claude 942s + kimi 1497s) | 两次 run 时长 |
| R3 | 过程不可见,codex 超时只能靠 workspace 的 419MB target/ 反推 | run2 attempt-1 workspace |
| R4 | 模板对「怎么拿 PR」零提示,codex 在 AntCode 访问上反复折腾 | run1/run2 codex 行为 |
| R5 | 代理冲突:**codex 需要本地代理,内网/antcode 必须不走代理**;整条命令清代理会打死 codex,不清可能影响 antcode | run1 403 / run2 成功对照 |
| R6 | workspace 无 GC,3 次 run 占 1.0GB;claude 全程未用 workspace(隔离是建议) | du runs/ |
| R7 | 报告瑕疵:超时被杀显示「failed:TIMEOUT — exit 0」;kimi 输出中文标题(软契约容忍) | run2 report |
| R8 | persona 为空的占位 agent(摄影发烧友等)在用于生产 review,输出契约遵守度与专业度不可控 | store 现状 |

## 1. 范围与分期

### P1 — 快速加固(小改动,高杠杆)

**P1-1 driver 健康探针(R1)**
`review` 命令在打印 Attempt 清单后、任何 spawn 前,对每个涉及的 driver 做一次 ≤10s 的轻量探活(claude: `cld cfuse --print "ok"` 最小调用;kimi/codex 同理)。探活失败 → 该 Attempt 直接标记 `DRIVER_UNREACHABLE` 进 attemptFailures(不 spawn、不计时),并**跳过以该 agent 为 Aggregator 的聚合**(若 aggregator 不可达:exit 3 + 提示,不烧 30min)。探活结果进 transcript(review.started 增加 probe 字段)。

**P1-2 访问提示与代理规则进模板(R4/R5)**
- 任务模板按 `--pr` 的 URL host 注入「访问提示」块:
  - GitHub → `gh pr diff <url>` / `gh pr view`;
  - AntCode → `antcode pr diff <iid> -P <group/project> --no-pager`;
  - 其它 host → 无提示(agent 自主)。
- 代理规则(用户 2026-07-30 明确):**codex 必须走本地代理;请求内网或使用 antcode 等内部工具时必须不走代理**。实现为两层:
  1. runner 层:不动全局 env(继承用户环境,codex 天然有代理);**不**提供「整条命令清代理」的能力;
  2. 模板层:访问提示中写明「调用 antcode 等内部工具时,在该命令前加 `NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY=''`;模型 API 调用不要动代理设置」——agent 在 shell 里逐命令控制,而不是环境级一刀切。

**P1-3 专业 Reviewer 团队(R8)**
新建一套专职 review agent(store),取代占位 agent。每个 agent = 专业 persona + 不同 driver/model(保持多模型族)。建议三席:

| agent | driver/model | 职责(personaPrompt 要点) |
|---|---|---|
| `review-security` | claude cfuse | 安全审查:注入/鉴权/数据暴露/密钥/依赖供应链;只报可利用路径,标严重度与复现条件 |
| `review-correctness` | codex | 正确性审查:逻辑错误、边界条件、并发/状态、错误处理;要求给出反例场景 |
| `review-maintainability` | kimi | 可维护性/架构审查:耦合、抽象适度、命名、测试缺口、与仓库既有约定的一致性 |

- personaPrompt 为完整中文专业指令(参考 ~/.kimi-code/skills 的 security-reviewer/correctness-reviewer/maintainability-reviewer 骨架,裁剪为 review 场景);
- 同时建 `council review-team`(reporter = review-correctness 或按 grill 决定);
- 交付物:`councilkit agent create`/`council create` 命令序列 + personas 存 `docs/vibespec/` 或 `.squad` 之外的持久位置(grill 定)。

**P1-4 报告瑕疵与契约语言(R7 + grill 决策)**
- Attempt 被 kill(超时/中断)时报告与 outcome 的 exitCode 显示 `killed` 而非 `exit 0`;
- **输出契约改用中文标题**(2026-07-30 grill 决策):Attempt 契约 = `## 发现` / `## 验证` / `## 结论`;聚合五章节 = `## 概览` / `## 共识发现` / `## 独有发现` / `## 分歧` / `## 结论`;聚合指令注明「reviewer 可能仍用英文标题(Findings/Verification/Verdict),按语义理解」;不做解析层别名(附录原文渲染)。

### P2 — 过程可见与续跑(中改动)

**P2-1 stream-json 过程摘要(R3)**
runner 在收集 stdout 时增量解析 stream-json,提取每 Attempt 的「工具调用计数 + 命令摘要(≤N 条)」,写入 transcript(attempt.finished 增加 `activity` 字段)与报告附录(「过程对比」小节:谁跑了测试、谁只读 diff)。同时给 human 模式进度行加阶段性心跳(每 30s 一行「attempt X 仍在运行,已 N 分钟」)。

**P2-2 `--resume <run-id>`(R2)**
读取既有 run 的 transcript:status=success 的 Attempt 直接复用其 output(不重新 spawn,标记 `reused`),仅重跑 failure/TIMEOUT 的 Attempt 与聚合。transcript 追加 `review.resumed` 记录。不带 --resume 时行为不变。

**P2-3 `councilkit runs gc`(R6)**
新子命令:清理 N 天前(默认 7)的 runs/<id>/workspaces;`--dry-run` 预览;report/transcript 永远保留,只清 workspace。

### P3 — 验证深度分级(后续,本次只预留)

模板参数化验证深度:`--depth quick|standard|deep`(quick=静态审查禁 build;standard=可跑定向测试;deep=完整 build)。本次仅在模板接口预留参数位,不实现。

## 2. 明确不做

- 不改 Host/浏览器端;不动既有 discuss/run;
- 不做 workspace 强制隔离(已声明非安全边界,接受 agent 可 roam);
- 不做 findings 结构化 JSON schema(仍为自由 Markdown);
- 不做用户自定义任务模板(design 模板仍按 V2 另立)。

## 3. 待 grill 敲定的决策点

**第一轮已定(2026-07-30)**:
- A1: Attempt 探针失败标记 `DRIVER_UNREACHABLE` 跳过;Aggregator 不可达 → 整 run exit 3 中止;
- A2: 每 driver 一次真实最小调用(≤10s),同 driver 复用,结果进 `review.started.probe`;
- B1: 代理规则纯 prompt 提示(命令级 NO_PROXY),不做 runner 层 PATH wrapper;
- B2: 访问提示按 host 硬编码(GitHub→gh;AntCode→`antcode pr diff <iid> -P <group/project> --no-pager`,project/iid 从 URL 解析);
- C1: 三席 = review-security(claude cfuse)/ review-correctness(codex,兼 aggregator)/ review-maintainability(kimi);另建 `council review-team`;
- C2: persona 由我按 ~/.kimi-code/skills 三 reviewer 骨架裁剪起草;旧占位 agent 保留;
- D1: `--resume` 按 Attempt 复用(标 `reused`),限同 run-id 且参数一致,不一致 exit 2;
- D2: gc 默认 7 天,`--dry-run/--all/--keep <days>`,report/transcript 永留;
- D3: 契约与聚合章节**改用中文标题**,聚合指令注明英文标题按语义理解。

**第二轮已定(2026-07-30)**:
- E1: verdict 令牌保留英文 `approve|changes-requested|comment`(单行机器友好);
- E2: 过程摘要 = `attempt.finished.activity { toolCalls, commands[](≤10 条,每条 ≤80 字符) }`;报告附录「过程对比」小节含**每 Attempt 时长**、工具调用数、代表性命令;human 进度 30s 心跳;解析失败降级「无过程数据」不报错;
- E3: reused Attempt 不探针;重跑 Attempt 与 Aggregator 照常探针;
- E4: 顺序 = 探针 → 模板提示 → 报告/契约 → 团队配置;测试全走注入,零真实进程零网络;
- E5: persona 不写输出契约——persona 只定职责与视角,契约由任务模板统一注入。

## 4. 验收(开发完成后)

- G1-G3 同前(build/cli 单测/biome 全绿,新增测试覆盖探针/resume/gc/模板提示);
- G4':用新专业团队重跑 AntCode MR 1443,对比本次报告与 2026-07-29 报告的差异(专业度、契约遵守);
- G5:故障注入——断网/掐代理下探针 fail-fast 行为正确;人为 kill 一个 Attempt 后 `--resume` 只补跑它。
