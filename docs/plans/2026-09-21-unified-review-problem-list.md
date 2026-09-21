---
title: "审查报告：统一问题清单与可信修复状态"
type: feat
status: completed
date: 2026-09-21
implementation: Grok Build
acceptance: Codex
---

# 审查报告：统一问题清单与可信修复状态

## 用户目标与分工

用户看完报告应能立即知道审查结论、优先处理的问题，以及哪些问题已有修复验证。保留 finding 账本的跨轮身份与严格关闭能力，将其融入一份统一的问题清单，不再将全量账本和全量汇总正文上下重复铺开。

用户指定 Grok Build 承担代码实现、测试、浏览器验证与返修，Codex 负责本开发文档及独立验收。Grok 自主解决常规实现决策，避免反复询问。不要创建 PR、推送、发布、修改用户真实 run 数据、启动真实审查或自动修复。

## 已确认的真实案例

只读样本：`~/.config/councilkit/runs/ck-review-bf9ea27c-aac2-48c3-bd8a-177fd641158c/`。

- SHA 为 `9b92b35016aedbbe308551923da963695386ed9c`；24 条均 open，无 repairClaim/verification；againstRunId 为 null。
- 4 条 major 中，`session_recovery.go:357` 的关闭原 UUID 问题被汇总摘要和独立审查原文记了两次。实际 3 个不同阻塞问题，归为恢复补偿与热重启竞争两类。
- diagnostics 的 requiredFindingIds 为 []，coverageComplete 为 true，却在页面显示“评估覆盖完整”。这不是 24 条关闭验证完成。
- 当前先展示全部账本，之后才是概览、共识、独有、分歧与结论。长 ID 抢占阅读空间。

样本可读取并提炼最小合成回归 fixture，不得将完整内部 PR 内容、真实 transcript 或 workspaces 拷入版本库。

## 产品要求

### R1. 单一阅读主线

本轮总览默认顺序为：审查结论与简短概览 → 统一问题清单 → 可展开原始汇总报告。执行状态明确写“审查已完成”，不能暗示“问题已解决”。原始报告、席位报告、复制和修复入口保持可达。

主清单名为“问题清单”。共识／独有只表示来源，不是优先级；可标为来源标签或审查者信息。独有 major 必须同等突出。概览只作摘要，不在主视图再完整展开共识／独有形成第二份待办清单。分歧必须可读；无法可靠关联单个问题时保留单独可展开分歧区，不伪造映射。

### R2. 按问题阅读，保留全部原始证据

每行只优先显示严重度、状态、可读标题，ID 移到展开详情。默认显示阻塞问题，有明确过滤可看全部待处理；零阻塞时展示其它待处理，零待处理时有正确空态。已验证解决、接受不修默认折叠或过滤隐藏，始终可查看。

展开可查看所有成员的原文、来源审查者、文件位置、原始 ID、修复声明和验证依据。对同一问题的冲突意见不得因分组丢失。

### R3. 保守去重与可信计数

先复用已有 `finding-groups.v1.json` 及校验后的分组；没有 sidecar 的历史报告也应支持可证明的重复项展示合并，使本案例 357 同题显示一行、3 个阻塞问题。原始 findings 不删除、不重写。采用小型、可测、保守的展示投影；不要为了 UI 重造完整账本协议。

旧报告的推断合并必须有具体位置加问题身份依据（如相同定位和充分一致的问题描述），不得仅按文件名、行号、severity、中文通用词或 reviewer 合并。同位置的不同根因、不同目录同名文件必须保持独立。不确定则保留，明确区分原始记录数与展示问题数。

组内严重度取最高；任何未被有效关闭/接受的阻塞成员仍阻塞。不得把一个成员的 verified_closed 或 accepted 传播到其它成员。分组是阅读投影，不改变 repair gate、CLI 关闭权限、导出问题 ID 或账本状态；若展示问题数不同于机器记录数，用简短说明解释。

### R4. 解释修复与复审状态

初审显示“本轮新审查，未关联历史修复记录”等明确提示；没有关联时不展示“本轮解决 0 条”这样的进度结论。普通 open 可显示“待处理”，避免暗示已修但失败。

有 againstRunId 时显示可点击的关联报告，复用现有带 `against` 的对照复审入口。不按 PR URL 静默绑定历史。若实现本轮新增/解决/仍存在统计，必须基于真正读取到的关联账本和当前 SHA 验证；缺失或失败则降级为“无法比较”，不猜测。

