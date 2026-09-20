# B0：当前执行身份（executionRef）映射说明

日期：2026-09-20。源码基线：工作区 HEAD `2c5b903`。配套实现：`shared/runtime/execution-ref.ts`（纯推导函数）、`tests/unit/execution-ref.test.ts`。契约依据：`docs/design/2026-09-20-review-workspace/v3-detail/contracts/INTERACTION-SPEC.md` §3/§5 与 `DELIVERY-PLAN.md` §2 B0 关口。

## 结论（一句话）

**不需要改 CLI 写入侧。** 现有 durable transcript 记录足以推导稳定执行身份：

```
executionRef = `<attemptId>#<generation>.<ordinal>`
```

- `generation` = 1 + 该执行之前出现的 `review.resumed` 记录数；
- `ordinal` = 同 attemptId、同 generation 内第几条 `attempt.finished`（Aggregator 为 `aggregation.finished`），从 1 计。

推导只依赖**记录顺序**，而 CLI 保证 transcript 是单写者、tmp+fsync+rename 原子重写、append-only 实践（`review.resumed` 显式「只 append 不改写历史」，`readReviewTranscript` 对损坏文件拒绝 resume），所以 ref 在一次执行的运行 → 终态全程稳定，且在原子重写/后续 append 后不变。

## 记录形状与写入时机（核实结果）

transcript.jsonl 只有**终态**记录，没有 `attempt.started` / `aggregation.started`：

| 记录 | 关键字段 | 写入时机 |
| --- | --- | --- |
| `review.started` | `runId / startedAt / task / attempts[] / aggregator`（aggregator 的 attemptId 恒为字面量 `"aggregator"`） | 全新 run 探针完成后、首个 attempt 前 |
| `review.resumed` | `runId（=被续跑的同一 runId）/ reusedAttemptIds / rerunAttemptIds / probe` | `--resume` 探针完成后、任一重跑前；**只 append** |
| `attempt.finished` | `attemptId / status / output（成功才有，失败为 null）/ exitCode / durationMs / failure? / attemptNumber? / retryOf? / resumedAfterFailure?` | 每次物理执行终态各写一条：首试 `attemptNumber=1`，瞬态重试二次 `attemptNumber=2, retryOf=1`（runner.ts `runSpecWithRetry`）；合成记录（DRIVER_UNREACHABLE / CANCELLED）不写 attemptNumber |
| `aggregation.finished` | 同上形态，`attemptId="aggregator"` | Aggregator 每次执行终态（Aggregator 永不瞬态重试；resume 必重跑） |
| `review.finished` | `status / endedAt / incomplete? / failure?` | run 终态 |

关键事实：

- `attemptNumber` **每次 resume 后重置**（重跑 seat 的新记录又是 `1`），所以单独的 `attemptNumber` 不能跨 resume 区分执行——必须用文件序数。
- `--resume` **延续同一 runId**，复用 seat 的成功正文直接来自同一 transcript 的历史记录，resume 不会跨 run 复制记录。因此 `reusedFrom.runId` 恒等于当前 runId。
- `review.resumed` 写入后，progress 推导会把 `rerunAttemptIds` 的终态记录从「当前状态」中剔除（`cli-run-progress.ts` 的 `finished.delete`），但**记录仍在文件里**，序数推导不受影响。

## 五场景区分

| 场景 | transcript 形态 | 当前 executionRef | 说明 |
| --- | --- | --- | --- |
| 1. 首次运行 | `attempt.finished ×1`（attemptNumber=1） | `attempt-0#1.1` | 运行中（无记录）推得预期序数 (1,1)，终态记录落地后一致 |
| 2. 自动重试（瞬态 EXIT） | 失败首试 `#1.1`（attemptNumber=1, EXIT, <120s）+ 重试成功 `#1.2`（attemptNumber=2, retryOf=1） | 首试运行中 `#1.1` → 首试终态后、重试运行中 `#1.2` → 重试终态 `#1.2` | 两个执行可区分；重试窗口内返回 in-flight，绝不把首试失败当当前结果 |
| 3. resume 重跑 | 旧代失败 `#1.1` … `review.resumed` … 新成功 `#2.1` | 重跑运行中 `#2.1` → 终态 `#2.1` | generation 由 resume 记录位置切分；旧记录保留但地址落在旧代 |
| 4. 显式复用（reusedAttemptIds） | 成功 `#1.1` … `review.resumed(reused=[该席])`（**无新记录**） | `#1.1` + `reusedFrom={runId, executionRef:#1.1}` | 源执行恒在本 run transcript 内；仅 `reusedAttemptIds` 算复用，rerun 席上的旧成功不作兜底 |
| 5. Aggregator 重跑 | `aggregation.finished#1.1` … `review.resumed` … `aggregation.finished#2.1` | 重跑运行中 `aggregator#2.1` → 终态 `aggregator#2.1` | Aggregator 每代一次；resume 必重跑（复用名单从不含 aggregator） |

