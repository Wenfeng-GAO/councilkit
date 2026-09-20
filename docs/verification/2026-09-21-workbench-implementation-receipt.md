# 固定席位工作台 · 实现交付回执

日期：2026-09-21。实现基线：main @ `2c5b903`（工作区未提交，本文件随改动一并交付）。设计契约：`docs/design/2026-09-20-review-workspace/v3-detail/`（WORKSPACE-STATES / DETAIL-SPEC / contracts/INTERACTION-SPEC / contracts/DELIVERY-PLAN）。本回执对照 DELIVERY-PLAN §6 给出。

## A：界面改善 —— 已交付

- A1 审查/修复分区与单份紧凑席位列表：kind=review 报告页重构为固定三栏工作台（184 全局导航 + 248 席位列 + 48 上下文栏 + 48 视图栏 + 28 状态栏）。席位单一数据源，桌面列表与 ≤900px 的 `<select>` 共用同一 zustand 选择器；Aggregator 独立「汇总」组置底；席位按声明序，状态变化不重排。
- A2 当前活动与跟随控制：单席过程视图钉底跟随、滚离底部暂停、「新增 N 条活动 · 回到最新」（N 按稳定活动行计）；席位完成只显示「报告已就绪 · 查看报告」，不抢阅读。
- A3 阅读连续性、键盘与窄屏：Tab 记忆 + 当前挂载会话内滚动锚点恢复；Tab roving tabindex + 方向键；1440/1120/900/390 四档布局（64px 图标栏 / select 选择器 / 菜单 dialog）；焦点 2px 蓝轮廓；200% 缩放与整页 WCAG 未验收（见「未验证」）。
- A4 容量基线：单席单 in-flight 请求、错误退避 2s→4s→8s→16s→30s 封顶、hidden 暂停/恢复续读、终态停轮询、增量折叠追加（`foldLiveEventsAppend`）、单席原始事件缓存 ≤2.5 MiB、渲染窗口 200 行 + 「显示更早」。** soak/性能数值预算未实测**（见「未验证」）。

## B：可靠结果 —— 已交付（B3 部分验证）

- B0 执行身份：`shared/runtime/execution-ref.ts` + `docs/verification/2026-09-20-b0-execution-identity.md`。`executionRef = <attemptId>#<generation>.<ordinal>`；generation = 1 + 之前 review.resumed 数；ordinal = 同代内终态记录序数。五场景（首次/自动重试/resume 重跑/显式复用/Aggregator 重跑）均可区分；运行中取预期序数，与终态一致，ref 全程稳定。退化语义见 B0 文档（硬崩溃无终态记录的场景需 CLI 补 started 记录才能闭合，本期未改写入侧）。
- B1 durable result API：`GET /api/v1/cli-runs/:runId/attempts/:attemptId/result`，zod schema `cliRunAttemptResultResponseSchema`。正文只取匹配执行的 durable `output`，按行全量直读绕过 detail 的 256KB+64KB 截断；failure/cancelled→unavailable+failure；空输出→empty；显式复用→reusedFrom；损坏→unavailable+哨兵 ref；终态无记录→unavailable。
- B2 前端状态机：`seatReportView` 三轴映射（INTERACTION-SPEC §3 逐条），无假 verdict/假计数/解析等待动画；正文只来自 result 端点，不用 live 冒充。
- B3 真实数据：对真实 run 的 transcript 经同一 handler 代码只读验证——`ck-review-a9eeca4f…` aggregator `aggregator#1.1`（6.7KB）+ 4 席 success（11–20KB）；`ck-review-15fd78be…` aggregator `aggregator#2.1`（resume 后 generation=2 生效）+ 3 席 success（7.8–8.7KB）。**HTTP 端到端待 Host 重启补验**（运行中的 Host 进程路由表无新端点，返回 404 非 401，session 机制本身有效）。

## C：后续增强 —— 未做（按计划）

历史选择器/版本列表、复杂检索、结构化 verdict/finding、跨席关系与证据定位均未混入本期。

## 测试证据

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`（4 tsconfig） | ✅ 0 错误（修了 HEAD 两处存量错误：cli-runs.ts 缺 HttpError import、repair-mutation.test.ts hintSource） |
| `pnpm test:unit` | ✅ 1344/1344（新增 execution-ref 18 + workbench-seat-detail 13） |
| `pnpm test:host` | ✅ 304/304（后端代理临时 bootout launchd Host 后跑绿；QA 复跑时 131 条因 43127 被用户生产 Host 占用报 PORT_IN_USE，stash 对照确认与改动无关） |
| `pnpm build` | ✅ vite + dist-host + cli |
| e2e review-live-workspace / finding-ledger-layout | ✅ 6/6（按工作台重写） |
| e2e cli-reports | 11/13；2 条依赖本机不存在的 fixture/脚本 driver，与本次改动无关 |
| e2e modal-focus | 未跑通（需 e2e Host 的 `/reset` 控制面，43127 被生产 Host 占用） |

## 视觉证据

/tmp/ck-workbench-shots/ 24 张（1440/1120/900/390 × 总览/成功席报告/过程/失败席/待运行）。真实渲染 + 真实 run 数据（43127 只读）。单席报告轴在截图时 mock 了传输（生产 Host 进程无新路由），其余 detail/live 全真实 HTTP。实测：三栏 184/248/弹性、双 48px 栏、席位行 64px、四档无横向溢出、黄铜 Tab/侧线、InterVariable 生效。

## 未验证 / 遗留

1. **Host 重启后补一次纯 HTTP B3**（一条 curl 即可）+ 全量 e2e 补跑（cli-reports 2 条、modal-focus）。
2. 容量 soak（§3.2 数值预算、2 小时观察）未实测——只实现了行为约束，数字目标待 A4 基线测量。
3. 200% 缩放、整页 WCAG、性能预算未验收。
4. 跨 resume 的阅读连续性/executionRef 对齐视图恢复未实现（A 阶段承诺仅当前挂载会话，B 的 `runId+attemptId+executionRef` 恢复键留待后续）。
5. B0 已知缺口：硬崩溃无终态记录的执行与下一代重跑共享 ref（需 CLI `attempt.started` 事件闭合，文档已写最小改法）。
6. 未 commit；改动含 public/fonts、src/components/report/workbench/、runtime-host、shared、tests 等（git status 见上）。
