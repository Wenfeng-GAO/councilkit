# 复盘与优化:councilkit review 报告 UX 与运行策略

日期:2026-07-31
定位:下一轮 squad 的需求文档。基于 review 功能上线后的 6 次真实 run(PR#1、AntCode 1443×3、AntCode 1506×2,含一次 --resume)复盘。
前置:`docs/brainstorms/2026-07-29-autonomous-parallel-review.md`、`docs/plans/2026-07-30-001-feat-review-hardening-plan.md`(均已交付)。

## 0. 用户反馈(2026-07-31,最高优先级)

1. **时长不要用 ms 展示**。当前:`— 303536ms`,期望:人类可读(如 `20m50s` / `5m12s`);
2. **报告结构乱**。需要诊断并重排(见 §2)。

## 1. 已验证的好设计(保留)

- tolerate + partial 报告(多次救场:1443 两次、1506 一次);
- `--resume`(1506 复用 claude 304s,只补跑两个失败者,kimi 瞬态失败重跑即成功);
- 探针(1443 拦下配额耗尽的 claude,10 秒级 fail-fast);
- 过程对比(直接证实代理规则被遵守、codex 读了用户 skill 库、kimi 的探索路径);
- 中文契约 + 五章节聚合(1506 报告产出高质量的共识/独有/分歧);
- 多视角价值(1506:沙箱误销毁是 correctness 独有发现,设计文档矛盾是 maintainability 独有发现)。

## 2. 报告结构诊断(基于 1506 实际报告)

```
# Autonomous Review Report
- Run / Task / Focus / Aggregator / Attempts(破折号列表) / Status / Started / Ended
---
## 概览 / ## 共识发现 / ## 独有发现 / ## 分歧 / ## 结论
## Appendix: per-attempt outputs          ← 英文标题,正文全中文
### 过程对比                               ← 混在 per-attempt 列表里
### review-security                        ← H3
## 发现 / ## 验证 / ## 结论                ← agent 自己的 H2,与报告章节同级!
```

问题:

- **层级冲突(主因)**:agent 交付物的 `## 发现/验证/结论` 是 H2,与报告自身的五章节同级,大纲彻底乱掉;
- **头部信息密度**:Attempts 破折号列表塞了 name/driver/model/状态/exit/时长,长 model 字符串挤在一起,时长还是 ms;
- **过程对比位置**:它是 run 级信息,却嵌在 Appendix 的 per-attempt 序列里,且命令列表不去重(NO_PROXY 前缀重复 4 行、连续 `cd` 重复 5 行);
- **中英混排**:Appendix 标题英文,正文中文。

## 3. 优化项 P1:报告 UX(下一轮 squad 主体)

**P1-1 时长格式化**
- 新增 `formatDurationMs(ms)`: `<60s` → `48s`;`<60m` → `5m12s`;`>=60m` → `1h02m03s`(或 `20m50s` 风格,grill 确认精确格式);
- 应用点:报告 Attempts 列表、过程对比、human 进度行、心跳行;**ReviewOutcome JSON 的 durationMs 数值不变**(机器契约不动)。

**P1-2 报告结构重排**
- 头部 Attempts 改为表格:`| Attempt | Driver/Model | 结果 | 耗时 | 工具调用 |`,信息一目了然;
- 附录标题中文化:`## 附录:各审查者交付物`;
- **per-attempt 输出整体降一级 + 内容转义**:`### <name>`(H3)之下,agent 原文的 H1/H2/H3 标题全部降级(H2→H4 或加前缀),或整体包进折叠块/引用块,保证报告大纲只有报告自己的 H2(grill 定:标题降级 vs 引用块);
- 过程对比提为独立的 `## 过程对比`(与五章节、附录同级),每 Attempt 一行:时长(格式化后)+ 工具调用数 + 去重后代表命令(相同命令连续重复只保留一次并标 `×N`;统一的 `NO_PROXY=...` 前缀折叠显示)。

**P1-3 进度输出对齐**
- human 进度/心跳行同步使用 formatDurationMs;心跳格式 `attempt X 仍在运行 (5m12s)` 已实现,确认一致。

## 4. 优化项 P2:运行策略(观察自真实 run)

- **P2-1 大仓库超时边界**:kimi/codex 在大型 Java 仓库稳定需要 18-30min,30min 默认刚好卡线(两次 killed)。选项:默认超时上调至 45min,或模板注入「验证策略建议」(静态审查优先、定向测试、全量 build 前先评估时长)。grill 定。
- **P2-2 瞬态失败重试**:kimi 曾 41s 早退(EXIT 1,日志显示 CLI 级错误),`--resume` 后成功。当前设计「失败不重试」。是否允许「<120s 的 EXIT 失败自动重试一次」?grill 定(与 grilling 原决策冲突,需显式改)。
- **P2-3 探索效率**:过程对比显示 kimi 大量 `cd`/切片探索后超时。模板可加一句效率提示(先用 `antcode pr diff` 落盘再分段读,而不是反复探索目录)。

## 5. 验收

- 单测:formatDurationMs 边界(0/59s/60s/59m/1h+)、报告层级(附录内无 H2)、命令去重、表格头部;
- 真实验证:对任一近期 MR 重跑 review,人工确认报告大纲(可用 `rg '^##' report.md` 检查层级)与时长格式。

## 6. 待 grill 决策点

**已定(2026-07-31,grilling 两轮)**:
- A1 时长格式:`<60s`→`48s`;`<1h`→`20m50s`;`≥1h`→`1h02m03s`;
- B1 附录层级:fence-aware 标题降级(附录 `### <agent>` 之下原文 H1–H6 降两级,全文的 H2 只属于报告章节;代码块内 `#` 不受影响);
- C1 过程对比去重:连续相同命令合并 `<cmd> ×N`;env 前缀统一剥掉并在小节开头说明一次;80 字符截断保留;
- D1 默认超时 30→**45min**,模板加「全量 build 前先评估时长,优先定向测试」;
- D2 **瞬态失败允许一次自动重试**:仅限 <120s 内以 EXIT(非零退出)失败;超时/NO_OUTPUT/探针失败不重试;transcript 标 retryOf;
- E1 模板加探索效率提示(先 `antcode pr diff`/`gh pr diff` 落盘再分段读);
- E2 Attempts 表:`| Attempt | Driver/Model | 结果 | 耗时 | 工具调用 |`,driver/model 合并一列;
- F1 transcript 新字段全部 optional(旧 run 可读);
- F2 重试记录:每次尝试一条 attempt.finished(含 `attemptNumber`,第二次带 `retryOf`),报告只展示最终一次,失败的首次在附录标注;
- F3 表格只用于报告头部固定五列,附录原文不表格化;
- F4 测试全注入零真实进程;真实验证 = 重跑近期 MR + `rg '^##' report.md` 查大纲。
