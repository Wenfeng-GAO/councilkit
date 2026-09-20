# CouncilKit · 固定席位工作台细节定稿

日期：2026-09-20。用户已选择 exploration-v3 第 1 张三栏方向。本目录是该方向的字体、图标、颜色与组件细节提案，作为当前前端设计入口；其他探索方向不混入实现。

## 看什么

- [真实细节样张](DETAIL-LAB.html)：本地字体、真实 SVG、颜色与状态、字号比较和 Tab 焦点交互。
- [真实工作台样张](WORKBENCH-PREVIEW.html)：可切席、切报告/过程；不连接产品数据。
- [整体渲染图](screens/01-workbench-rendered.jpg)：真实字体与 SVG，保留选定三栏结构。
- [细节规范](DETAIL-SPEC.md) 与 [固定工作区状态映射](WORKSPACE-STATES.md)。
- [前端交付说明](FRONTEND-HANDOFF.md)。
- [Token JSON](design-tokens.json)、[Token CSS](design-tokens.css)、[颜色检查数据](contrast-audit.json)。

## 核心调整

正文 16/28、标题 26/34、章节 18/28，缩小无关信息的权重；Inter 处理英文与数字，中文走系统回退。所有职责与操作图标统一 Lucide，完成态使用中性 Check。全局选中中性化，黄铜只强调当前席位与 Tab；键盘焦点采用独立蓝色轮廓。

字体与图标随包保存，详情页无需外部网络资源。Inter 4.1、Lucide 1.47.0 均附上游许可证；系统苹方与 SF Mono 不随包分发。

## 与之前文档的关系

contracts/ 保存 v2 数据契约与 A/B/C 分期快照，继续有效，**布局相关描述由本目录 WORKSPACE-STATES 覆盖**。例如席位入口固定在第二栏，不再使用 v2 的总览右栏；不混入探索 2 的顶栏席位或探索 3 的跨席底部 Console。

本次仅交付设计与真实组件样张，没有接入产品数据或修改产品源码。方向精修参考由内置 Image Gen 生成；最终量取图来自真实 HTML/SVG 渲染，字号与图标以样张、Token 和资产为准。
