# AGENTS.md — CouncilKit for coding agents

CouncilKit 是本地优先的多 Agent 决策产品。**CLI（`councilkit`）** 让你在浏览器关闭时，通过本地 Runtime Host（`http://127.0.0.1:43127`）完成「查看模型 → 建 Agent/Council → 发起多轮讨论 → 拿 Markdown 报告」全流程。CLI 与浏览器数据不互通（独立本地存储）。术语只用 **Driver Selection / Council / Reporter / Run / Autonomous Run / Attempt / Aggregator / Task Template**（不使用浏览器的 Room/Facilitator）。例外：**Autonomous Run**（如 `review` 命令）不经 Runtime Host，直接 spawn 全能力 agent 子进程，见 `docs/brainstorms/2026-07-29-autonomous-parallel-review.md`。

## 前置

1. 仓库根 `pnpm install --frozen-lockfile`。
2. 构建 CLI：`pnpm build:cli`（产物 `cli/dist/main.mjs`，bin = `cli/bin/councilkit.mjs`）。
3. 启动 Runtime Host：`pnpm start`（或 `pnpm dev`），浏览器可关。Host 不可达时 CLI 退出码 3，**绝不自动拉起 Host**，也**绝不 spawn Host**。

## 最短路径（`--json` 机器可读）

`--json`：进度/诊断走 stderr，stdout 只出一个最终 JSON。退出码见 README CLI 章节（0/2/3/4/5/7/130）。

```bash
# 0. 一键写入默认审查班子（不经 Host；PATH 上有 cld/kimi/codex 才建对应 Agent）
pnpm exec councilkit init --json
# 之后审查不再手写 --agents JSON：
pnpm exec councilkit review --council pr-jury --pr <url> --json
# Host 运行时浏览器打开 http://127.0.0.1:43127/reports/<runId>
```

`init` 写入 Agent `review-security` / `review-correctness` / `review-maintainability`（PATH 上有 `grok` 时再加 `review-adversarial`）与 Council `pr-jury`（reporter = `review-correctness`，缺则用已发现的第一个）。已存在的同名记录默认复用；`--force` 先删 `pr-jury` 再重建默认组。

```bash
# 1. 自检 Host + 实时模型闭集（讨论 Run 才需要；review 不需要）
pnpm exec councilkit doctor  --json
pnpm exec councilkit models  --json
```

`models --json` 每条含 `driverId / route / installationId / catalog / cachedAt / error`。从实时 catalog 选 modelId（不要硬编码）：

```jsonc
// models --json 片段
{ "driverId":"claude-stream-json", "route":"cfuse",  "catalog":["antchat/GLM-5.2[1m]", "..."], "error":null }
{ "driverId":"kimi-stream-json",   "route":null,     "catalog":["kimi-code/k3"],              "error":null }
{ "driverId":"grok-stream-json",   "route":null,     "catalog":["grok-4.6","grok-4.5"],       "error":null }
```

```bash
# 2. 建两个 Agent（Driver Selection = driverId + 类型化 options；不含凭据/installationId）
pnpm exec councilkit agent create --name A --persona-prompt "..." \
  --driver-id claude-stream-json --options '{"route":"cfuse"}' \
  --model-id "antchat/GLM-5.2[1m]" --color "#a1b2c3" --json
pnpm exec councilkit agent create --name B --persona-prompt "..." \
  --driver-id kimi-stream-json --options '{}' \
  --model-id "kimi-code/k3" --color "#b2c3d4" --json
```

每条 `agent create --json` 返回 `{ "id":"...", "name":"...", "driverId":"..." }`。后续命令用 id 或 name 引用（id 精确优先；name 唯一时也可）。

```bash
# 3. 建 Council（reporter 必填且在 agents 中；--agents 是 JSON 数组）
pnpm exec councilkit council create --name smoke --topic "..." \
  --background "..." --target-output "..." \
  --agents '["<A-id>","<B-id>"]' --rounds 2 --reporter "<B-id>" --json
```

```bash
# 4. 发起 Run（固定 N 轮 + 一次 Reporter 总结；报告落 runs/<run-id>/report.md）
pnpm exec councilkit run --council "<council-id>" --rounds 2 --json
```

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

### 一次性 Run（免存 Council）

```bash
pnpm exec councilkit run --agents '["<A-id>","<B-id>"]' --topic "..." \
  --reporter "<B-id>" --rounds 2 --json
```

## 关键约束

- **Reporter 必填**，不静默 fallback；Agent 被 Council 引用时不可删除（先删 Council）。
- Council 人数（含 Reporter）≤ 8（Host `maxParticipantsPerScope`）。
- `agents.json`/`councils.json` 严格 schema + `version`，无凭据字段；损坏文件给可诊断错误（不回显原文）。
- 凭据（cookie/CSRF）只存进程内存，Host 重启自动重取一次；不落盘、不出现在任何输出。
- CLI 只保证与**同 checkout** Host 互通；与浏览器数据不互通；V1.1 无 `--resume`。
- live smoke 与 Host 共用 43127、独占串行；端口被占只 `lsof` 记录，不 kill 非自身进程。

## 目录速览

- `cli/src/`：CLI 源码（commands/run/report/host/store）。`cli/tests/` 单测。
- `tests/smoke/live-cli-run-smoke.ts`：真实 cfuse+kimi 两轮 + Reporter 的 live smoke（构建后用 `TSX_TSCONFIG_PATH=tsconfig.integration.json pnpm exec tsx` 驱动）。
- `src/`、`runtime-host/`：浏览器与 Host（CLI 复用 `src/runtime/client.ts` + `event-stream.ts`，不改它们）。