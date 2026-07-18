# CouncilKit 下一阶段产品发展方向与体验优化评审报告

日期：2026-07-18
输入：V1 Runtime Host 切流验收完成（`docs/verification/runtime-host-v1-cutover.md`），真人可用性验收合格。
定位：下一阶段产品迭代的方向输入与优先级建议，不是实施计划。

## 0. 现状基线

V1 已交付的是**执行基座**：Runtime Host 双 Driver 执行边界、可恢复的持久化讨论编排（Round 状态机、persist→ACK、stall/漂移/中断全部分类收敛）、双页面控制 fencing、不受信输出安全渲染、真实环境冒烟与 soak 验收。这条基座的独特价值：讨论事实（Dexie）与执行会话（CLI 进程）彻底解耦——**Session 可丢、讨论不丢**（soak 已实证 31 次轮转无损）。

但必须看清：切流解决的是"怎么可靠地执行"，而 `docs/product.md` 对产品的定义是"**有组织的多 Agent 协作决策**"，其承诺的产出物是**一份可读的 Markdown 决策报告**。对照原始 MVP（§4-§5、§8-§9），以下承诺**尚未兑现**：

1. 讨论模式（brainstorm / planning / review）与 Room 的"目标输出"字段；
2. Facilitator 提出本轮 focus（当前 Round 无开场引导，Participant 直接轮流发言）；
3. 结束条件（max rounds、Facilitator 建议收敛、用户提前总结 → concluding）；
4. **最终决策报告**（背景/目标/参与 Agent/讨论摘要/关键共识/剩余分歧/建议/风险/下一步）——MVP 的核心交付物，当前只有逐轮 Summary；
5. 失败 Participant 的 retry / skip（product.md §143：Agent 失败可跳过继续，Facilitator 失败才暂停；当前任何失败都整轮暂停且只能终止）。

**核心判断：下一阶段的第一优先级应是"兑现 MVP 的决策承诺"，而不是继续加执行层能力。** 执行基座已经足够稳，继续堆基础设施的边际价值在递减，而产品的"决策"内核目前是空的。

## 1. 评估框架

- **A. 兑现度**：离 product.md 的 MVP 承诺有多远（决策报告 > 模式/收敛 > 失败恢复）。
- **B. 可靠性体验**：已验收的可靠性是否以用户可感知的方式呈现（轮转、暂停、恢复不应是死胡同）。
- **C. 资源与运维**：本机进程/探针/窗口的成本是否可控、可诊断。
- **D. 可扩展性**：为 V1.1/V1.2（模板、可视化、质量分）留的接口是否顺手。

## 2. 产品发展方向（按优先级）

### P0 — 决策内核里程碑（建议作为下一里程碑打包）

**D1. 最终决策报告（Final Report）**
MVP 唯一明示的产出物。基于现有持久化事实即可实现：新增一类 Facilitator ModelExecution（resultKind 扩展 `report`，复用完整 Context Snapshot + 全部 Round Summary），产出结构化 Markdown（按 product.md §5.5 九段），落 Dexie 新表或 Room 字段（沿用幂等提交管线，无新一致性风险）。Room 增加 `concluding/concluded` 状态（product.md §7.1 已定义）。配套报告页视图 + Markdown 导出（V1.1 的 PDF 可后置）。

**D2. 讨论模式与目标输出**
Room 增加 `mode: brainstorm|planning|review` 与 `targetOutput` 字段；模式只影响 Facilitator/Summary 的 instruction 模板与报告章节侧重（Instruction digest 体系天然兼容）。这是 D1 的前置——报告质量取决于收敛语义。

**D3. 结束条件与收敛流**
maxRounds 可选设置；Facilitator 在 Summary 中可建议收敛（输出结构化 `converge: true` 信号 → Room 进入 concluding → 触发 D1）；用户随时可「总结并结束」（在 controlling + 非运行中状态下可用，走同一 concluding 路径）。至此产品闭环成立：话题 → 讨论 → 收敛 → 报告。

