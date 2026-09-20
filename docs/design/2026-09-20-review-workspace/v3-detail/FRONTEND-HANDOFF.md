# 前端交付 · 采用已选固定席位工作台

实现目标以 `docs/design/2026-09-20-review-workspace/v3-detail/` 为准。用户已选择 exploration-v3 第 1 张，不再重新选布局。

## 实现前必须查看

1. AGENTS.md、当前产品代码与工作区变化。
2. 本目录 `screens/01-workbench-rendered.jpg`、浏览器中的 `DETAIL-LAB.html`，实际看真实字体/图标，不只看截图文字。
3. `DETAIL-SPEC.md`、`WORKSPACE-STATES.md`、`design-tokens.json` / `design-tokens.css`。
4. `contracts/INTERACTION-SPEC.md` 和 `contracts/DELIVERY-PLAN.md` 的真实数据、A/B/C、容量与验收契约。

## 冲突优先级

项目安全与真实接口事实 → v2 数据契约 → 本目录工作区状态映射与细节 Token → 本目录整体图。v2 旧位置布局由本目录覆盖；不混用旧右栏或其他探索方向。图像文字/图标不要求逐像素复刻，不能重描生成图标替代真实 SVG。

## 视觉交付

- 固定 184 全局导航、248 席位列、48 上下文栏、48 主视图栏；单一 selectedAttempt，全状态席位入口位置稳定。
- 使用 InterVariable 本地文件，中文按明确字体栈回退；只使用 400/500/600，代码字体分开，耗时 tabular-nums。
- Lucide 1.47.0 子集可直接使用；18px 职责/操作、14px 状态、1.75 线宽。保留许可证。可引入相同版本的 React 组件包，但不要静默换图标族。
- 严格区分职责、执行状态、选中状态、键盘焦点；中性完成不等于通过，黄铜不满屏使用。
- 对照 DETAIL-LAB 核对实际字体、颜色、hover/selected/focus/disabled；所有图标按钮有可访问名称与足够命中区。

## 功能与范围

A 可独立推进；B 的 current durable result API 与 executionRef 身份验证仍是可靠报告的前置。C 的复杂检索和历史版本选择不要混入首期。不要用 live 正则、伪造计数、静态 mock、最后一次成功正文完成 B 的验收。

完成时不抢用户阅读模式；没有结构化摘要仍读原文；失败保留已保存过程但不生成结论。修复阶段真实映射，旧 SHA 的结果不冒充当前提交。保留 squad 只读边界和原有非 review 功能。

先复用当前实现，遵守项目受保护文件限制；不自动提交、推送、部署或启动真实审查/修复。所有动作只有具备真实后端能力才显示。

## 验证

在 1440、1120、900、390 宽度核对固定布局与折叠路径。测实际文字/边界/焦点对比度、200% 缩放、键盘访问与 reduced-motion。当前 Token 对比度计算不能代替整页测试。

执行 v2 计划中与交付线相关的行为、容量和长会话验收；报告具体证据与尚未完成的数据依赖。静态图和本目录组件样张不算产品已经实现。
