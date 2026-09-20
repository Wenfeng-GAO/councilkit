# 固定席位工作台 · 细节规范

选定方向：exploration-v3 第 1 张。这里只精修该方向，不混入阅读器的横向席位栏或底部多席 Console。整体布局与状态映射见 WORKSPACE-STATES.md；真实组件见 DETAIL-LAB.html。

## 1. 字体与字阶

拉丁字母和数字使用本地打包的 **InterVariable 4.1**。中文优先 `PingFang SC`，Windows/Linux 回退为 `Microsoft YaHei` / `Noto Sans CJK SC` / system-ui。Inter 不承担中文覆盖；不复制或分发系统苹方字体。

代码单独采用 `SF Mono / Menlo / Consolas / ui-monospace`。不把正文和所有元信息都改成等宽字体。字体栈差异需要在目标平台验证，不能承诺不同 OS 的中文字形逐像素一致。

| 用途 | 字号 / 行高 | 字重 | 细节 |
| --- | --- | --- | --- |
| 报告标题 | 26 / 34 | 600 | 一屏只有一个主要标题 |
| 正文章节 | 18 / 28 | 600 | 与正文保持足够差别，不过度加粗 |
| 中文正文 | 16 / 28 | 400 | 不额外加字距，不强制两端对齐 |
| 席位与 Tab | 14 / 20 | 500 | 选中不靠再加粗到 700 |
| 元信息与耗时 | 13 / 20 | 400 | 耗时启用 tabular-nums，不随数字变化跳宽 |
| 代码/命令 | 13 / 22 | 400 | 禁用编程连字，复制字符与看到的一致 |

只使用 400/500/600 三档。`font-synthesis:none`，避免缺少字重时伪加粗；Inter 使用 optical sizing auto。正文最大 760px；标题至元信息 12px、元信息至正文 32px、节间 32px、段间 16px。

## 2. 图标

统一 **Lucide 1.47.0**，已将本轮需要的 SVG 子集与许可证保存在 assets/icons。正式实现可使用相同版本的组件库，或使用随包 SVG；不要混用另一套图标、emoji、图片化小图标。

- 职责、导航、操作：18px，stroke-width 1.75，24px 原始 viewBox。
- 行内状态：14px，stroke-width 1.75；状态文字仍清晰显示。
- 可点击图标目标至少 36 × 36，触屏建议 44 × 44；不把 18px SVG 当成全部命中区域。
- SVG 使用 currentColor，默认次文字色；不在路径里写死彩色。隐藏装饰性 SVG 的辅助技术语义，按钮提供实际名称。

| 语义 | 图标 |
| --- | --- |
| 首页 / 新建讨论 / 产品创意 / 报告 / 设置 | House / MessageSquarePlus / Lightbulb / Files / Settings2 |
| 本轮总览 | LayoutList |
| 安全 / 正确性 / 对抗 / 可维护性 / 兼容性 | Shield / ScanLine / Swords / Wrench / Boxes |
| Aggregator | Layers2 |
| 执行完成 / 执行中 / 执行失败 / 等待 | Check / Activity / CircleX / Clock3 |
| 复制 / 打开 PR / 展开 | Copy / ExternalLink / ChevronDown |

角色用 ScanLine 而非 Check，避免把“正确性审查”图标误认成审查通过。Swords 表达对抗职责，替换不准确的多人头像。角色图标、执行图标与选中背景分别承担一种职责。

## 3. 颜色与表面

| 角色 | Token / 值 |
| --- | --- |
| 全局导航 | nav `#101113` |
| 席位导航 | seats `#16171A` |
| 正文区域 | content `#1B1D21` |
| 悬停、代码区、浮起表面 | raised `#23262C` |
| 当前席位轻底色 | selected `#2C2924` |
| 正文 / 次文字 / 辅助文字 | text `#E7E9EE` / secondary `#B2B7C2` / tertiary `#929AA7` |
| 黄铜选中 | accent `#C9B18A` |
| 进行中 / 失败 / 警告 | running `#8CB4E8` / error `#ED969B` / warning `#D6B27A` |
| Host 在线、明确成功操作 | success `#8AAE9B` |
| 键盘焦点 | focus `#ACC9F3` |
| 必需控件边界 | controlBorder `#707783` |
| 装饰分隔线 | divider `#2C3037` |

全部是纯色表面。不复刻图像生成可能带入的微纹理、光晕或金属按钮。装饰线只提供空间分组，不用于辨认输入框或交互边界。

颜色实算在 contrast-audit.json：45 组文字对底色组合均不低于 4.5:1（最低 5.11:1）；4 组必需边界/焦点组合不低于 3:1。该检查仅覆盖不透明 Token 配对，不代表截图、透明混色、所有组件或全站已通过 WCAG。

## 4. 状态语法

- **全局当前页**：中性 raised 底色与文字，不与当前席位争夺黄铜高亮。
- **当前席位**：selected 底色 + 2px 黄铜侧线 + 黄铜职责图标；名称仍为主文字色。
- **当前 Tab**：2px 黄铜下划线；Tab 本身不做巨大填充胶囊。
- **执行完成**：中性 Check + “执行完成”，不使用整行绿字，不暗示审查通过。
- **执行中**：小蓝色 Activity + “执行中”；静默期间不持续旋转假装产生活动。
- **执行失败**：玫瑰红 CircleX + “执行失败”，与报告“需要修改”不同。
- **键盘焦点**：2px 蓝色轮廓，offset 2px；选中项仍可看到独立焦点轮廓。
- **禁用**：disabled 文字与不可用交互；不能因颜色太暗而隐藏原因。hover 不复活禁用控件。

阅读页可以没有强调色主按钮。复制与打开 PR 使用 ghost 控件；复制真实成功才短暂显示“已复制”，失败给准确反馈。

## 5. 尺寸、对齐与动效

184px 全局导航 + 248px 席位列 + 弹性主内容。上文栏 48px、主视图栏 48px，三栏边界只用 1px 装饰线。主内容内边距 48px，窄桌面 32px。全局行高 38px，席位行高 64px。

席位职责图标与名称对齐；第二行状态与名称起点对齐；耗时在第二行尾部对齐。每项固定图标槽宽，不能按 SVG 外形临时挪移文字。键盘焦点轮廓要留空间，不被列表容器裁剪。

桌面常驻席位栏时，主视图标题“对抗审查”没有重复下拉箭头；窄屏收起席位栏后才使用明确的选择器。来源详情承载 executionRef 等诊断身份，不把内部 token 大量铺在正文前。

hover 120ms、面板过渡 160ms，reduced-motion 时关闭。报告正文不做入场动画；轮询不闪烁已完成状态；滚动跟随即时定位，暂停时不滚动。

## 6. 来源与交付

[Inter 官方说明](https://rsms.me/inter/) 支持 variable font、optical sizing 与 tabular numbers；字体附 SIL OFL 1.1。图标来自 [Lucide 官方静态包](https://lucide.dev/guide/static)，附完整 ISC/Feather 衍生许可。第三方资产仅用于字体/图标，不表示产品品牌授权。

前端应先在浏览器打开 DETAIL-LAB 对照真实字形与交互，再看整体图。JSON/CSS 是数值依据，PNG 是整体视觉参考；不要从 PNG 人工估计字号或重描图标。