## 运行中 → 终态稳定性

运行中没有 started 记录，身份取「预期序数」=（文件末尾的 generation，该 attempt 在本代已落终态记录数 + 1）。这正是该执行的终态记录落地后将获得的序数，因此只要执行留下 durable 记录，ref 全程一致。检测到「首试已失败 + 满足瞬态重试谓词（attemptNumber=1、EXIT、非零数值 exitCode、durationMs<120s、run 仍在运行）」时，当前执行切换为重试，ref 从 `#g.1` 变为 `#g.2`——这是**新执行开始的正确信号**，不是不稳定。

## 退化语义（精确）

1. **执行死亡且无终态记录**（SIGKILL/断电，runner 所有正常退出路径都会补记 ABORTED/CANCELLED，仅硬崩溃除外）：该执行与下一代同 attempt 的重跑**共享同一个预期 ref**（同代内则是同 ordinal）。durable 层面无法区分，只有 CLI 增写 `attempt.started` 记录才能闭合；本期不增写，前端按「同 ref 内容变化即新数据」处理。
2. **`failure.retryable` 不落盘**：`shouldRetry` 依赖的 `retryable=false`（如认证类 EXIT 失败）无法从 transcript 判断，运行期内该席会被保守报为 in-flight（availability=pending，executionStatus=running）；run 终态后立即收敛为 failure。影响有界（仅运行期内该席状态偏乐观）。
3. **旧数据**（无 `attemptNumber`、无 `review.resumed`、缺失 `attemptId` 的 `aggregation.finished`）：一律落在 generation 1；无 attemptNumber 的失败不预测重试（旧 CLI 本就不重试）；缺 attemptId 的 aggregation 记录归到唯一 Aggregator。身份依然可推导。
4. **身份完全不可恢复**（transcript 无 started 记录/整文件损坏）：返回哨兵 ref `<attemptId>#0.0`（generation/ordinal 恒为 0，与真实 ref 不冲突），availability=unavailable，不回显原始行。
5. **run 已终态但当前执行无记录**（如全部 attempt 失败导致 Aggregator 从未运行）：availability=unavailable（有限语义，不是永久 pending），executionStatus 取 run 终态映射。

## 对 B1 的要求（已在 B1 实现中落实）

- 正文只取与当前 executionRef 匹配的 `attempt.finished.output` / `aggregation.finished.output`；禁止 live sidecar 提取、按长度挑选、旧成功兜底。
- 读取绕过 detail API 的 256KB+64KB 截断与目录扫描上限：按行全量直读 transcript，markdown 无大小截断（truncated 恒 false；CLI 8MiB 流 cap 是写入侧属性，读取侧无法逐记录探测）。
- availability 映射：未结束→pending；终态非空→available；终态空输出→empty；失败/取消→unavailable+failure；无法确定正文→unavailable（有限语义）。
- 保留 session 认证、run/attempt 校验、COUNCILKIT_HOME 目录边界与非符号链接规则；损坏/越界不回显敏感内容。

## 后续可选（非本期）

CLI 增写最小 `attempt.started` 持久化身份事件可闭合退化 1 与 2 的全部残余不确定性；B0 证明现有记录对契约五场景已足够，故本期不改写入侧。
