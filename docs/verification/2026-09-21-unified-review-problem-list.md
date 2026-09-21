---
title: "统一问题清单与可信修复状态 — 验收通过"
date: 2026-09-21
status: accepted
implementation: Grok Build
acceptance: Codex
---

# 统一问题清单与可信修复状态

状态：**验收通过**（Codex 最终独立验收）。未 commit、未 push、未开 PR。未改用户真实 run，未 kill/restart `127.0.0.1:43127`。

展示数量若少于账本条数，文案为「已合并阅读（原始记录保留）」，不再称「可证明的重复」。

## 实现选择

- **阅读投影，不改账本协议。** `src/lib/finding-list.ts` 只做展示分组。不改 `shared/runtime/cli-ledger.ts` 的关闭规则。
- **推断合并。** 相同引用定位仍必要。共享触发/上下文（最长公共子串）先剥掉，不能当缺陷证据；重叠 n-gram 不充当独立证据。只比较剥除后的互不重叠实质片段（缺陷/后果）。无法证明则保持独立。组内必须两两匹配。Sidecar 同一 `rootCauseId` 仍合成一条。
- **Sidecar。** 同一 `rootCauseId` 的多条 sidecar 记录合成一个展示问题；无 sidecar 时 mutex vs 鉴权仍保持两条。
- **对照统计。** `resolved` 只计当前 SHA 的 `verified_closed`。`accepted` 单列。HTTP 成功但 `hasFindings!==true` 且 findings 为空 → `unavailable`，不算「全部新增」。
- **空账本。** `kind=review` 即使 0 条也显示问题清单、初审/关联/覆盖和空态。
- **文案与标题。** 分歧副文案改为「查看审查者之间的不同意见」。折叠行标题截到 80 字并保留定位，全文在展开里。

## A1–A8（第一轮反馈后）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| A1 | **通过** | 真实 24 条只读投影仍是 3 个阻塞，357 一行两份 ID。fixture UI 同。 |
| A2 | **第三轮补回归后通过** | 见下方反例。重叠 4-gram / 长公共触发条件曾把「相同未命中路径、不同缺陷」合成 1 条，已按原则修掉，不是改期望。 |
| A3 | **通过** | 关闭规则未改。混合 verified+accepted 现为「已处理（含接受不修）」，进入已解决筛选，不再标待处理。 |
| A4 | **本轮补回归后通过** | 空账本仍有初审提示；`hasFindings=false` 的关联报告显示无法比较，不发明新增数。旧结论未覆盖这两条。 |
| A5 | **通过** | 空报告进行中也显示问题清单空态；筛选/展开/原始报告/分歧仍可用。 |
| A6 | **通过** | 1440 截图里折叠标题已截断，分歧为用户语言，清单在首屏。390/900 无横向溢出。 |
| A7 | **本轮定向通过** | `pnpm typecheck`（四份 tsconfig）、改动文件 lint、定向单测、隔离 Playwright 9 项通过。 |
| A8 | **通过** | `findings.json` SHA-256 仍为 `b9446b4f1b306d47c7ce94271af6ec993a4e08c517da2d75933bf4d8b1bd01ff`。无 commit/push/PR。 |

## 第一轮验收反例

命令：`pnpm exec tsx --tsconfig tsconfig.integration.json /tmp/councilkit-finding-problem-list/acceptance-probe.mts`

| 反例 | 结果 |
| --- | --- |
| `cache.ts:42` resolveCache/readEntry 互斥破坏 vs 缺鉴权跨租户 | `different-root-causes 2 expected 2` |
| alpha/beta 与 gamma/delta 经中间项 | `non-transitive-merge 3 must not be 1` |
| 对照中 prior open → current accepted | `resolved: 0`，`accepted: 1` |
| 合法 sidecar 同一 `rootCauseId` 拆成两条记录 | `valid-sidecar-same-root 1 expected 1` |
| 相同「缓存未命中」触发、互斥锁破坏 vs 缺鉴权泄露 | `same-trigger-distinct-causes 2 expected 2` |
| 共享长前缀、不同后果（卡住 vs 丢日志） | 单测 displayCount=2 |
| 共享通用错误路径叙述、未释放 vs 未校验 | 单测 displayCount=2 |
| 真实 24 条样本 | `blockingCount=3`，357 两成员一行 |

探针原输出：`/tmp/councilkit-finding-problem-list/round3-probe.stdout`

真实样本只读投影（不入库、不改盘）：

```json
{
  "originalCount": 24,
  "displayCount": 23,
  "blockingCount": 3,
  "blockingIds": [
    "root.go--session_recovery.go-266-271-resume-失败只看-ctx.err",
    "session_recovery.go--session_recovery.go-311-362-session_manager.go-369-374",
    [
      "session_recovery.go--session_recovery.go-357-resume-成功-提交-idle",
      "pkg.runtime.manager.session_recovery.go--pkg-runtime-manager-session_recovery.go-357-uuid"
    ]
  ]
}
```

最终 `displayCount=23`，仅合并 357 的两份同题记录（24−1）；302 在收紧规则后保守保留。A1 要求的 3 个阻塞与 357 一行均成立。

## 测试命令与结果

工作目录：`/Users/hengzhuo/.codex/worktrees/finding-problem-list/councilkit`