**D4. 追问体验补全**
`startRoundWithUserMessage` intent：两轮之间输入追问 → 建 Round → 先落用户消息 → 再驱动。消除当前"两轮之间不能发言"的最大 UX 断点（真人验收中已被用户感知）。同时把"运行中发言=stale_context 丢弃当前 turn"的语义在 UI 上说清（发送前提示"将中断当前生成"）。

**D5. needs_rebase 轮转产品化**
soak 已证明轮转路径可靠（31 次无故障），但产品里它现在是死胡同（暂停面板只给设置链接）。给 paused(needs_rebase 系) 面板加主行动「重建执行环境并继续」：abort → closeScope → 冷 scope 全量快照 → 自动开新 Round（编排侧已全部就绪，只差一个 intent 编排）。codex 房间每 ~3 轮必然走到这里，这是高频路径，不是边角。

**D6. 失败恢复三件套**
对齐 product.md §143：Participant 失败 → 面板提供「重试该 Participant（新 execution）/ 跳过并继续（cursor 前进一格，记入失败记录）/ 终止本轮」；Facilitator 失败仍只给修复+终止（不静默换 facilitator）。retry-once 管线与失败记录结构已存在，主要是编排 + 面板动作。

> P0 六项共享同一信息流（模式 → 讨论 → 收敛 → 报告），且全部构建在已验收的持久化基座上，**不触碰 Host/Driver，风险低、感知价值最高**。

### P1 — 可靠性体验与资源卫生

**D7. Settings 探针治理**
当前打开 Settings 会对每个 Profile 做一次真实 CLI handshake（staleTime 30-60s），频繁进出 = 反复 spawn 本机 CLI 进程。需要：readiness/catalog 结果在 Host 侧短缓存（如 60s）+ 失败退避 + 手动刷新入口；页面离开即停止轮询。这是真实可用性磨损点（探针进程在 soak/讨论期间还会抢资源）。

**D8. Scope 资源治理**
CONTEXT.md 已承诺"用户可以显式释放运行时"，目前无入口：Scope 一旦创建永久 warm（CLI 常驻）。建议：Room 列表/头部显示 warm 状态与「释放运行时」动作（closeScope，下次开轮自动冷建）；Host 侧 idle TTL（如 30min 无执行自动 close，取 creatingScopeTtl 同款机制）；配额将满（4 scopes）时的排队提示而非裸 429。

**D9. Host 运维面**
Host 目前是前台进程：`launchd` 后台化/开机自启/崩溃自动重启、版本更新通道、诊断包导出（sanitize 后日志+状态，计划 §766 已列）。对"5 分钟上手"之后的长期体验，这是最大摩擦源（重启说明目前是 README 文字）。

**D10. 多标签控制升级（计划已排期）**
lease 续期/过期、显式「取得控制权」按钮、执行中页面刷新的恢复引导、takeover_failed 后的自助修复。当前 takeover 是自动的，用户不可知也无可控。

### P2 — 体验与增长

**D11. 用量与成本可视化**
`modelExecutions.usage` 已逐执行落库（input/output/costUsd）：Room 级累计、逐轮成本、Room 列表排序依据。零采集成本，纯展示。

**D12. 房间管理完善**
删除/归档/重命名/复制房间；从既有房间复制为新模板（V1.1 模板的前身）；空列表下一步引导。

**D13. Agent 资产化**
enable/disable、Duplicate、JSON 导入导出（product.md §5.1 列项）、单 Agent 测试调用（readiness 探针已具备后端，缺一个「测试」按钮与结果展示）。导入 Profile 的"待绑定"状态（计划 §766）同期考虑。

**D14. 通知与进度感知**
轮次完成/暂停时的系统或页面内通知（后台标签页无感）；Participant 级状态条（等待中/生成中/已完成/失败）替代只有全局 phase；长 turn 的超时预期提示（codex 首 delta 偶发 10-20s，目前无任何预期管理）。

