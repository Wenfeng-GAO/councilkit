# Squad 自动修复过程工作台 · 测试分析与 E2E 验收

版本：1.0 · 2026-09-22 · 状态：可交给 Cursor 编写测试，功能尚未实现。本次只交付分析文档，不启动真实修复、不改产品。

## 1. 基线、边界与交付物

需求基线：[PRD.md](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/docs/design/2026-09-22-squad-observability/PRD.md)（I1–I10、A1–A10）和 [INTERACTIONS.md](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/docs/design/2026-09-22-squad-observability/INTERACTIONS.md)。可交互视觉参考：[prototype.html](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/docs/design/2026-09-22-squad-observability/prototype.html)，SHA-256 `5ed1ee05601e50a00b520a59561c6bd546fe2611da2d69abc08626d4957777b8`。配套 [ENGINEERING-ANALYSIS.md](/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/docs/design/2026-09-22-squad-observability/ENGINEERING-ANALYSIS.md) 定义数据和UI实现约定。

原型的77项检查仅证明fake页面交互，不是生产E2E完成证据。Cursor须把下列用例实现为**真实React页面 → 真实Host路由/解析/归并 → 临时磁盘工件**的可重复测试；不得用整页静态HTML或route.fulfill全部业务响应代替。

范围澄清：单轮历史选择、轻量已有diff预览、证据最小导出是P0；完整Git浏览器、跨轮差异比较、成本统计平台是P1。本文不要求新增模型热切换/自动扩预算。换席提示须准确说明v2预算继承限制。

PRD A10的“零API/fake徽章”只约束设计原型；生产实现应使用真实本地API，并移除演示条。本测试环境仍禁止调用真实LLM、真实PR和用户Host。8秒理解是人工可用性目标：E2E能证明首屏信息齐全，不能伪称机器证明人的理解速度。

Cursor交付：新增专用Playwright配置、测试Host入口/producer、fixture集、下表全部P0 spec、覆盖矩阵和结果JSON；保留失败trace/截图/网络与producer回执。UT不能替代下表E2E，但可承担字节边界与算法穷举。

## 2. 测试运行方式（必须先建好）

- 新建 `playwright.repair-observability.config.ts` 与 `tests/e2e/repair-observability/`（名称为实施目标，当前未存在）。Chromium、workers=1、retries=0、独立测试端口例如43837，`reuseExistingServer:false`。端口占用就失败，禁止杀非自身进程。
- **不要直接运行现有playwright.config.ts**：它绑定43127且本地可reuse用户服务。`playwright.repair-ui.config.ts`的4188+API拦截只是UI smoke，不是本需求端到端证明。
- 复用 `tests/e2e/host-entry.mts` 的production React+真实Host路由结构和临时COUNCILKIT_HOME。只在测试入口注入config.port与配套Host/Origin守卫值；生产默认43127不改。仅换listen端口而未改guard会得到虚假的鉴权失败。
- fixture producer是测试进程内的磁盘写入器或仅测试入口注册的受限控制接口。`reset/append/advance/rotate/finish`返回flush完成及seq回执。业务GET/stop/resume仍走真实产品路由；不在生产包暴露测试控制接口。
- 用fake launcher/小型受控child替代LLM执行，记录launch/stop调用；不能模拟掉观察路由的解析和读取。真实provider调用不属于每次E2E的前置条件。
- 每用例独立临时home、runId、执行身份和受控clock。除时延E57外，用producer推进虚拟时间；浏览器与Host采用同一clock基准。等待响应/DOM条件，不写固定sleep来等业务。
- 网络允许列表仅本测试origin；日志哨兵与fake仓库均置于tmp。保留用户Host存活哨兵、配置hash以执行E66。只有网络故障用例可route.abort/delay，不能route.fulfill成功观察数据。

**建议组织（需实现）：** `orientation.spec.ts` E01–10/E64/E67；`activity.spec.ts` E11–20；`state-actions.spec.ts` E21–39/E68；`durability.spec.ts` E40–45/E59/E63/E65；`security.spec.ts` E46–50/E58/E62；`visual-performance.spec.ts` E51–57/E61；`harness.spec.ts` E66/E60。每个test标题带`[E##] @p0`；一个test覆盖多个编号时必须显式列出，不能只计算test数量。