第三轮返修：

```bash
pnpm exec tsx --tsconfig tsconfig.integration.json /tmp/councilkit-finding-problem-list/acceptance-probe.mts
pnpm exec vitest run tests/unit/finding-list.test.ts tests/unit/finding-ledger-view.test.ts
pnpm typecheck
pnpm exec biome check src/lib/finding-list.ts tests/unit/finding-list.test.ts
CK_ARTIFACTS_DIR=/tmp/councilkit-unified-review-problem-list \
  pnpm exec playwright test --config=playwright.preview.config.ts
```

结果：探针 `same-trigger-distinct-causes 2`；finding-list 28 + view 9 通过；`pnpm typecheck` 四配置通过；lint 通过；Playwright 9 passed。日志：`/tmp/councilkit-finding-problem-list/round3-probe.stdout`、`round3-typecheck.log`、`round3-playwright.log`。

## 截图（不入库）

目录：`/tmp/councilkit-unified-review-problem-list/`

| 文件 | 内容 |
| --- | --- |
| `/tmp/councilkit-unified-review-problem-list/case-default-1440.png` | 24 条等价 fixture，默认 3 个阻塞 |
| `/tmp/councilkit-unified-review-problem-list/case-default-900.png` | 同上 900px |
| `/tmp/councilkit-unified-review-problem-list/case-default-390.png` | 同上 390px |
| `/tmp/councilkit-unified-review-problem-list/case-expanded-357-1440.png` | 357 展开，可见原始 ID 与两份证据 |
| `/tmp/councilkit-unified-review-problem-list/case-expanded-357-900.png` | 同上 900px |
| `/tmp/councilkit-unified-review-problem-list/case-expanded-357-390.png` | 同上 390px |
| `/tmp/councilkit-unified-review-problem-list/case-filter-all-1440.png` | 筛选「全部」 |
| `/tmp/councilkit-unified-review-problem-list/case-filter-all-900.png` | 同上 900px |
| `/tmp/councilkit-unified-review-problem-list/case-filter-all-390.png` | 同上 390px |
| `/tmp/councilkit-unified-review-problem-list/layout-1440.png` | 长路径/长证据展开，无横向溢出 |
| `/tmp/councilkit-unified-review-problem-list/layout-900.png` | 同上 900px |
| `/tmp/councilkit-unified-review-problem-list/layout-390.png` | 同上 390px |
| `/tmp/councilkit-unified-review-problem-list/case-1440.png` | 原始报告与分歧展开后全页 |
| `/tmp/councilkit-unified-review-problem-list/case-900.png` | 同上 900px |
| `/tmp/councilkit-unified-review-problem-list/case-390.png` | 同上 390px |

## 限制与未完成

- **运行中的 43127 仍是用户 Host 的旧 bundle。** 不得重启。验收用隔离 Vite/Playwright。
- **未把真实 run 载入浏览器。** 24 条只做只读投影。
- 无 commit / push / PR。

## 主要改动文件

- `src/lib/finding-list.ts`（新）
- `src/lib/cli-run-status.ts`
- `src/components/report/FindingLedger.tsx`
- `src/components/report/workbench/OverviewView.tsx`
- `src/components/report/workbench/ReviewWorkbench.tsx`
- `src/app/pages/ReportDetailPage.tsx`
- `src/styles/report.css` / `src/styles/review-workbench.css`
- `tests/unit/finding-list.test.ts`（新）
- `tests/unit/finding-ledger-view.test.ts` / `tests/unit/cli-run-status.test.ts`
- `tests/e2e/finding-ledger-layout.spec.ts`
- `playwright.preview.config.ts`（新）


## Codex 最终独立验收

结论：**通过**。实现与两轮返修均由 Grok Build 完成；Codex 只编写开发文档、验收探针并审查交付。

- 真实只读样本：24 条原始记录 → 23 个展示问题、3 个阻塞；357 一行，包含两份原文与 ID；展开后24条证据全部保留。302 不再推断合并。
- 独立反例：不同根因=2；非传递相似=3；接受不修单列且 resolved=0；同根因 sidecar 分段=1；相同触发条件但不同缺陷=2。全部符合预期。
- 独立回归：81 项关键单测通过（账本、门禁等），最后修改后再次运行问题投影与视图共37项通过；`git diff --check` 通过；最终 `pnpm build` 退出0。
- 浏览器：Codex 独立运行9项通过，最终返修后Grok再跑9项通过；1440/900/390px筛选、展开、关联缺失与空态覆盖。已查看最终截图。
- 完整 `pnpm typecheck` 四配置通过，日志 `/tmp/councilkit-finding-problem-list/round3-typecheck.log`；构建日志 `/tmp/councilkit-finding-problem-list/codex-final-build.log`。
- `findings.json`、`report.md`、`transcript.jsonl`、`assessment-diagnostics.v1.json` 四个真实文件与任务开始时SHA256完全一致。
- 旧报告的阅读合并是保守展示推断，不能替代原始finding的关闭证据。机器准出规则未改。
- 交付工作区：`/Users/hengzhuo/.codex/worktrees/finding-problem-list/councilkit`，分支 `hengzhuo/finding-problem-list`。代码尚未commit/push；运行中的43127 Host仍是原版本。
