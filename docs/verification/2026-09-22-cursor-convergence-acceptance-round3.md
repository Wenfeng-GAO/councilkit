# Cursor 候选验收：核心路径改善，尚未通过

候选：`faa3de47e070b33d9384e5c6bb0bb709b9d3f7b8`。
分支：`hengzhuo/repair-convergence-control`。
工作树：`/Users/hengzhuo/.codex/worktrees/repair-convergence-control/councilkit`。

## 已独立确认

- `repair-v2-closed-loop` 与 `repair-candidate-verify` 两文件共10项通过。
- `squad-gate-policy` 三项通过，包含官方CLI创建两个合法不同策略和拒绝二次freeze。
- 生产已从自造目录hash改为官方policy-freeze流程；新增detached候选验证与SHA/资产缓存机制。
- 整条Squad strong不可用时启动前拒绝，collaborative需显式选择。

日志：`/tmp/councilkit-cursor-convergence-20260921/codex-acceptance-round3.log`、`codex-official-freeze-round3.log`。

## 未通过原因（已交回Cursor，尚待完成）

1. 恢复路径缺真实预登记intent/完整官方来源核验时仍采纳policy projection。独立临时目录探针没有CK intent/record，弱policy projection仍被接受。需严格核对task、brief、完整policy及授权，并证明合法回执丢失可恢复。
2. 同SHA但cacheKey/测试资产已变化时，旧日志仍被重标为新版本。独立探针观察 accepted=true。另需执行后核对快照，运行中命令受总deadline约束，不能只使用执行前的dirty状态。
3. 使用兼容AntCode CLI做只读身份读取，#128返回headSha但baseSha=null、prOpen=true；严格准出需要对可信target remote/ref做只读补证。没有启动真实PR审查、修复或push。
4. 当前UI截图是静态模拟HTML，不能算实际应用浏览器冒烟。需使用真实React页面/组件和明确标识的受控API边界，验证实际交互；不接触用户43127 Host。

恢复/缓存探针：`/tmp/councilkit-cursor-convergence-20260921/round3-edge-probes.ts` 与同名 `.jsonl`。
AntCode只读证据：同目录 `ant-identity-evidence.json`；本机存在旧版CLI遮挡，探针显式使用兼容CLI，未改全局配置。
聚焦反馈：同目录 `final-edge-feedback.md`，含官方发布授权传递的核对要求。

## 续接位置

Cursor原生开发session：`6d5a90ec-5a58-453f-b377-36999d08e1a3`，模型 `cursor-grok-4.6-high`。
控制目录：`/tmp/councilkit-cursor-convergence-20260921`。`brief.md`、`implementation-after-diagnosis.md`、`final-edge-feedback.md`保存授权、边界和剩余工作；不得将旧候选报成最终通过。

Cursor完成上述四组修正、自审和真实冒烟后，仍由Codex按固定新候选做最终验收。本报告不是部署或准出许可。