**D15. 搜索与导出**
跨房间全文搜索（Dexie 索引可支持）；单房间 Markdown 导出（D1 前也可先做消息导出，D1 后统一为报告导出）。

**D16. 可访问性与快捷键深化**
Cmd/Ctrl+Enter 发送与开始新一轮、焦点轮廓统一、动效消减（prefers-reduced-motion）、暂停面板动作全键盘流（已有基础，需补齐提交类动作的快捷键语义）。

## 3. 快速体验优化清单（每项 ≈0.5–2 天，可穿插进行）

1. NewRoom/RoomPage 显示「此房间可运行」预检 badge（profiles readiness + agents ≥2 + facilitator 设置），把 prewarm_failed 尽量前移。
2. 暂停面板按 pauseReason.code 直达对应修复对象（mismatch → Agent 编辑页对应 modelId；prewarm → 对应 Installation 行），不只是链接到 Settings。
3. RoomHeader 增加 warm scope 指示 + 一键释放（D8 的最小版）。
4. Settings 探针加手动「重新检查」全局按钮与各行刷新时间戳。
5. 暂停 Room（runState=paused）与 Round paused 的文案区分（当前两种"暂停"并存，用户易混）。
6. 轮次完成/失败时的标题栏闪烁或 favicon 状态点（后台标签页感知）。
7. 观察页控制横幅常驻「哪一页在控制」（hostInstanceId/controllerId 前缀），接管提示更可解释。
8. 发送框在 round 即将暂停时给出"将中断当前生成"的确认（D4 的文案部分）。
9. 报告/摘要块的「复制 Markdown」按钮（D1 前的最小导出）。
10. 深色/浅色主题切换（当前仅深色，低门槛）。

## 4. 风险与权衡

- **报告质量依赖收敛语义**：D1 若先于 D2/D3 做，报告只是 Summary 的拼接；建议打包实施。
- **自动轮转 vs 用户知情**：needs_rebase 轮转在 soak 中是自动的，但产品上"自动关掉用户 scope 再开新的"需要有可见记录（轮转事件应进入时间线，作为一种结构化失败记录呈现，而不是静默继续）。
- **闭集目录与 provider 漂移**：moonshot 漂移（K2.5→K3）证明目录是活的；Agent 编辑页应处理「已选 modelId 不在当前目录」的显式引导（已有标注，需加修复动作）。长期可考虑在 Host 暴露漂移诊断。
- **探针成本与 readiness 新鲜度**：缓存 readiness 意味着状态可能滞后；以「时间戳 + 手动刷新 + 编辑后自动失效」平衡，不做长缓存。
- **资源释放与冷启动**：idle TTL 释放会让下次开轮付出冷启动（2-7s）；给 TTL 留足余量（30min 级），不要激进取消 warm 优势。
- **本地单机 vs 协作愿景**：product.md V2 是协作/云；所有 P0/P1 都应保持"本地事实源 + Host 边界"的架构纯洁，避免为协作埋技术债（例如不要引入任何浏览器直连外部服务的通道）。
- **指标纪律**：成本可视化只用已落库 usage，不为展示而新增计费口径；报告导出不记录 prompt/正文到任何日志。

## 5. 建议的下一阶段切入点

**「决策内核」里程碑 = D1 + D2 + D3 + D4**（D5/D6 视容量并入或紧随其后）。理由：

1. 它交付的是产品的存在理由（决策报告），而不是更多基础设施；
2. 完全建立在已验收的持久化与编排基座上，不改 Host/Driver 协议，风险面小；
3. 每个子项都有明确的既有机制可复用（幂等提交管线、instruction digest、暂停面板、ModelExecution 类型扩展）；
4. 完成后 V1 的故事才完整：从"配置两个 Agent"到"得到一份可导出的决策报告"，README 的承诺闭环。

P1 的 D7（探针治理）建议与 P0 并行启动——它是当下唯一持续磨损日常使用的资源问题，且改动面小。
