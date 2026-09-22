# 评审解读：测试先行后的实现分工

日期：2026-09-23。需求仍以 `docs/verification/2026-09-23-review-explainer-acceptance.md` A01–A12 为准，本文不改产品合同。

公开契约：`tests/review-explainer/contract.ts`（模块路径、路由、testid、磁盘文件名）。

## 范围（只补测试已点名的洞）

1. **冻结 diff 工作台**：解析 `review-context.diff`，按完整比较区间展示全部文件/hunk，旧/新侧行号，二进制与缺失工件明示。
2. **锚点**：注释贴到冻结 SHA 的可信文件+行；删除行在旧侧；失败为待定位。
3. **决策**：待决定 / 打算修复 / 不修复；Host 磁盘持久化；可撤回；无问卷。
4. **PR 跳过**：不修复绑定 PR 身份 + 稳定 ID/显式别名/原断言；fresh 与 `--against` 都注入跳过清单，不再要求模型验证已跳过项。
5. **修复包**：只导出 `will_fix` 选择集，带原断言/反例；意图与 builder claim 不得写成 `verified_closed`。
6. **按需解释**：受限 spawn（对齐 `buildIdeateSpawnSpec`，禁止 `buildSpawnSpec` 全能力）；缓存键含来源/模型/schema；固定 Canvas + 文字回退。
7. **安全**：沿用 session/CSRF/Origin；只读允许的冻结工件；测试控制面不进 `runtime-host/main.ts`。

## 建议模块（测试已按此 import）

| 层 | 路径 | 导出 |
|---|---|---|
| shared | `shared/runtime/review-explainer/diff.ts` | `parseFrozenDiff` |
| shared | `shared/runtime/review-explainer/anchors.ts` | `resolveFindingAnchor` |
| shared | `shared/runtime/review-explainer/decisions.ts` | `applyFindingDecision`, `readFindingDecisions` |
| shared | `shared/runtime/review-explainer/pr-decisions.ts` | `matchesSkippedIdentity`, `skipListForPr` |
| shared | `shared/runtime/review-explainer/repair-selection.ts` | `buildRepairPackageFromSelection` |
| shared | `shared/runtime/review-explainer/explanation-schema.ts` | `parseExplanationPayload` |
| shared | `shared/runtime/review-explainer/canvas.ts` | `renderCanvasModel`, `canvasFallbackText` |
| shared | `shared/runtime/review-explainer/explanation-cache.ts` | `createExplanationCache`, `explanationCacheKey` |
| host | `runtime-host/routes/review-explainer.ts` | `reviewExplainerRoutes`，挂进 production `main.ts`（不含 `__test__`） |
| cli | `cli/src/auto/review-skip.ts` | `formatSkipListForPrompt`，fresh/`against` 都写入席位与 aggregator prompt |
| cli | `cli/src/auto/explain-spawn.ts` | `buildExplainSpawnSpec` → 走 ideate 限制，不走 `buildSpawnSpec` |
| ui | `src/components/report/workbench/` 扩展 `ReviewWorkbench` | 契约里的 `data-testid` |

## HTTP（POST 做 mutation，Host Route 无 PATCH）

- `GET /api/v1/cli-runs/:runId/review-explainer`
- `GET /api/v1/cli-runs/:runId/review-explainer/files/:fileKey`
- `POST /api/v1/cli-runs/:runId/review-explainer/decisions`
- `GET /api/v1/cli-runs/:runId/review-explainer/repair-package`
- `POST|GET /api/v1/cli-runs/:runId/review-explainer/explanations/:findingId`

## 明确不在本轮实现

- 不跑真实 PR #128，不改鉴权/代理，不把原型 `prototype.html` 复制成产品。
- 不把 repair-observability 的计数 launcher / `page.reload` 当 Host 重启。
- 测试 harness（`tests/e2e/review-explainer/host-entry.mts`）可注入解释执行器并真正杀/起 worker；生产装配不得包含 `__test__/review-explainer`。

## 验证命令（GREEN 时原样再跑，禁止 skip/放宽）

```bash
pnpm exec vitest run tests/unit/review-explainer tests/host/review-explainer \
  cli/tests/review-explainer-skip.test.ts \
  cli/tests/review-explainer-repair-export.test.ts \
  cli/tests/review-explainer-explain-spawn.test.ts
pnpm exec playwright test -c playwright.review-explainer.config.ts
```
