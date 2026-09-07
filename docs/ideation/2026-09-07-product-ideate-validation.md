# councilkit ideate 验证记录

日期：2026-09-07。依据 `docs/plans/2026-09-07-product-ideate-council.md`。证据目录：`/tmp/councilkit-ideate-baseline-20260907-163946`。

**这次修正后的真实三席 smoke 不是三模型全过。** 短探针 Grok/Kimi/GPT 都成功；提案阶段 Grok 与 GPT 成功，Kimi `kimi-code/k3` 在 302004 ms 后 `TIMEOUT`。不能把实现完成或自动测试通过写成真实三模型验收通过。

## 1. 范围与约束

- 未 `reset` / `clean` / `stash` / `commit` / `push`，未停止现有 Host。
- 现有 Host：`127.0.0.1:43127`，检查时 PID **80066**。未 kill。浏览器走查用隔离副本 + 临时代理，不改生产 Origin 守卫。
- 工作区与既有 review WIP 共存。仓库外基线：`/tmp/councilkit-ideate-baseline-20260907-163946`。HEAD 记录：`d8ebebba4a9d57374e15cbd12097c33787f59267`。
- 未放宽权限、未改鉴权、未静默换模型、未为通过而编造分歧。
- 浏览器发起用 **fake launch**（E2E Host 的假 launcher，不打真实模型）。降级详情用 **真实 transcript**（第一次 smoke）。方法见同目录 `browser-harness-notes.md`。

## 2. 实现摘要

`councilkit ideate`：并行盲提 → 0–2 轮串行辩论 → 中立 Aggregator。`kind=ideate`，`ck-ideate-<uuid>`。默认 Council `product-jury`。

- `init` 加法写入 `ideate-product` / `ideate-engineering` / `ideate-challenger`。Codex 席只在 PATH 有 `codex` **且**能从 `CODEX_HOME`/`~/.codex` 发现模型（顶层 `config.toml` `model=`，否则 `models_cache.json`）时创建；不猜 `"default"`。已配置 Reporter 不静默换人。
- 受限策略独立于 review bypass。Kimi headless：`-p` + `--agent-file` + `--skills-dir`，**不能**与 `--plan` 同用；隔离 `KIMI_CODE_HOME` 里 `default_plan_mode=true`，`default_model` 必须在 `[tools]` 之前的顶层。
- Host：`POST` ideate、`GET /api/v1/product-jury`。Reports：真实 roster/型号/Reporter、本次 `--models` 覆盖、创意筛选、完整性卡片、无 fix/apply/re-review。
- `parseTranscriptMeta` 读取 `ideate.finished` 的 `incomplete` 与 `integrity`，列表/详情 DTO 可见降级计数。
- 进度：`liveBeats` 现已通过 `onAttemptStart` / `onHeartbeat` / `onActivity` 写入 `status.json`。第二次 smoke 使用接线前的 CLI，故该 run 当时的进行中席位停在 `queued`；运行已经结束。

## 3. 自动验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 首次相关 CLI/Host | **首次未通过** | `ideate-first-tests.log`：3 个失败（grok restriction 文案、ideate auth path、policy argv）。之后复跑通过：`ideate-cli-retest.log`、目标化 155/155 |
| 隔离 Host/index/progress（含 integrity DTO） | **69/69** | `ideate-final-host-tests.log`（副本路径见该日志；传输适配见 `isolated-harness-notes.md`，不是未改源码的基线全绿） |
| 目标化回归（init fixture 修复后） | **154/154** 再加心跳测试后 **155/155** | `ideate-final-targeted-retest.log`、`ideate-final-targeted-after-heartbeat.log` |
| 最后配置边界修复后的独立复测 | **21/21**（policy 13、编排 8） | `final-boundary-heartbeat-tests.log`；这是针对最后变更的复测，不与前述重叠用例相加 |
| init Reporter fixture | 第二次 init 写入可发现的 Codex `model = "gpt-6-astra"`，Reporter 仍为已配置的 `ideate-product` | `cli/tests/init-command.test.ts`；复跑 `init-reporter-retest.log` 15/15 |
| 交付前 typecheck | **通过**（四份 tsconfig） | `delivery-typecheck.log`。此前 `post-heartbeat-typecheck.log` 仅余 `cli/tests/ideate-policy.test.ts` 未使用的 `IDEATE_KIMI_CONFIG`（TS6133），已删除 |
| 交付前 `pnpm build` | **通过** | `delivery-build.log`：Vite UI、`dist-host`、`cli/dist/main.mjs` |
| 真实 `init`（新临时 HOME，当前构建 CLI） | **通过** | `final-init.stdout.json`：`ideate-product`=`grok-4.6`，`ideate-engineering`=`kimi-code/k3`，`ideate-challenger`=`gpt-6-astra`，无猜测 `"default"` |