## 3. Fixture 合同

共同身份：`parent=ck-repair-00000000-0000-4000-8000-000000000128`；固定T0=`2026-09-22T06:00:00Z`；目标“停机中断后恢复会话，并支持安全重试”；当前round=2、sourceFixUsed=2/max=3；候选C=`c`重复40位、baseB=`b`重复40位、旧候选A=`a`重复40位。所有repo/PR使用`example.test`，不访问它。

| Fixture | 内容/推进 |
|---|---|
| F0 | 已登记角色、active、无日志/0条日志，后追加公开活动 |
| F1 | 编码中；连续Builder共享session B1；Reviewer R1/Verifier V1待启动；读取、修改、重复工具名、公开进展均有 |
| F2 | 独立Reviewer与Verifier不同session/worktree并行；五断言包含通过/未通过/待验证/证据不足；命令有成功和失败 |
| F3/F3b | lastActivity=T0-228s；进程检查T0-8s；F3b无有效心跳或PID身份不匹配 |
| F4 | 保留F1缓存、网络故障，恢复时重放并追加 |
| F5/F5b | Reviewer额度错误/needs_attention；F5b分别为可恢复、预算耗尽、身份未知 |
| F6/F6a/F6b | 候选结束待终验 / 合法approved+同SHA完整证据 / approved与证据矛盾 |
| F7 | round1旧记录与round2当前并存，旧轮报告不可写 |
| F8 | 坏行、半行、重放、乱序、轮转、旧执行迟到、时间未知；secret/xss/path为专用变体 |
| F9 | 50MiB/10万操作，含>64KiB命令输出及单条超长记录；记录实际读取字节数 |
| F-legacy/-empty | 新增观察功能前的父Run attempts=[]，仍有关联日志；另有仅最终报告无过程 |
| F-child-review | current cycle关联新的review子Run，5个真实计划席；sourceRunId指向不同的历史基线 |
| F-review/F-squad | 现有review live+durable、只读ck-squad回归 |

producer须生成实际格式：父repair.json/status.json、受信任Squad关联、Cursor原始JSONL、官方adapter run/receipt及子review sidecar。不能只生成恰好适配新DTO的理想数组。不同来源同callId、不同角色同模型等冲突必须保留。

## 4. 逐项 E2E 用例

以下68项均为发布阻断P0。每项共同前置为已启动的隔离测试Host；操作只能针对本用例fixture。预期栏全部是必须断言的可观察结果，不是人工阅读描述。滚动保持比较首个可见eventId与其top偏移（误差≤2px），不只看scrollTop；几何比较误差≤1px。源码/私有函数覆盖仅作为补充UT，不代替真实浏览器路径。

