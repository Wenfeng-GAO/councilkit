# 固定席位工作台 · 独立验收报告

日期：2026-09-21。源码基线：`96e554b4510619b2742f5daa3da3ba3794258983`；工作台主提交：`4ffcebe`。目标：已发布的 `http://127.0.0.1:43127`，对照 `docs/design/2026-09-20-review-workspace/v3-detail/`。

## 结论

**不通过完整验收，暂不能签收 A+B。** 固定三栏、主要字阶/图标和真实 durable 正文已经落地；但有 **4 项 P1 阻塞缺陷**，会丢失修复入口、展示旧执行结果、串席或打断阅读。另有阅读恢复、窄屏标签、正文章节字体、失败状态和轮询调度问题。

这不是“尚未补齐 C”的问题。历史版本选择器、复杂搜索和结构化意见未做符合分期；本报告指出的是本期 A/B 已承诺的行为。

本轮只读验收。未修改产品代码、未重启 Host、未运行真实审查/修复、未提交或发布。已有未跟踪的 repair diagnosis 文档未改动。

## 证据范围

1. **真实页面**：完成 Run 的总览、已完成席位报告/过程、跨席阅读恢复、Aggregator、取消席位、手机菜单，以及一条 squad 只读观察页。
2. **真实 HTTP**：经正常 document/session 流程读取新 result API；cookie/CSRF 仅在内存，不写入报告。5 席与 Aggregator 均 HTTP 200、正文 available、未截断；各返回正文约 8–14 KiB。见 [live-http-results.json](evidence/live-http-results.json)。
3. **受控源码复现**：加载当前生产函数，模拟 React hook 生命周期与传输，结果缓存使用真实 TanStack QueryObserver；不是浏览器 E2E，也没有改变真实运行状态。明确覆盖迟到响应、resume 缓存和默认 Tab。
4. **Handler fixture**：临时目录中的合法 transcript 经真实 route handler 读取，不监听 43127。覆盖 300 KiB 全文、重试、复用、resume 和不可重试失败。

部署核对：43127 的生产 Host 进程已包含新 result 路由；实际 JS `/assets/index-BgsKxL0E.js` 与 CSS `/assets/index-3MXYmhp7.css` 的内容哈希与本地 dist 对应文件一致。验收开始、结束源码 HEAD 均为上述基线。不能把旧回执中的“新路由尚未部署”继续作为当前状态。

## 四项阻塞问题

### AC-01 · P1 · 没有内置 pipeline 的审查丢失修复与复审入口

**真实页面复现。** 打开已完成且有报告的 Run `ck-review-55554982-fb84-4aaa-b069-ed921ebd8aba`，接口返回 `pipeline=null`。总览、桌面席位列和窄屏选择器均没有“Squad 自动修复”“内置修复”或复审入口；DOM 中相关动作按钮数量为 0。

原因链：`ReviewWorkbench.tsx:48` 仅用 `run.pipeline !== null` 决定 `hasRepair`；`:55` 又禁止无 pipeline 进入 repair；全部启动能力在 `RepairView` 中。独立 `repair.activeRepair` 也没有纳入可达性判断。上一版对 review 页面直接渲染 RepairRunPanel/FixPipeline，故这是回归。

要求：启动修复与查看现有修复必须可达，不能先有内置 pipeline 才允许启动。保留真实权限/数据门槛，但不能把“尚未启动”变成永久没有入口。

证据：[总览截图](screens/01-overview-1440.jpg)。源码：`src/components/report/workbench/ReviewWorkbench.tsx:48`、`OverviewView.tsx:45`、`RepairView.tsx:54`。

### AC-02 · P1 · 同一 Run/Attempt resume 后继续显示旧成功报告

**当前源码受控复现。** 首次得到 `attempt-0#1.1 / success / OLD_SUCCESS_REPORT`；将同一 Run/Attempt 的当前 progress 改为 running，结果请求总数仍为 1，缓存仍是旧成功正文，`refetchInterval=false`。

`useAttemptResult.ts:42` 的 key 只有 runId/attemptId；`:46` 设置无限 staleTime；`:47` 只依据已缓存结果的 executionStatus 决定是否轮询。新执行的 progress 不能使旧终态结果失效。

这超出了“跨 resume 阅读位置未实现”的范围：**当前执行的结果真实性已经错误**。B 的界面不能将旧成功显示成当前结果。

证据：[frontend-state-evidence.json / cacheEvidence](evidence/frontend-state-evidence.json)。复现入口：[reproduce-frontend.mjs](evidence/reproduce-frontend.mjs)。

### AC-03 · P1 · 快速切席后旧响应写入新席位的过程

