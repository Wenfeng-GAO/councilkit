> **已选定固定席位工作台：请使用 [v3 细节交付包](v3-detail/README.md)。本文件保留为 v1 历史稿，不作为当前实现目标。**

# CouncilKit 审查工作台 · 高保真设计交付包

日期：2026-09-20。用途：供前端 Agent 实现审查报告与席位阅读体验。状态：设计提案，尚未作为产品代码实现。

一套统一的深色与黄铜视觉语言，覆盖完成、执行中、历史回看与修复进行中。5 张图由内置 Image Gen 生成，基于 CouncilKit 真实页面与现有颜色体系；没有创建 Figma 文件或交互原型。图片中的 PR、发现数量、时间与代码片段均为演示数据。

## 交付清单

| 文件 | 用途 |
| --- | --- |
| [DESIGN-BOARD.md](DESIGN-BOARD.md) | 5 张设计图的连续浏览与每屏重点 |
| [VISUAL-SPEC.md](VISUAL-SPEC.md) | 尺寸、布局、响应式、组件、正式文案与图片校正说明 |
| [INTERACTION-SPEC.md](INTERACTION-SPEC.md) | 状态矩阵、交互与数据来源、实现依赖、验收场景 |
| [design-tokens.json](design-tokens.json) | 可读入实现的颜色、间距、字号、断点等数值 |
| [FRONTEND-AGENT-PROMPT.md](FRONTEND-AGENT-PROMPT.md) | 可直接交给前端 Agent 的完整任务说明 |
| [generation-prompts.json](generation-prompts.json) | 原始生成提示词，供后续修改设计使用 |
| [screens/](screens/) | 5 张未压缩 PNG 原图 |

## 阅读顺序与冲突处理

先看设计图理解层级，再读视觉与交互规格。交付中的优先级为：**项目约束与真实接口事实 → INTERACTION-SPEC 状态含义 → VISUAL-SPEC / tokens 数值和文案 → 图片视觉参考**。图中的按钮不代表后端已有对应能力；不得通过假数据或错误接口补齐生产功能。

图片是高保真视觉参考，不能直接当 CSS 的精确测量尺。设计基准为 1440 × 1024 CSS px，导出 PNG 为 1487 × 1058 像素；不需要为贴图尺寸扭曲页面。具体布局数值以 tokens 和 VISUAL-SPEC 为准。

## 页面清单

1. **审查总览**：[01-review-overview.png](screens/01-review-overview.png)。总体结论和优先问题在前，右侧提供紧凑席位结果。
2. **已完成席位**：[02-seat-result.png](screens/02-seat-result.png)。结论、发现、完整报告在前，历史过程在下方。
3. **审查进行中**：[03-review-running.png](screens/03-review-running.png)。席位列表、当前动作、实时过程、跟随控制。
4. **历史过程**：[04-process-history.png](screens/04-process-history.png)。保留结果上下文，按活动分组，提供搜索与筛选。
5. **修复进行中**：[05-fix-progress.png](screens/05-fix-progress.png)。历史审查结论与当前修复 Run 明确分区。

这 5 张是同一设计的状态页面，不是 5 个备选方向。运行中画面是完成画面的较早阶段。错误、空白、截断、读取失败、无结构化结论等补充状态，定义在 INTERACTION-SPEC 的状态矩阵中。

## 实现交付标准

- 同一 Run 中，某席位先完成即可打开可靠结果；不等 Aggregator，不从截断的 live 片段猜报告。
- 用户看历史时，新事件和完成事件都不抢走滚动位置；可显式回到最新或查看结果。
- 执行完成与审查结论分别展示；未知、零发现和通过审查不混用。
- 修复进展绑定正确的修复 Run；上一轮审查结果保持原 SHA 与来源。
- 完成 1440、1024、390 宽度和键盘路径验证；无需为了验证 UI 发起真实付费 Agent Run。

直接将 [FRONTEND-AGENT-PROMPT.md](FRONTEND-AGENT-PROMPT.md) 交给后续前端 Agent，即可按图与契约开始实现。
