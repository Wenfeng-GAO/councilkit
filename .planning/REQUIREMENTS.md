# Requirements: CouncilKit

**Defined:** 2026-06-25
**Core Value:** 多个 agent 互相看到对方发言并质疑/补充，能产生比独立回答更高质量的综合结论（优于用户手动切 tab 自行综合）。

> **棕地导入说明**：P0 R1–R8 已在 VibeSpec MVP（T1–T12 + FT1/FT2，2026-06-23）交付并 code-verified，列为 Validated。本 GSD 里程碑的 v1 需求 = 下一里程碑的新增工作（验证闭合 + 生产加固 + P1 agent 特性）。VibeSpec 产物（`docs/vibespec/councilkit/`）仍是产品定义的 source of truth。

## Validated (prior MVP — R1–R8)

已交付并验证（typecheck/lint/build/vitest 25 全绿；P0 端到端经真实模型路径 ant glm5.2 验证）。 Locked — 改动需显式讨论。

- ✓ **R1**: 用户能创建一个讨论房间，指定话题 — MVP
- ✓ **R2**: 用户能在房间中添加 agent，选择底层模型（Claude / DeepSeek / GPT） — MVP
- ✓ **R3**: 用户能为 agent 定义角色/立场 — MVP
- ✓ **R4**: 发起讨论后，agent 能看到彼此的发言并互相质疑和补充 — MVP
- ✓ **R5**: 讨论结束后自动生成总结/决策摘要 — MVP
- ✓ **R6**: 用户能在同一房间中基于当前话题继续追问和讨论 — MVP
- ✓ **R7**: 首条 agent 发言 ≤ 10s（stream 10s 超时机制） — MVP
- ✓ **R8**: 用户能作为参与者在讨论中发言，agent 能看到并回应用户发言 — MVP

## v1 Requirements

本 GSD 里程碑范围。每条映射到一个 roadmap phase。

### Verification & Release（闭合 VibeSpec Phase 5 验证门禁）

- [ ] **VERIFY-01**: VT4 视觉一致性获得实跑证据——语义色 CSS 变量（success/warn/error/info）落地，并产出真实浏览器渲染截图
- [ ] **VERIFY-02**: VT5 响应式与可访问性获得实跑证据——桌面/移动断点细化，捕获视口证据；a11y 实跑检查
- [ ] **VERIFY-03**: VT7 浏览器 QA 获得实跑证据——真实 API key 下完成核心用户流程截图（新建房间 → 发起讨论 → 自动总结 → 追问）

### Model Gateway（生产加固）

- [x] **GW-01**: 生产可用的模型网关路径落地，取代 dev-only `scripts/model-proxy.mjs`（自持 API key 直连，或后端代理；不再依赖 `cld ant glm5.2`，浏览器可直达）

### Agents（P1 特性）

- [ ] **AGENT-01** (R9): 用户能保存 agent 配置并在不同房间复用（agent 模板 / "技术评审团"组合）
- [ ] **AGENT-02** (R10): 用户能把房间切换为独立回答模式——agent 各自独立回答，便于对比结果
- [ ] **AGENT-03** (R11): 用户能在讨论中途加入新 agent 或移除 agent

## v2 Requirements

延后到未来里程碑，当前 roadmap 不覆盖。

### Output & Export

- **EXPORT-01** (R13): 用户能导出讨论记录和总结为 Markdown/PDF

## Out of Scope

显式排除，防止 scope creep。

| Feature | Reason |
|---------|--------|
| 多人协作（多真人共享一个房间） | 当前是个人工具，协作增加复杂度；用户验证后有明确需求时再考虑 |
| 自动选择最佳模型/角色 | MVP 先让用户手动控制；积累使用数据后再做推荐 |
| 模型微调/训练 | 超出产品范围，使用现有模型 API |
| 工作流自动化（类似 AutoGen） | CouncilKit 是讨论工具，不是任务编排框架 |
| 语音/视频讨论 | 文本讨论是核心；多模态增加复杂度；技术成熟且有需求时再考虑 |
| 云同步 / 团队协作 / marketplace / 移动 app / 实时聊天 | V1 local-first 专注 MVP，已排除 |
| 导出 Markdown/PDF（R13） | 本里程碑不做，延后到 v2（用户 2026-06-25 确认） |

## Traceability

每条 v1 需求映射到恰好一个 phase（见 `.planning/ROADMAP.md`）。P0 R1-R8 已在 VibeSpec MVP 交付，记录为 Completed prior milestone（不占本里程碑新工作）。

### v1 (本里程碑)

| Requirement | Phase | Status |
|-------------|-------|--------|
| GW-01 | Phase 1: Production Model Gateway | Complete |
| VERIFY-01 | Phase 2: Verification Gate Closure | Pending |
| VERIFY-02 | Phase 2: Verification Gate Closure | Pending |
| VERIFY-03 | Phase 2: Verification Gate Closure | Pending |
| AGENT-01 | Phase 3: Agent Templates | Pending |
| AGENT-02 | Phase 4: Independent-Answer Mode | Pending |
| AGENT-03 | Phase 5: Mid-Discussion Agent Management | Pending |

### Validated (prior MVP — traceability only)

| Requirement | Phase | Status |
|-------------|-------|--------|
| R1 / R2 / R3 / R4 / R5 / R6 / R7 / R8 | Prior milestone (VibeSpec MVP) | Validated (2026-06-23) |

**Coverage:**

- v1 requirements: 7 total
- Mapped to phases: 7 ✓
- Unmapped: 0 ✓
- Duplicates: 0 ✓
- Traceability (v1 + validated): 15/15 records ✓

---
*Requirements defined: 2026-06-25*
*Last updated: 2026-06-25 — traceability populated after ROADMAP.md creation*