**当前源码受控复现。** A 的请求挂起 → 切到 B → A 返回。B 的状态实际得到 `done=true`，`windowBlocks` 包含 `OUTPUT_FROM_SEAT_A`。

切席复用组件，`useWorkbenchProcess.ts:98` 把共享 cancelledRef 重新置 false；A 的迟到回调在 `:165` 因此通过检查，写入 B 已重置的共享 refs。旧请求的 finally 也可能影响新一轮 inFlight 状态。

要求：旧请求不能改变新席位的正文、游标、完成状态或跟随状态。

证据：[frontend-state-evidence.json / raceEvidence](evidence/frontend-state-evidence.json)。源码：`useWorkbenchProcess.ts:96`、`:164`、`:190`；`ReviewWorkbench.tsx:153`。

### AC-04 · P1 · 首次默认进入过程后，完成事件会自动切到报告

**当前源码受控复现。** 首次选择 running 席位，不手动点 Tab；仅将 status 更新为 success。实际 `process → report`，显式 tabs 记录仍为空。

`ReviewWorkbench.tsx:84` 每次 render 都对未记录的席位重新计算默认 Tab，没有固定首次进入的模式。

要求：完成只能提示“报告已就绪”，不能切走用户正在看的过程。这个场景是设计的核心验收用例。

证据：[frontend-state-evidence.json / tabEvidence](evidence/frontend-state-evidence.json)。

## 其他已确认的不符合项

### AC-05 · P2 · 切回席位丢失历史阅读位置

**真实页面连续两次复现。** 对抗审查的过程滚到 `scrollTop=2048`，切安全审查后再回来，仍选中“过程”但位置为 0。第二次从 1024 经正确性审查返回，仍回到 0。

源码的旧位置在内容切换后的 effect 中才读取，且过程会清空重新加载；这不足以恢复原阅读锚点。

证据：[切换前](screens/03-process-before-switch.jpg)、[切换后](screens/04-process-after-switch.jpg)、[scroll-evidence.json](scroll-evidence.json)。源码：`ReviewWorkbench.tsx:97`、`useWorkbenchProcess.ts:99`。

### AC-06 · P2 · 手机菜单只有图标；紧凑导航也没有可访问名称

**真实页面复现。** 1120px 的五个导航链接无可见文字、aria-label 或 title；390px 打开菜单后，同样只有图标，首页/新建讨论/产品创意/报告/设置文字均消失。辅助技术树也只给出链接 URL。

`review-workbench.css:596` 的 `.ck-wb-nav-item span { display:none }` 同时影响 dialog，WorkbenchNav 没有为图标栏补独立名称。

证据：[1120px 导航](screens/05-compact-1120.jpg)、[390px 菜单](screens/08-mobile-menu-missing-labels.jpg)。菜单 Escape 关闭后焦点回源按钮正常，这不抵消标签缺失。

### AC-07 · P2 · Markdown 正文章节仍使用旧衬线字体

**真实 CSS 核对。** 主 H1 是 26/34/600、正文是 16/28/400，均符合主规格；但正文“发现”等 H2 的 computed font-family 是 `New York / Iowan Old Style / Palatino / Georgia / serif`，不是本次统一的 Inter + 中文系统无衬线栈。字号虽然已覆盖成 18/28/600，字体族仍由 `report.css:82` 的 `.ck-doc h2` 继承。

证据：[单席报告截图](screens/02-seat-report-1440.jpg)。这也解释了页面正文标题与工作台标题观感不一致。

### AC-08 · P2 · 不可重试失败被 API 推测成下一次执行中

**真实 handler + driver classifier fixture 复现。** 首试 3 秒 EXIT，错误为 authentication failed，classifier 明确 `retryable=false`。其他席位仍运行时，detail 为 failure，result 却是 `#1.2 / running / pending / failure=null`；整轮终态后又回退 `#1.1 / failure`。

`execution-ref.ts:212` 根据快 EXIT 推测有重试，缺乏确实启动新执行的证据。B0 回执承认该退化，不等于满足真实状态和稳定身份契约。

证据：[durable-handler-evidence.json](evidence/durable-handler-evidence.json)，标签 `non-retried-auth-exit-other-seat-active`、`auth-classification`、`same-auth-exit-after-run-finished`。

### AC-09 · P2 · 隐藏与手动重读的轮询调度仍有漏洞

**当前源码受控计时器复现。**

- 请求尚未返回时页面进入 hidden；响应回来又建立 timer，触发后产生第 2 次请求。隐藏后的暂停排程失效。
- 已有正常 timer 时手动重新读取；成功响应又安排 timer，得到两条周期链。cleanup 只清最后一个，残留一个待触发 timer。

