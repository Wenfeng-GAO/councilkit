# VibeSpec Change Router 端到端验证报告

> 日期: 2026-06-24
> 验证对象: `skills/vibespec-change/SKILL.md` + 5 phase skill 的 CR/stale 四分支检测（v2 MVP）
> 验证场景: CouncilKit "模型 endpoint base_url 可配，复用 Anthropic 兼容网关"
> 验证目标: ① 阶段往返（CR → cascade含implement → 入口重做 → 下游re-verify → CR closed）；② M2 代码进cascade（CR驱动FT不依赖Phase5）；③ CR 优先 VT 不死锁

## 1. 执行轨迹（完整往返）

| 步骤 | skill | 动作 | state 变化 |
|------|-------|------|-----------|
| Step 0-3 | vibespec-change | `--phase=tech`，无并发CR，合理性无纠偏，用户确认 | CR1.status=pending→confirmed |
| Step 4 | vibespec-change | cascade stale | tech=stale-needs-revision, implement=stale-code-contract, verify=stale-pending |
| Phase3 重做 | phase3-tech | 分支2变更重做模式：TECH 加"base_url可配"决策 + API契约说明 + 局部重确认 | tech stale清除→confirmed, CR1→phase-revised, 下游转stale-verify |
| Phase4 FT | phase4-implement | 分支3：核对代码vs新TECH → T5 受影响，CR驱动FT改 claude.ts base_url可配 + vite proxy + .env.example | implement reverify-consistent → stale清除 |
| Phase5 re-verify | phase5-verify | 分支3：核对VT结论vs CR1改动 → R2增强/其余不变 | verify stale清除→ready-for-confirm |
| 收尾 | (状态机) | 全部stale清除 | CR1 → closed |

最终: CR1=closed，tech=confirmed，implement=completed，verify=ready-for-confirm，无残留 stale。typecheck/lint/build/vitest(25/25) 全绿。

## 2. 三项机制验证

### 2.1 阶段往返 ✓

`vibespec-change --phase=tech` → cascade（含 implement）→ Phase3 重做 → Phase4 FT → Phase5 re-verify → CR closed。**与 Phase 5 的 defect-往返同构但方向/触发源不同**：本次是用户主动改上游（CR），Phase 5 是验证发现被动修下游（FT）。两者在 state 上通过 stale 状态机切换，不混淆。

### 2.2 M2 代码进 cascade + CR 驱动 FT ✓（关键修复）

v1 的致命缺口全消：
- cascade 含 `phases.implement`（`stale-code-contract`），改 TECH 后已实现代码被标待核对——不再 silent inconsistent。
- Phase4 分支3 直接核对 `claude.ts` vs 新 TECH "base_url 可配" → 发现 T5 需改 → **CR 驱动 FT**（改 claude.ts/vite.config/.env.example）。
- **不依赖 Phase 5 判 defect 才触发代码修复**。v1 要等 Phase 5 VT 跑出 defect 才知代码过时，且可能误判 deferred-coverage 不产 FT——本验证中 CR 直接驱动，绕开该风险。

### 2.3 CR 优先 VT 不死锁 ✓

CR1 标 verify stale 期间，Phase5 分支检测到 verify stale → VT 暂停（§7）。CR1 re-verify 完成（stale 清除）后 verify 转 ready-for-confirm，VT 恢复。**无 v1 的 CR/VT 共享 state 死锁**。

## 3. 显式 --phase 验证（MVP 前提）

本次用户 `--phase=tech` 与描述（base_url/网关/API）一致，Step1 无纠偏提示。这印证审查 S1：**用户确实知道层**，自动判层非必要。MVP 显式声明路径够用。P1 自动判层待更多场景数据决定。

## 4. 暴露的细节问题（非阻断，记反馈）

### 4.1 Phase 5 re-verify 的"一致判定"较粗
Phase5 分支3 re-verify 时，本次只核对了"CR1 改动是否削弱既有 VT 结论"。但若 CR 改的是 PRD 功能范围，VT1 需求覆盖矩阵可能要整列重算。当前 phase 级粒度下，re-verify 的"核对深度"未在 skill 明确——是重跑受影响 VT 还是只判一致性。**建议 P1 明确 re-verify 触发哪些 VT 重跑**。

### 4.2 stale-code-contract 的 task 粒度
implement re-verify 时标了 `staleCodeContractTasks: ["T5"]`，但"哪些 task 受影响"由谁判定？本次是 change router Step2 粗标 + Phase4 分支3 细化。两处判定职责未在 skill 写清。**建议明确：CR 标候选，Phase4 分支3 实际核对确定**。

### 4.3 局部重确认的"局部"在 phase 级模糊
Phase3 重做实际只改了 TECH 的"技术决策"+"API契约"两节，但 phase 级粒度下整个 TECH 重确认。TECH 其他节（数据模型/依赖/安全）未动也走了一遍确认。**符合 v2 设计（砍 changedSections 取 phase 级），但实操有冗余确认**——这是 M3 砍节的已知代价（审查认可的 trade-off）。

### 4.4 .env.local 不进 git，CR 的"实现证据"如何持久化
FT 改了 claude.ts/vite.config/.env.example（进 git），但真实 Key 在 .env.local（不进 git）。CR 的代码核对证据记在 state.json cr1Reverify，可追溯。但若 revert CR1，.env.local 的人工配置无法自动回退。**MVP 可接受（环境配置人工管），记为限制**。

## 5. 对 SKILL 的改进反馈

1. Phase5 re-verify 触发哪些 VT 重跑需明确（§4.1）
2. stale-code-contract task 判定职责（CR 标候选 vs Phase4 实核）写清（§4.2）
3. Phase3 局部重确认的冗余是 M3 砍节的已知代价，SKILL 可加注（§4.3）——或 P1 评估恢复轻量节级标记

## 6. 顺带达成：CouncilKit 模型配置改动

CR1 端到端验证**同时完成了你要的模型配置改动**：
- `claude.ts`: base_url 改 `VITE_CLAUDE_BASE_URL` 可配（默认 api.anthropic.com）
- openai/deepseek: 已有 VITE_*_BASE_URL（T5）
- `vite.config.ts`: server.proxy `/api/claude` 防 CORS
- `.env.example`: 文档化三 provider base_url 可覆写为 Anthropic 兼容网关（cld 的智谱/DeepSeek/zenmux）

现在 CouncilKit 可配多网关：用户在 `.env.local` 填 cld 的 `CLD_ANT_ANTHROPIC_BASE_URL` + token，浏览器走 `/api/claude` proxy 即智谱 GLM。

## 7. 结论

Change Router v2 MVP 三项核心机制全部验证成立:
- 阶段往返闭环（CR→cascade→重做→re-verify→closed），与 Phase 5 往返清晰分工
- M2 代码进 cascade + CR 驱动 FT，消除了 v1 的 silent-inconsistency 致命缺口
- CR 优先 VT，无共享 state 死锁

显式 --phase 路径印证了审查 S1（用户知层，自动判层非必要）。验证产出 4 条细节反馈待 P1 处理。顺带完成 CouncilKit 模型多网关配置改动。
