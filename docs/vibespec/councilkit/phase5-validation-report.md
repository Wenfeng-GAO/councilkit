# VibeSpec Phase 5 端到端验证报告

> 日期: 2026-06-23
> 验证对象: VibeSpec Phase 5（`skills/phase5-verify/SKILL.md`）
> 验证样例: CouncilKit（T1-T4 已实现，T5-T12 未实现的局部集成验证）
> 验证目标: ① 阶段往返（VT fail → FT → 回 Phase 4 → retry）；② static-fallback 降级；③ Step 3.5 触发

## 1. 执行结果总览

| VT | 维度 | 类型 | verdict | 备注 |
|----|------|------|---------|------|
| VT1 | 需求覆盖 | 静态 | failed | R1-R8 缺端到端链路 (T5-T12) |
| VT2 | 页面路由覆盖 | 静态 | failed | 4 路由 1:1 ✓，页面占位 (T8-T10) |
| VT3 | 交互状态覆盖 | 静态 | failed (retry) | 0/N → FT1 → 1/N，走完整往返 |
| VT4 | 视觉一致性 | 实跑 | static-fallback | 无浏览器，静态启发式核对 DESIGN 配色 |
| VT5 | 响应式与 a11y | 实跑 | static-fallback | 组件层缺失无法核 |
| VT6 | 自动化测试 | 静态 | failed | typecheck/lint/build 全绿，0 测试文件 |
| VT7 | 浏览器 QA | 实跑 | static-fallback | 用户流程未实现，仅构建产物可加载 |

最终状态: VT3 经完整往返 + Step 3.5 后，验证收尾。implement 回 completed（FT1 执行完），verify 留 in-progress（VT3 仍 failed，按 scope 收尾不强行 confirm）。

## 2. 机制验证结果

### 2.1 阶段往返（核心目标）✓

完整闭环走通:
1. VT3 failed（交互状态覆盖 0/N）
2. 追加 FT1 到**同一 TASKS.md**
3. `phases.implement.status`: completed → `in-progress` + `resumedFromVerify: true`
4. `phases.verify.status`: in-progress → `blocked`，`pendingFixTasks: ["FT1"]`
5. 模拟回 Phase 4 执行 FT1（落地 `src/components/shared/EmptyState.tsx`，typecheck/lint ✓）
6. implement 回 completed，verify 回 in-progress
7. retry VT3 → 仍 failed（1/N），但验证了往返闭环

**结论**: 状态在 implement ⇄ verify 间可逆往返，SKILL 设计的「failed VT → FT → 阶段退回 → 执行 → 重验」语义成立。这是 Phase 5 相对 Phase 4 单向流的关键新增，验证通过。

### 2.2 static-fallback 降级 ✓

VT4/VT5/VT7 在无浏览器环境下:
- 如实尝试实跑（声明"当前 runtime 无浏览器/截图能力"）
- 降级为静态启发式，**附具体核对清单**（DESIGN 配色 ↔ CSS 变量逐一比对，非空判）
- VERIFY.md 显式标注"未实跑 + 已知缺口"
- `state.json` 记 `verdict: static-fallback` + `fallbackReason` + `staticHeuristic`

**结论**: 反模式防御"不跳过浏览器验证、不空判 static-fallback"成立。降级路径与 Phase 4 验证命令等价性条款同构——能力受限时降级 + 显式记录，不假装通过。

### 2.3 Step 3.5 触发 ✓

VT3 retry 使 `consecutiveFailures` 到 2 → 触发 Step 3.5:
- scope: `single-fallback`（runtime 无独立第二 LLM）
- 盲型: EmptyState 真实非占位，但覆盖仅 1/N（缺口真实）
- 验收型: failed 根因是**产品未完成**(T9-T10 未做)而非验证误判
- verdict: `should-escalate` — 建议不继续逐 FT 补，转人工决定

**结论**: Step 3.5 在 Phase 5 同样可触发且 verdict 有判别力（区分"真缺口"vs"产品未完成"）。与 Phase 4 一致。

### 2.4 验证命令等价性继承 ✓

VT6 按 Phase 5 继承的等价性条款跑: `pnpm typecheck/lint` 被 deps-check 阻塞 → 改 `.bin/tsc`/`.bin/biome` 直调，记录"约定→实际→退出码"。typecheck/lint/build 全 exit 0。条款在 Phase 5 跨阶段复用成功。

