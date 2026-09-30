# Cursor 候选最终验收：第二轮未通过，转接口诊断

日期：2026-09-22。候选 `6c9a8d5a474bf1773896229f56acd9efc2c3c304`，前候选 `689f6eb` 保留。

## 已确认改善

复核原探针并按新接口声明验证资产后：弃权伪冲突消除、测试资产版本不符拒绝、缺可信策略的生产装配拒绝、停止失败保持 unknown_writer、dummy GH 凭据读取被拒绝。针对新持久接口另测：`ingestAdjudication(prior)` 保留原断言v1并建立新断言v2；`loadOrCreateChain` 在同PR的新父Run继承预算 used=1。

原无prior投影/旧fingerprint探针不是新持久路径；不能把这些旧接口输出直接算作生产仍未修复。对应日志位于 `/tmp/councilkit-cursor-convergence-20260921/codex-acceptance-probes-round2.jsonl` 和 `round2-state-probes.jsonl`。

## 尚未闭合的生产问题

1. **策略仍未与真实Squad相通。** 默认expected又变成CK目录对象的hash。官方Squad算法包含brief_hash、required_gates、independence及可选delivery_authority；CK catalog是另一种内容。生产没有取得官方policy-freeze回执，显式attest函数也未调用。重复同根因，停止追加局部hash补丁，先诊断真实接口。
2. **R3验证对象与声明不符。** 在初始source checkout执行后，直接写snapshotSha=candidateSha、dirtyTree=false；日志/asset按assertionId复用，不按候选与测试资产隔离。无command的责任被排除，code_trace尚未形成同等级必需验收。此为源码核对，不宣称已在真实PR上误准出。
3. **强隔离能力超过真实边界。** 凭据黑名单补丁不能证明所有发布路径被拒绝；整个Orchestrator需要写Squad journal，与禁止控制目录写入存在冲突。现有fake-runtime测到native session不等于真实Orchestrator工作流可完成。
4. **部分预算仍未成为执行前门禁。** verify在执行后才consume且失败可被忽略；plan/format独立额度缺少实际消费路径。必须改为真实阶段的有限执行和前置预算，而非保留未兑现的字段。

## 诊断与明确实施边界

Cursor以Ask只读模式追踪实际安装Squad代码，确认官方 `gate policy-freeze` 的stdout与不可变`gate.policy.freeze`事件是策略来源，不能使用候选字段或fixture目录代替。完整诊断：`/tmp/councilkit-cursor-convergence-20260921/cursor-integration-diagnosis.md`。

后续实施按官方接口建立规划就绪→控制器冻结策略→续接执行的握手；验证必须对实际candidate worktree/版本化资产执行，code_trace单独举证；缺证据保持unknown。

当前整体Squad adapter无法兑现硬隔离时，strong应在源码写入前拒绝，显式collaborative保持可用并明确是协作约定，不能自动降级。暂不建设新的权限代理平台，不修改OS/Keychain。

原Cursor session `9d41e367-4cce-4861-8123-28029fb8e4a3`保留Ask模式，恢复调用没有取得可写模式。本次显式fresh-session交给 `6d5a90ec-5a58-453f-b377-36999d08e1a3`，同Cursor模型、同工作树，交接文件为 `implementation-after-diagnosis.md`；不声称原生会话连续。仍由Codex做最终验收。
