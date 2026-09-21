# 固定席位工作台 · 验收问题修复与复验结论

日期：2026-09-21。前置：独立验收报告 [REPORT.md](REPORT.md)（基线 `96e554b` + 工作区修复）。本文件记录修复与复验结果。复验方式：受控复现脚本 + 真实浏览器（vite dev + 只读 GET 转发到 43127 生产 Host，未停未写）。

## 结论

**AC-01 至 AC-09 全部修复并复验通过；A+B 具备签收条件。** 四项 P1 的复现脚本全部 exit 0，真实浏览器复测 7/7。

## 逐项修复与复验

| 项 | 修复 | 复验 |
| --- | --- | --- |
| AC-01 P1 修复入口 | kind=review 有权限即达 RepairView；无 pipeline 显示诚实启动空态；`repair.activeRepair` 纳入可达性 | 真实页面：无 pipeline run 的席位列/窄屏 select 均有「当前修复」，启动面板真实渲染（未启动） |
| AC-02 P1 resume 旧结果 | result 查询 key 加入执行代次（progress 终态→live 迁移 +1）；progress live 时移除旧终态缓存 | reproduce-frontend：resume 后旧成功失效、running 轮询、再 success 显示新正文 |
| AC-03 P1 切席串写 | 单调 requestSeq 守卫替换共享 cancelledRef 复位；全部迟到回调经 `isStaleResponse` 检查 | reproduce-frontend：A 挂起→切 B→A 迟归，B 不被写入 |
| AC-04 P1 完成自动切 Tab | 默认 Tab 首次选择时计算并持久化（`getOrInitTab`），之后永不重算 | reproduce-frontend：running 默认 process，status 变 success 后仍 process |
| AC-05 P2 滚动恢复 | 渲染期捕获 + rAF 逐帧等待内容高度恢复 + 恢复后守窗；过程空内容不触发跟随；`.ck-wb-reader` 禁 overflow-anchor。注：初版修复复测仍失败（effect 时序 + 浏览器滚动锚定），验收阶段二次修复 | 真实浏览器：7416→7416 三次稳定 |
| AC-06 P2 可访问名称 | 五个导航项 aria-label；文字隐藏规则限定侧栏作用域，dialog 菜单项保留文字 | 真实浏览器 1120px/390px 复测 |
| AC-07 P2 正文字体 | `.ck-wb .ck-doc h1/h2/h3` 字体族覆盖为 `--ck-ui-font` | getComputedStyle 断言 InterVariable 栈 |
| AC-08 P2 重试推测 | CLI 写入侧落 `willRetry` 证据字段（runner/transcript/review/ideate）；execution-ref 删除时间启发式，仅证据触发 in-flight；旧数据保守报最后终态 | reproduce-durable：auth 类 EXIT（retryable=false）不再报 `#1.2 running` |
| AC-09 P2 轮询调度 | 唯一 schedule 入口（先清旧 timer），排程前查 hidden，手动重读走同一路径 | reproduce-polling：hidden 期间零排程、任意序列单链 |

容量：「显示更早」改为分段 +200 行（17,280 块 fixture 首屏 200、点一次 400）。复制：仅当前范围正文可用时启用，删除 run.markdown 静默回退；失败态无动作文案改为「读取已保存记录」。

## 额外修复（非验收项）

- `tests/host/cli-runs.test.ts` 5 个 repair POST 用例在 `96e554b` 即红（该提交新增 Squad 桥门禁，测试未注入 bridge probe）。判定为测试过时：注入 `squadBridgeProbe=available` 并新增「桥不可用 → 400 + 零 spawn」用例。test:host 323/323。
- 交付回执 `docs/verification/2026-09-21-workbench-implementation-receipt.md` 已加「验收后修订」节：提交状态、B3 HTTP 端到端补验（launchd Host 重启后 result 端点 HTTP 200、16009 B durable 正文）、AC 清单与未关闭项。

## 复验命令

```bash
node docs/verification/2026-09-21-workbench-acceptance/evidence/reproduce-frontend.mjs
node docs/verification/2026-09-21-workbench-acceptance/evidence/reproduce-polling.cjs
pnpm exec tsx docs/verification/2026-09-21-workbench-acceptance/evidence/reproduce-capacity.ts
pnpm exec tsx docs/verification/2026-09-21-workbench-acceptance/evidence/reproduce-durable.ts
# 全量：pnpm typecheck && pnpm test:unit && pnpm test:host && pnpm build
```

全量结果：typecheck 0 错误；unit 1361/1361；host 323/323；build 通过。

## 仍未关闭（不阻塞本次签收，按原验收报告门禁）

- 两小时 soak 与容量数值预算未实测；整页 WCAG / 200% 缩放未验收。
- e2e 2 条（cli-reports fixture 依赖）与 modal-focus 待 e2e Host 环境补跑。
- 跨 resume 阅读位置恢复（`runId+attemptId+executionRef` 键）未实现。
- B0 硬崩溃无终态记录的执行与下一代重跑共享 ref（需 CLI `attempt.started` 事件）。
- 总览账本长 ID 首屏阅读成本：建议做一次真实长数据视觉复核（原报告观察项）。