inFlight 防护仍在，**本报告不声称同时并发请求**；残留 timer 在卸载后还有 cancelled 检查，未证明卸载后继续发请求。问题是隐藏阶段与重试排程不符合已有约束。

证据：[reproduce-polling.cjs](evidence/reproduce-polling.cjs)、[polling-evidence.json](evidence/polling-evidence.json)。源码：`useWorkbenchProcess.ts:125`、`:183`、`:195`、`:200`、`:235`。

## 容量与额外观察

- **“显示更早”解除全部窗口限制。** 当前 `expanded ? blocks : blocks.slice(-200)` 不是分段窗口。合法 2,097,054 字节的交替 text/thinking fixture 得到 17,280 个活动块；默认 200，展开分支取全部 17,280，再全部 map 到 DOM。见 [reproduce-capacity.ts](evidence/reproduce-capacity.ts)。这是明确的容量风险与窗口声明差距；本轮未测出浏览器卡顿数值，不把它写成性能超预算结论。
- Host live 仍全读全解析文件；追加折叠仍复制旧块。应以真实基线测量决定优化，不仅凭函数名叫 Append 就算成本门禁通过。
- “复制当前内容”在过程、失败或正文不可用时会回退 `run.markdown`（`ReviewWorkbench.tsx:110`），与所选范围不一致；失败文案还提“复制净化诊断”，但没有对应动作。本轮只做代码确认，未覆盖用户剪贴板，不计为上述四项阻塞复現。
- 总览仍直接堆叠旧账本，长内部 Finding ID 占用首屏，汇总正文在整份账本之后。截图 01 已展示这一阅读成本；应在修复功能问题后做一次真实长数据下的视觉复核。

## 通过项与未完成项

| 验收项 | 结果与范围 |
| --- | --- |
| 发布资源 | 新 UI 和 result 端点确实在运行，JS/CSS 与本地 dist 一致 |
| 普通 durable 全文 | 真实 5 席 + Aggregator HTTP 200/available；handler 300 KiB 正文不受旧摘要 cap 截断 |
| 后端部分身份路径 | retry 最终成功、显式 reuse、resume 不回退旧成功 fixture 通过；不能抵消 AC-02/08 |
| 固定布局 | 1440 下 184/248/1008 三列，48px 双栏、64px 席位行；1120 下 64px 图标栏，900 下选择器 |
| 基础视觉资产 | Inter 实际发布文件与设计资产哈希相同；主字阶、18px 图标、1.75 线宽可测；正文章节字体有 AC-07 |
| 390px | 页面宽度与 scrollWidth 均 390，无整页横溢；菜单可开关、关闭回焦点；标签有 AC-06 |
| Aggregator / 取消 | 真正 Aggregator 正文可读；真实取消席位显示已取消，没有伪造通过/零发现 |
| Squad observe | 抽查一条真实 squad 页面，不走 review 工作台，未出现修复/复审动作 |
| 静态检查 | 本轮 `pnpm typecheck` 四个配置退出码 0 |
| 单元测试 | 本轮相关 2 个文件 31/31 通过；不覆盖已复现的 hook 时序问题 |
| 控制台 | 所查真实页面未观察到应用 console error |
| C 增强 | 未做符合计划，不算本轮漏项 |
| 两小时 soak、数值预算、整页 WCAG、200% 缩放、完整 E2E | **未验收通过**。已发现阻塞缺陷，本轮不以这些缺失项推定通过；修复后继续门禁 |

没有运行默认全量 Host/E2E：其配置会绑定/复用 43127，并依赖测试控制面，可能干扰当前生产 Host。没有 bootout、kill、reset 或重启已发布服务。

## 复跑与后续门禁

从仓库根运行（仅临时 fixture 或受控 transport，不启动真实 Agent）：

```bash
node docs/verification/2026-09-21-workbench-acceptance/evidence/reproduce-frontend.mjs
node docs/verification/2026-09-21-workbench-acceptance/evidence/reproduce-polling.cjs
pnpm exec tsx docs/verification/2026-09-21-workbench-acceptance/evidence/reproduce-durable.ts
pnpm exec tsx docs/verification/2026-09-21-workbench-acceptance/evidence/reproduce-capacity.ts
```

先关闭 AC-01 至 AC-04，再以真实浏览器复测相关状态迁移；同时复测 AC-05/06 的现成页面步骤。随后补完整 B3 流程、容量基线与真实两小时 soak。不能把“类型检查和现有单测通过”替代这些验收。

交付回执 `docs/verification/2026-09-21-workbench-implementation-receipt.md` 的提交状态与“Host 尚无新路由”已经过时，应按发布后事实更新；其中已承认的身份和恢复缺口也应与本报告一起列为未关闭项。