未跑全仓库无关套件；既有 review WIP 失败不归咎于本次。隔离 Host 测试曾因 43127 被占用而改 `listen(0)` + 保留规范 Host/Origin，**不是**改生产守卫。

## 4. 真实模型 smoke

公开创意：为独立开发者做每周整理用户反馈并给出下周验证任务的本地工具。背景：单人、两周、不接付费第三方数据、第一版不自动发消息。

### 4.1 第一次（Kimi argv 不兼容）

- 命令：`live-smoke-command.json`。HOME：`/var/folders/.../councilkit-ideate-live-8v9w8vh2`。
- **runId：`ck-ideate-884bbb0c-c435-4f82-a28b-aa8cc2d6472b`**
- 退出码 0，`status=completed`，`incomplete=true`。
- 完整性：提案 **2/3**，辩论 **2/3**，型号配置 **2/3**。
- Kimi 失败：`error: Cannot combine --prompt with --plan.`（实现兼容 bug，不是登录问题）。
- 报告仍有推荐行动、方案对比、分歧、验证/停止条件。路径见 `live-smoke.stdout.json`。
- 该 run 被独立浏览器测试导入，截图：`ideate-real-degraded-report.png`、`ideate-live-inspector.png`。

### 4.2 Kimi 调用修复（实现）

1. Headless 去掉 `--plan`，保留 `-p` / `--agent-file` / `--skills-dir` 与隔离 `default_plan_mode=true`。
2. `buildIdeateKimiConfig`：`default_model` 放在 `[tools]` 之前。外部探针曾出现 `no default model configured`（`kimi-probe-result.json`），属 TOML 语义，不是鉴权。表头解析现忽略行尾 `#` 注释，未知表结束上一节，避免把 `[[hooks]]` 拷进隔离配置。

本地 argv 测试覆盖 `--prompt` 与 `--plan` 互斥，以及 TOML 顶层 `default_model`。

### 4.3 第二次修正 smoke（当前，非三模型全过）

- 命令：`live-smoke-corrected-command.json`。HOME：`/var/folders/.../councilkit-ideate-live-corrected-1n1sqa3h`。
- 构建后 CLI：`--timeout 300s`、`--run-timeout 1800s`、`--debate-rounds 1`、三模型 `--models`（grok-4.6 / kimi-code/k3 / gpt-6-astra）。
- **runId：`ck-ideate-009e6a70-bc6e-4783-83bc-65d51e8dc407`**
- 退出码 0，`status=completed`，`incomplete=true`。总墙钟约 882 s（`09:39:05`–`09:53:46Z`）。**不是三模型全过。**
- 完整性：提案 **2/3**，辩论 **2/3**，型号配置 **2/3**。失败席：`proposal-seat2` 与 `debate-r1-seat2` 均为 `TIMEOUT`（5m00s）。
- Aggregator：`gpt-6-astra`。报告为降级建议：先验证、暂不完整开发；对比 seat1 周报闭环与 seat3 决策账本；保留分歧与验证/停止条件。`report.md` 路径见 `live-smoke-corrected.stdout.json`。

| 阶段 | Grok | Kimi | GPT |
| --- | --- | --- | --- |
| 探针 | 成功 | 成功 | 成功 |
| 提案 | 成功，132258 ms | **失败 TIMEOUT 302004 ms**，无正文，`toolCalls: 0`，无 `live/proposal-seat2.jsonl` | 成功，83760 ms |
| 辩论 | 成功，89144 ms | **失败 TIMEOUT 5m**；日志再次 `APIEmptyResponseError` | 成功 |

Kimi 提案会话日志（脱敏，无凭据）：隔离 `KIMI_CODE_HOME` `ck-ideate-kimi-86OtY0`。

- `09:39:35` `llm request`，`model=k3`，`thinkingEffort=max`，`toolCount=0`。进程立刻发出请求，**不是驱动未启动**。
- `09:43:21`（约 226 s）`APIEmptyResponseError`：API 只返回 thinking，无 text/tool calls；`finishReason=completed`。
- `09:43:22` / `09:44:28` 内部重试 0.2，同样空正文。
- `09:44:29` 开始 0.3；CouncilKit 在 5 分钟处杀掉。

辩论席 `ck-ideate-kimi-CqxL4t`：`09:46:06` 再次 `thinkingEffort=max`；`09:49:48` 同样 `APIEmptyResponseError`，并开始 0.2。

**判定：** 短探针成功 ⇒ 登录与模型发现可用。长提案不是 argv/鉴权回归。Kimi 日志记录的是 **`APIEmptyResponseError`（只返回 thinking、无 text/tool calls）+ 内部重试 0.2/0.3，随后被 attempt TIMEOUT 杀掉**。没有证据表明加长超时就会得到可用正文；未因此放宽权限或换模型。