| ID | 场景 | 前置数据 | 操作 | 明确验收标准 |
|---|---|---|---|---|
| E01 | 进入与定位 | F1 | 打开真实 repair 路由，初始200条记录可读。 | 首屏含原目标、当前轮/阶段、最近有效活动、是否需处理；默认全部活动/活动Tab；没有百分比进度；目标不能只剩PR URL。 |
| E02 | 等待首条记录 | F0 | 先打开空日志任务，再追加首条公开活动。 | 先显示等待首条记录，不显示失败；追加后真实行出现且空态消失；角色计划未丢失。 |
| E03 | 连续Builder归组 | F1 | 读取共享 native session 的 orchestrator/planner_a/coder。 | 左侧归为一个编排与开发执行组，详情可见子角色；不伪装成三个并行执行；身份未知时不擅自合并。 |
| E04 | 可选角色 | F1/F2 | 先加载simple规划，再推进带Planner B的执行计划。 | 前者不制造待启动的Planner B空席；后者显式出现独立角色；原选择不跳转。 |
| E05 | 独立角色并行 | F2 | 依次追加Reviewer、Verifier的交错活动。 | 两角色同时活动中；各自事件、模型、状态可区分；不画成必须串行；Builder已结束不等于PR通过。 |
| E06 | 角色阅读状态 | F2 | 选Verifier、设置筛选并滚到中间；切角色再切回；其他角色期间推进。 | 恢复该角色的筛选和锚点；不因另一角色活跃而抢选中项；空角色说明待启动原因。 |
| E07 | 活动类型与时间 | F1 | 追加状态、公开进展、文件读取/修改、命令记录。 | 每行角色/时间/类型/摘要正确；类型有文字而非只靠颜色；不逐token生成独立行。 |
| E08 | 工具起止关联 | F8 | 同一execution内两个同名命令交错started/completed，含重放。 | 按callId关联各自结果；一操作一行；耗时基于同一操作；不靠名称或相邻位置配对。 |
| E09 | 文件和diff来源 | F1 | 分别打开read事件与有diff工件的edit事件。 | read只显示读取，不进入已修改统计；edit显示已记录差异与来源；无diff时显示未记录，不现场编造差异。 |
| E10 | 未收尾工具 | F8 | 只有started，时钟推进超过3分钟；随后追加真实失败完成。 | 先显示未收到结束记录，不补成功/退出码；完成后同一行变为失败，错误片段可见。 |
| E11 | 正常跟随 | F1 | 位于底部，追加一条新操作。 | 一轮观察内出现；接近底部并可见最新行；newCount=0；不出现全页闪烁。 |
| E12 | 暂停跟随 | F1 | 点击暂停跟随，记录锚点，再追加两条新操作及一次重复记录。 | 仍接收数据；可见活动快照/锚点不移动；显示2条新活动，不是3；没有stop/resume POST；点击查看新活动后归零并到最新。 |
| E13 | 手动滚动 | F1 | 向上离开底部>48px，再追加活动，最后滚回底部。 | 自动暂停跟随；新增不抢滚动；回到底部恢复；加载较早历史不计入新活动数。 |
| E14 | 暂停时异常 | F1→F5 | 暂停跟随后注入真实角色失败与needs_attention。 | 顶层错误/角色状态及时更新，阅读区不滚动；暂停不是掩盖任务失败或停止接收。 |
| E15 | 组合筛选 | F1 | 依次设置角色=Builder、类型=工具、关键词=session，再清除。 | 组合为AND；工具包含文件/命令操作；清除恢复该轮已加载记录；筛选范围标明已加载，不伪称全磁盘搜索。 |
| E16 | 筛选空态 | F1 | 输入不匹配词，再选尚无活动的Reviewer。 | 区分已加载记录无匹配与角色待启动；提供清除筛选；不写任务没在运行。 |
| E17 | 抽屉与回焦点 | F1 | 点击文件活动，检查右侧抽屉；关闭、Esc、切换事件重复三次。 | 详情属于选中event/execution；桌面贴右；关闭后回触发按钮，按钮已被卸载时回稳定标题；无null.focus异常；初始抽屉隐藏。 |
| E18 | 长输出与复制 | F2 | 展开含长路径、失败输出的命令，展开全文页并复制。 | 默认可见错误片段；截断说明明确；复制得到显示范围内真实脱敏内容；成功才提示已复制；长行只在代码区横滚。 |
| E19 | 复制被拒绝 | F2 | 用浏览器权限策略拒绝剪贴板，点击复制。 | 显示复制失败及手动选择提示；不伪报已复制；不导致pageerror。 |
| E20 | 时间来源缺失/偏差 | F8 | 提供无发生时间的事件；将客户端时钟与serverTime错开5分钟。 | 无时间写未记录；同步时间不冒充活动时间；不出现负耗时或因浏览器时钟偏差误判静默。 |
| E21 | 静默但仍在线 | F3 | 有效活动停止180秒以上，继续提供新鲜、身份匹配的进程证据。 | 显示暂时没有新活动、进程仍在线；最近心跳与有效活动分列；不判卡死、不自动重试、不持续假转圈。 |
| E22 | 没有存活证据 | F3b | 移除/过期进程证据，或提供同PID不同startKey。 | 状态为未知，不凭PID存在、Host在线或日志mtime冒称该执行在线；历史活动保留。 |
| E23 | 连接断开 | F4 | 有缓存后阻断观察请求，保持Host其他页面可访问。 | 显示最后已知状态与最后同步时间，缓存/筛选/选择不清空；不宣布进程死或任务失败；需要实时身份的控制动作禁用。 |
| E24 | 恢复连接 | F4→F2 | 解除网络阻断，服务端重放最近5条并追加新记录。 | 恢复连接；重复事件不重复；保留阅读锚点；不重复执行任务/stop请求；故障文案消失。 |
| E25 | 轮询与可见性 | F1 | 持续运行、隐藏标签页、恢复、连续点重新读取。 | 同查询最多1个in-flight；隐藏停止周期排程，可见立即续读；手动重试不新建并行定时链；失败退避后成功恢复正常频率。 |
| E26 | 切换后的迟到响应 | F2 | 在选中A时延迟观察响应，切到B后释放；再单独延迟轮1响应、切轮2后释放旧响应/错误。 | 旧success/error/finally都不能覆盖新视图、重置新请求标志或改变当前角色。 |
| E27 | 额度不足 | F5 | 写入Reviewer额度错误及控制器needs_attention，打开换席步骤。 | 原因与受影响角色在活动上方；错误脱敏；步骤只读、无自动fallback/热换会话/清零预算动作；账户额度不冒充source-fix剩余次数。 |
| E28 | 恢复资格 | F5/F5b | 分别给出可恢复、预算耗尽、身份未知的控制器快照。 | 仅可恢复且证据新鲜时调用既有resume入口；其他状态说明原因且无可点的再修一次；不根据日志文本自行授权。 |
| E29 | 停止取消 | F1 | 点停止任务，取消或Esc。 | 弹窗说明保留历史和已用预算；取消无POST、无状态改变；焦点返回停止按钮。 |
| E30 | 停止确认与重复点击 | F1 | 确认停止并快速双击；fake launcher只管理本测试child。 | 恰好一次POST，待处理按钮禁用；请求指向当前parentRun；不触碰其他任务/用户进程；历史和预算保留。 |
| E31 | 停止确认不等于已停止 | F1 | stop POST返回受理，producer暂不写stopped，随后写控制器终态。 | 先显示停止中/等待确认，不能乐观显示已停止；只有新鲜控制器终态到达才结束。 |
| E32 | 停止失败/不确定 | F1 | stop返回错误或请求超时但后台可能已受理；随后刷新状态。 | 显示失败/结果待确认，不显示成功；先重读再决定是否重试；不存在自动重复付费执行或删除日志。 |
| E33 | 历史只读 | F7 | 选择第1轮，尝试角色筛选、证据和历史操作区。 | 清楚标记历史；只显示该轮events/证据；停止/恢复/发布/换模型执行按钮均无；当前轮继续写入不污染历史。 |
| E34 | 返回当前轮 | F7 | 看历史期间当前轮完成，点击返回当前轮。 | 保持历史阅读直到用户返回；返回显示新状态；不把历史PASS当当前准出。 |
| E35 | 验收四态 | F2 | 打开验收与改动，逐一选择通过/未通过/待验证/证据不足项。 | 状态文字和来源明确；每项有独立断言身份；证据不足不显示绿勾；覆盖分母来自冻结清单。 |
| E36 | 候选完成但未准出 | F6 | 所有执行已结束但远端身份尚未核验。 | 显示本地候选完成/待准出；没有已交付/已准出标识；必要时继续观察后续终验。 |
| E37 | 合法准出 | F6a | 提供控制器approved以及匹配候选/基准SHA和完整必需证据。 | 显示已准出、SHA、核验时间；全部必需验收闭合；停止按钮不存在；不是仅凭exit=0通过。 |
| E38 | 准出证据矛盾/缺失 | F6b | approved同时缺SHA，或证据绑定旧候选/旧断言版本。 | 显示状态与证据不一致/证据不足，禁止绿色准出；不修改后端业务结果来掩盖矛盾；详情能定位缺项。 |
| E39 | 预算/Token未知 | F1/F8 | 缺完整token回执；源码派工used=2/max=3；model context=500K。 | 显示剩余1次及暂无完整用量；500K只作上下文能力；不显示0消耗或估算百分比。 |
| E40 | 大日志初始窗口 | F9 | 从冷进程打开50MiB合法日志，已有10万操作，打开更早一页。 | 初次最近200行；有更早记录/截断说明；加载更早保持顶部锚点；不把全部原始日志塞进响应/DOM。 |
| E41 | 坏行/半行/中文 | F8 | 顺序追加坏JSON、半条中文JSON、多字节字符边界，最后补齐换行。 | 坏行给受限提示且后续继续；半行不显示不推进越过未完成边界；补齐后恰好一条且中文不乱码。 |
| E42 | 日志轮转/截断 | F8 | 源文件换generation并序号归零，重用callId。 | 明确重建相应来源cursor；旧新事件ID不碰撞；历史可标已归档；新事件继续显示，无永久等待。 |
| E43 | 刷新恢复 | F1/F7 | 加载事件/终态后刷新浏览器。 | 从落盘证据恢复已发生记录与状态；不是依赖前端内存；缺失读取位置时回当前最新且说明，不清空磁盘。 |
| E44 | 旧执行迟到 | F8 | 同角色从execution E1切至E2，随后E1追加失败/完成。 | E1仍可在历史来源找到；不能覆盖E2状态或合并工具；“重试”必须有新执行身份。 |
| E45 | Host重启 | F1 | 只重启自建E2E Host，保留临时磁盘；浏览器重连。 | 来源/事件可恢复，可能cursorExpired但不丢已持久化历史；不会重新启动writer或清预算。 |
| E46 | 脱敏在服务端 | F8-secret | 原始fixture含Authorization、Cookie、API key与敏感URL查询；读列表、详情、复制和下载。 | 浏览器响应、DOM、console、剪贴板、下载均不含哨兵secret；保留[REDACTED]；不能只在CSS遮住。 |
| E47 | 隐藏推理过滤 | F8-private | 追加thinking/reasoning块及公开text/tool事实。 | 观察API不返回隐藏推理；公开事实正常显示；原始thinking长度不充当有效活动/工具次数。 |
| E48 | 不可信内容 | F8-xss | 标题/文件名/工具输出含script、img onerror、javascript链接、伪造HTML。 | 按文本显示；无脚本执行/外网请求；代码区可复制；没有把日志当HTML或指令执行。 |
| E49 | 路径与来源隔离 | F8-path | 用URL编码路径穿越、越界/软链接工件、伪造execution/detailRef访问兄弟任务/哨兵文件。 | 真实Host拒绝或标不可用；响应不泄露哨兵内容/任意文件路径；不读取任意.squad目录。 |
| E50 | 鉴权与请求守卫 | F1 | 无session读取、无CSRF停止、错误Origin/Host请求。 | 沿用现有鉴权规则拒绝；成功读取不扩大公开暴露；测试专用端口没有弱化生产守卫。 |
| E51 | 响应式布局 | F1/F5 | 1440×960、1280×900、390×844及720/721边界浏览/筛选/开抽屉。 | 页面无横向溢出；角色可选择、按钮可达；代码块可独立横滚；不出现双重全局导航。 |
| E52 | 抽屉几何 | F1 | 桌面打开事件和额度步骤抽屉，关闭后重开；移动端重复。 | 1440时width=430±1px且right=0±1px；390时全宽；初始完全隐藏；不因dialog默认left=0贴左。 |
| E53 | 键盘与焦点 | F1 | 仅用Tab/Enter/Space切角色、Tabs、开详情、Esc关闭和停止取消。 | 焦点可见、顺序合理；modal焦点被约束；关闭返回有效节点；不发生键盘陷阱/无名称图标按钮。 |
| E54 | 降低动态效果 | F1 | 开启prefers-reduced-motion，再追加事件并切换抽屉。 | 关闭非必要过渡/平滑滚动；功能仍可用；没有持续spinner伪装活动。 |
| E55 | 视觉与对比度 | F1/F3/F5/F6a | 固定时钟和字体加载后拍摄状态截图并核对关键computed style。 | 颜色/字号/间距符合研发文档；主要文字≥4.5:1、控件边界/焦点≥3:1；错误不仅靠颜色；快照不能自动approve重录。 |
| E56 | 读取与内存上界 | F9 | 反复增量轮询大文件，展开超长输出并加载历史。 | 单页≤200 upsert、响应≤512KiB、详情块≤64KiB；渲染活动行≤400、records的UTF-8 JSON缓存≤2.5MiB；截断有提示，轮询不重复全读50MiB。 |
| E57 | 到达时延 | F1 | producer确认完整行已flush；不使用fake timer，重复20次独立追加。 | 本交接将PRD的2秒目标量化为受控20样本至少19条≤2000ms、全部≤4000ms；记录每次延时；网络故障另测，不靠增加断言timeout掩盖超标。 |
| E58 | 观察无执行副作用 | F1 | 加载、切角色、筛选、复制、看历史、重连和导出。 | 业务权威文件hash/预算/准出不变，launcher/spawn调用为0；只允许受限可再建观察缓存；GET不调用LLM/squadctl repair。 |
| E59 | 升级前运行 | F-legacy | 父Run attempts=[]且只有受信任Squad关联、orchestrator.log和官方子执行记录。 | 仍能展示公开活动或明确受限原因；不能依赖新任务重开才可观察；无源记录时见E63。 |
| E60 | 相邻产品回归 | F-review/F-squad | 打开既有review席位过程、durable结果，以及只读ck-squad报告。 | 旧路由/数据语义不变；不把squad报告接入repair mutation；默认jury、repair roles配置不被读取UI修改。 |
| E61 | 生产去演示化 | F1 | 从production构建打开任务页，搜DOM和网络。 | 没有场景切换/模拟活动/重置演示/fake数据徽章；只出现fixture经真实接口提供的业务数据；无CDN或非允许来源网络。 |
| E62 | 导出证据 | F6a | 点击导出已核验记录（最小JSON或Markdown），捕获下载。 | 包含当前轮、候选/基准SHA、断言版本、来源和核验时间；内容脱敏；下载不触发发布；缺证据不得导出为已通过。 |
| E63 | 无记录与终态空页 | F-legacy-empty | 已结束旧任务只有最终报告，无过程文件；另一个活动任务日志尚未建立。 | 分别显示仅有最终报告/等待首条记录；可以查看已有报告；不编造时间线，也不无限loading。 |
| E64 | 运行详情真实字段 | F1/F8 | 展开运行详情，提供requested/observed model不同或actual缺失。 | 明确区分请求与实际，未知不写默认模型；长ID和上下文参数可查，不挤占主状态；只读。 |
| E65 | 来源局部不可用 | F2 | 一个子执行文件无读取权限/关系缺失，另一个正常。 | 整体仍可查看有效角色；标明受限来源与原因，不把错误转为空成功；不越界扫描修复缺失来源。 |
| E66 | E2E环境自身隔离 | Harness | 测试端口被占、测试退出/失败、生产配置哨兵存在。 | 端口占用立即失败不reuse/kill；结束只清理自己PID和临时目录；用户43127与真实COUNCILKIT_HOME零请求、零变更。 |
| E67 | 后续复审子Run | F-child-review | 父repair推进到终验，出现新的childReviewId及多jury席活动，原sourceRun也有旧日志。 | 新增终验复审分组，绑定本轮子Run；原始sourceRun不冒充当前执行；子席完成不提前宣布整个repair准出。 |
| E68 | 终态与最后日志排空 | F6 | 业务终态先到、最后一条完整日志稍后落盘；另有候选完成但父任务未终态。 | 最后记录仍可见；只有父任务终态且来源已排空才停止周期观察；候选完成不能使后续终验永远不可见。 |