历史 closed、过期 SHA、repairClaim、验证仍成立、accepted、regress 必须保持已有真实语义。继续使用 `isFindingVerifiedClosed` / `isFindingBlocking`，不得放宽关闭条件。浏览器重开后状态来自持久化记录。

### R5. 覆盖提示准确

初审 requiredFindingIds 为空的覆盖标记不能呈现为对全部新发现的“评估覆盖完整”。改为不显示或“无历史问题需复核”。关联复审才展示历史问题的覆盖状态，缺失/不完整有清晰说明。只修展示语义，不更改自动修复准出规则。

### R6. 兼容与边界

保持现有暗色工作台设计，1440/900/390px 可用，长代码、路径、ID、证据不撑破布局；折叠、过滤支持键盘与可理解的标签。局部更改只针对 review；squad/ideate/repair 与旧数据缺字段均不能崩溃。不要引入依赖、LLM 在线去重、通用框架或 schema 破坏性迁移。

## 实现入口（先核对当前代码，不要求逐一修改）

- `src/components/report/workbench/OverviewView.tsx`
- `src/components/report/FindingLedger.tsx`, `ReviewReportView.tsx`
- `src/lib/review-report.ts`, `src/styles/review-workbench.css`
- `shared/runtime/cli-ledger.ts`, `finding-groups.ts`, `cli-runs-index.ts`, `review-case.ts`
- `cli/src/auto/ledger.ts`, `shared/runtime/reviewer-assessment.ts`
- `src/components/report/StartReviewForm.tsx`, `src/app/pages/ReportDetailPage.tsx`
- `tests/unit/finding-ledger-view.test.ts`, `tests/e2e/finding-ledger-layout.spec.ts`, `cli/tests/ledger.test.ts`

## 验收清单

- [x] A1：真实 24 条案例在新 UI 首先看到结论，默认展示 3 个阻塞问题；357 只占一行，展开可读两份原始证据与 ID。
- [x] A2：同位置不同问题、不同目录同名文件、非传递相似关系不被错误合并；没有可证明重复时保留原条目。
- [x] A3：组内 open + closed、open + accepted、过期验证、not_evaluated、still_open 均不错误显示已解决或解除阻塞；单席严重意见仍保留。
- [x] A4：初审不显示误导的“评估覆盖完整”；复审正确显示关联与覆盖，缺历史数据不假装计算进度；复审入口携带正确 against。
- [x] A5：过滤与展开可操作，已解决可找回，原始报告/分歧/席位报告仍可读；空报告、进行中、失败、无分组旧报告不崩溃。
- [x] A6：1440/900/390px 浏览器验证与截图，无横向溢出；至少包含真实案例等价 fixture、详情展开和筛选切换。
- [x] A7：相关单测、现有账本/repair gate/分组回归、typecheck、改动文件 lint、build 通过。
- [x] A8：真实 runs 未修改；无无关改动；交付独立验收所需命令、日志、截图及限制说明。

## 执行与交付

在分配的隔离 worktree 实现。先阅读仓库 AGENTS.md 与 frontend-design skill（`/Users/hengzhuo/.codex/skills/frontend-design/SKILL.md`），沿用项目设计。自主完成上述全部要求、定向测试和自查，不把“实现计划”作为最终交付。验收发现问题交回同一 Grok 会话返修。

运行中的 43127 属于用户 Host，不得 kill/restart；不让 Playwright 误复用旧 bundle 当新实现证据。可用隔离 Vite/Playwright 预览端口配合只读 fixtures 验证新 worktree。不要提交测试截图或工具日志到源码；放本任务 artifacts 目录。不要改 lockfile 来解决非必要问题。

输出 `docs/verification/2026-09-21-unified-review-problem-list.md`，列出 A1–A8 结果、实现选择、精确测试命令/结果、截图绝对路径与未完成项。状态到待验收即可，由 Codex 最终确认。无需提交 commit、push 或 PR。

## 交付状态

2026-09-21：Grok Build 完成实现及两轮返修，Codex 独立验收通过。代码位于隔离 worktree `/Users/hengzhuo/.codex/worktrees/finding-problem-list/councilkit`，分支 `hengzhuo/finding-problem-list`。未提交、未推送，当前 43127 Host 未切换。详细证据见对应 verification 文档。