## 3. 暴露的设计缺口（核心发现）

### 3.1 consecutiveFailures 预算被"产品未完成"耗尽 ⚠️ 最重要

Phase 5 SKILL 当前对每个 failed VT 统一处理: 生成 FT + `consecutiveFailures` +1。但 failed VT 有两类根因:
- **A. 真验证缺口/回归** — 应 FT 回退 + 计数（设计正确）
- **B. 产品未完成范围** — 如 VT1/VT2/VT3/VT6 都因 T5-T12 未做而 failed。这类若全走完整往返+计数，`consecutiveFailures` 立刻到 3 触发 human-intervention-needed，**但本质不是验证失败也不是 bug，是"还没实现到那一步"**。

验证中被迫用 `deferred-ft`（记建议 FT 但不实际往返、不计计数）临时绕过。这等于在 SKILL 规则外打补丁。

**根因**: SKILL 的 faultType/verdict 分类未区分 A/B。Step 3.5 验收型审查其实已能判（本次 verdict=should-escalate 正是把 B 识别出来），但当前要等到 `cf==2` 才由 Step 3.5 兜底——太晚，预算已在路上被耗。

**改进方向**: 把"根因类型"提到 VT verdict 赋值时（而非等 Step 3.5）。建议:
- verdict 增 `deferred-coverage`（产品未完成，不耗 consecutiveFailures，建议批量回 Phase 4 继续 T{n}）与 `defect`（真缺口，FT + 计数）之分；或
- failed VT 先经一次轻量根因判定（类似 Step 3.5 验收型，但 VT 级即时跑），区别计数。

### 3.2 static-fallback 是否计入"未解决问题"的门禁语义待澄清

SKILL 说 static-fallback 不阻塞 confirm 但须人工知晓。但当多个 VT 是 static-fallback（本轮 VT4/5/7 全是），「未实跑的验证项」占比可能很高，"通过人工确认"的质量存疑。建议: 静态降级 VT 超过某比例（如 >50%）时，confirm 前强制提示"大部分维度未实跑，确认仅基于静态启发式"。

### 3.3 VT 拆分的"局部验证"边界

本轮以 T1-T4 为对象做 Phase 5，但 Phase 5 设计前提是 `implement.status === completed`（全部 task 完成）。对"部分完成"做局部验证时，多数 VT 必然 failed。SKILL 未定义"局部/增量验证"模式。建议: 增 `scope.partialCoverage` 显式声明，对应 VT 容许 `deferred-coverage` verdict（与 3.1 同源）。

## 4. 对 Phase 5 SKILL.md 的改进建议（反馈）

1. **failed VT 根因分类（最高优先，对应 §3.1）**: 区分 `defect`（真缺口/回归，FT+计数）与 `deferred-coverage`（产品未完成范围，不计数，建议批量回 Phase 4）。把 Step 3.5 验收型审查的根因判断前提到 VT verdict 赋值时。
2. **static-fallback 比例门禁（§3.2）**: 静态降级 VT 超阈值时，confirm 前强制提示实跑覆盖率。
3. **局部/增量验证模式（§3.3）**: 显式 `scope.partialCoverage`，容许 `deferred-coverage` verdict。
4. **FT1 与原 task 的依赖标注**: FT 追加 TASKS.md 时应标 `来源VT` 与 `原task` 关系（本轮已做，建议写进 SKILL 模板）。
5. **round-trip 状态往返的字段规范化**: `resumedFromVerify` + `pendingFixTasks` + `verify.blocked` 三元组验证有效，建议在 SKILL state.json 节明确为往返协议字段。

## 5. 结论

Phase 5 三项核心机制在真实代码上**全部验证成立**:
- 阶段往返（failed VT → FT → Phase 4 → retry）闭环工作，状态可逆
- static-fallback 降级路径正确（降级+附依据+记缺口，不空判）
- Step 3.5 触发精确（cf==2）且 verdict 有判别力

同时暴露一个**重要设计缺口**: consecutiveFailures 预算在"产品未完成 VT"场景会被错误耗尽，根因是 verdict 未区分"真缺口"与"产品未完成"。这已在 §3.1 + 改进建议 #1 提出，是下一轮 Phase 5 迭代的最高优先项。

验证过程产出的 5 条 SKILL 反馈，待回灌 `skills/phase5-verify/SKILL.md`（与 Phase 4 同样的闭环）。