## 5. 需求覆盖矩阵

每个R都必须至少有一个真实浏览器E2E结果。I/A映射保留原PRD编号；不是通过增加UT数量弥补漏掉的用户路径。

| 需求 | 产品要求 | Spec来源 | 必测E2E |
|---|---|---|---|
| R01 | 首屏原目标、阶段、活动、介入 | PRD§1/3 A1 | E01 E02 E20 E39 E64 |
| R02 | 动态角色、共享执行、并行、选择保持 | PRD§3 I1 A5 | E03 E04 E05 E06 E26 E67 |
| R03 | 关键活动、工具合并、读写区分 | PRD§3/6 | E07 E08 E09 E10 E41 E44 |
| R04 | 暂停跟随、新活动、手动滚动 | I2 A2 | E11 E12 E13 E14 |
| R05 | 组合筛选和空态 | I3 A3 | E15 E16 |
| R06 | 详情、长输出、复制、焦点 | I4 A3/A9 | E17 E18 E19 E52 E53 |
| R07 | 在线/静默/断线真实语义 | I5/I6 A4 | E20 E21 E22 E23 E24 E25 |
| R08 | 异常、资格、换席指导 | I7 A8 | E27 E28 E32 E65 |
| R09 | 停止/取消/确认 | I8 A7 | E29 E30 E31 E32 |
| R10 | 历史只读、返回当前 | I9 A5 | E33 E34 E43 E44 |
| R11 | 验收四态、身份、候选≠准出、导出 | I10 A6 §5 | E35 E36 E37 E38 E62 E68 |
| R12 | 重放、半行、轮转、刷新/重启 | PRD§6 I1 | E08 E24 E40 E41 E42 E43 E44 E45 |
| R13 | 服务端脱敏、公共活动、安全来源 | PRD§6 | E46 E47 E48 E49 E50 E58 |
| R14 | 窗口、截断、有界读取、2秒目标 | PRD§1/6 | E18 E40 E56 E57 |
| R15 | 多视口、键盘、视觉和reduced-motion | A9 | E51 E52 E53 E54 E55 |
| R16 | 原型到生产/回归/无记录兼容 | A10生产适配/§6 | E59 E60 E61 E63 E66 |
| R17 | 验收源/日志源受限不能伪造成功 | PRD§6 A6 | E22 E38 E59 E63 E65 |