Grok/GPT 两份成功提案可比较：seat1 做「周报 → 验证任务」闭环；seat3 主张先做「反馈到验证的本地决策账本」、允许证据不足时零任务。辩论 seat1 部分吸收 seat3 约束，反对用单张账本替换周闭环。

### 4.4 有界 Kimi 单席诊断（一次，90 s）

Smoke 自行结束后，用同一受限 argv（`-m` `-p` `--output-format` `--agent-file` `--skills-dir`，无 `--plan`）和真实工程席提案 prompt（1362 字节，未换模型）做一次诊断。证据：`kimi-proposal-diagnostic.json`、`kimi-proposal-diagnostic.log`。

- 965 ms 出现首包 stdout（59 字节）；不是驱动未启动或卡在 spawn。
- 日志：`09:54:05.332Z` `llm request`，`model=k3`，`thinkingEffort=max`，`toolCount=0`。
- 90 s 边界到达时仍无 `APIEmptyResponseError`（smoke 里该错误约 226 s 才出现）。进程被 SIGTERM（exit 143）。
- 结论：进程已启动并发出模型请求；90 s 诊断未取得正文，不能单独确定服务端空正文的根因，也不能证明延长超时会成功。未放宽权限、未换模型、未再跑完整三席。

## 5. 浏览器

方法（`browser-harness-notes.md`）：

- 不改、不停现有 43127 Host。
- 副本：`git archive HEAD` + 当时工作区；仅副本 `runtime.listen(0)` + HTTP 代理。
- 浏览器 URL 与 Host/Origin 仍为 `http://127.0.0.1:43127`。生产 Origin/CSRF/cookie 守卫未改。
- 表单提交走仓库 **fake E2E launcher**，不打真实模型。
- 降级详情导入第一次真实 smoke 的 transcript/report/status/live。

结果：

- 仓库 E2E 同步断言后 **15/15**：`browser-final-retest.log`。
- 独立走查 **2/2**：`browser-independent-tests.log`。真实三席 roster/型号/Reporter（含 gpt-6-astra）、填写并提交、创意筛选定位新 run、详情无 fix/apply；导入真实降级报告见 2/3 提案/辩论/型号，并可打开 Live。
- 截图：`ideate-form.png`、`ideate-filter.png`、`ideate-real-degraded-report.png`、`ideate-live-inspector.png`。后两张是第一次降级 smoke，**不是**第二次三席已完成的证据。

## 6. 剩余限制

1. **Kimi 长提案/辩论在 `kimi-code/k3` + `thinkingEffort=max` 下出现 `APIEmptyResponseError`（仅 thinking）并内部重试，最终 `TIMEOUT`。** 探针可通过。没有加长超时即能出正文的证据。未换模型、未放宽受限策略。第二次 smoke 是降级（2/3 提案来源），不能称三模型共识。
2. 第二次 smoke 使用接线前 CLI：`status.json` 对进行中席位保持 `queued`。源码已接 heartbeat；该 run 本身不会回溯改写。
3. 浏览器提交是 fake launch；真实模型只在独立 CLI smoke。
4. 现有 43127 Host 不是本次为验收拉起的同 checkout 实例；隔离代理只用于外部 E2E。
5. 产品范围：无 ideate resume / against / fix / apply；无实时检索。
6. `init` 的 Codex 席需要可发现模型；仅 PATH 有 `codex` 不够（已测）。
7. **已修复。** `buildIdeateKimiConfig` 现在按注释感知的表头解析，且无法识别的 `[…]` 行会结束上一节。只有 `models` / `providers` 表进入隔离配置。复现脚本 `check-kimi-config-boundary.mts` 中的 `[[hooks]] # …` 与 `[hooks] # comment` 不再被拷贝。测试：`cli/tests/ideate-policy.test.ts`。此边界缺陷与模型空正文分别记录，不用 `toolCount=0` 推断是否执行过 hook。

第二次真实 smoke 的[最终报告](/var/folders/4w/78rpd47s5cg2t0xtwydbv_m00000gn/T/councilkit-ideate-live-corrected-1n1sqa3h/runs/ck-ideate-009e6a70-bc6e-4783-83bc-65d51e8dc407/report.md)已人工检查：建议先验证，包含周报、决策账本和现有笔记三种路径的对比，保留分歧，并给出首个验证动作及成功、停止条件。临时浏览器 Host 和代理已关闭；现有 43127 Host 保留。

## 7. 最短路径（已写入 README / AGENTS.md）

```bash
pnpm exec councilkit init --json
pnpm exec councilkit ideate "一句话创意" --background "用户、约束、非目标" --debate-rounds 1 --json
```

`--models` 只覆盖本次。Host 运行时可打开 `http://127.0.0.1:43127/reports`。