## 6. Gate 与报告格式

开发前先提交可执行的红色E2E骨架和fixture producer；首次红色应因产品缺功能而失败，不因端口/凭据/错误选择器失败。生产接线完成后全套绿，**禁止用skip、放宽断言、改全量API为mock或更新截图来消除失败**。

交付结果至少含：`requirementId, caseId, specPath, testTitle, status, candidateSha, fixtureVersion, browser, durationMs, evidencePaths, failureReason`。status只取pass/fail/blocked，不把未跑记为pass。报告附case→R反向映射，检查R01–R17零缺口、E01–E68零遗漏；条件失败不得静默豁免。真实模型冒烟若另行授权单列，不计作这68项。

建议命令（Cursor需先创建对应文件）：
```bash
pnpm exec playwright test -c playwright.repair-observability.config.ts --grep @p0
pnpm typecheck
pnpm build
```

准出条件：68项P0全pass；生产读取路径端到端证据齐全；关键UT与既有review/repair回归通过；无意外网络/用户环境变更；无未解释的console/pageerror；时延与读取上界达标；提交SHA与结果一致。任何源码修正至少重跑受影响用例，最终固定候选跑一次全部P0，不做无变化的重复全审。

失败证据：Playwright trace、before/after截图、sanitized网络HAR或关键响应、producer动作/flush回执、Host错误摘要、测试home内相关工件hash。不得把真实账号凭据写入报告。产物保存在仓库忽略的测试输出目录，正式报告索引引用它们；不能只写“测试都过了”。

## 7. 必须保留的人工确认

UAT-01：目标用户首次看到默认/静默/断线/额度不足快照，各用8秒回答“在做什么、多久前有活动、是否需要处理”。记答案及误解，不把E01元素存在当作理解证明。

UAT-02：对照研发文档的高保真截图，确认信息密度和既有视觉语言一致。截图差异由人说明原因；浏览器E2E覆盖布局和可交互性，不能替代产品审美确认。以上是E2E之外的确认，不用于减少任何P0 case。

## 8. 已知实施风险（不等于可跳过）

- 原型只用静态fake时间、内存数组；生产刷新恢复、日志去重/分页/安全路径必须重新实现并走E2E。
- 现有repair attempts为空，不能仅套用review席位UI。要验证父子来源关联，特别是原始sourceRun与本轮childReviewId不能混淆。
- 现有review live读取器全文件读取且事件缺execution/callId，不直接满足大日志和身份要求。
- 现有测试入口硬编码43127及守卫，须按研发文档先隔离端口；不能访问正在执行的用户修复任务做测试。
- 原型先后发现的dialog默认left、hidden被display覆盖、null.focus均保留回归用例E17/E52，不因“只是CSS”遗漏。
