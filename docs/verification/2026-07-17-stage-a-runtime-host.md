# Stage A 验证记录 — Runtime Host 双 Driver V1

日期：2026-07-17
计划：`docs/plans/2026-07-17-001-feat-runtime-host-dual-driver-v1-cutover-plan.md`（U1–U3 + 真实 CLI conformance 门 + 冷/暖 A/B 门）

**结论：Stage A 官方全量门单次运行 `ALL GATES PASSED`（2026-07-17T08:24Z，exit 0）——四路径 conformance + 冷/暖 A/B + 合并 RSS 全部通过。**

## 环境

| 项 | 值 |
| --- | --- |
| 机器 | macOS 15.6.1, arm64 (Apple Silicon) |
| Node.js | v22.17.0 |
| codex CLI | codex-cli 0.144.5 |
| cld CLI | 2.1.211 (Claude Code wrapper) |
| 受信 Installation | `cld-178240c6225e`（wrapper+claude-binary 双组件）、`codex-fdd3ce2d94ea`，每次 spawn 前 fingerprint 漂移检查 |

## 单元/集成测试

- `pnpm test`：**272/272 通过**（18 个文件；vitest forks 单串行）
- `pnpm typecheck`（tsc + tsconfig.host.json）、`pnpm lint`（biome）：全绿
- 关键覆盖：U1 Host 壳/契约/安全/bootstrap；U2 Installation/Profile；U3 supervisor+watchdog（20）、driver-contract 双驱动（14）、claude-stream-json（9，含 moonshot servesModel 归一化两项）、codex-app-server（5）、session-reconciler（9）、协议语料回放（6：codex 正常/崩溃/中断/审批 + cld 全 turn 会话 + cld 握手）、集成（10，含跨 scope 同 Participant 冷启动回归）

## 真实 CLI conformance 门（官方单次全量运行）

命令：`TSX_TSCONFIG_PATH=tsconfig.host.json node --import tsx tests/smoke/real-cli-conformance.mts --out /tmp/ck-stage-a-gate.json`。每路径：installation 校验 → scratch driver 探 canonical → conformance（双轮/cancel/恢复/关闭）→ 5 cold（每样本新 scope）→ 5 warm（同 scope 连发）→  verdicts → 合并 RSS。

| 路径 | 结果 | canonical（driver 归一化） | verdict | 双轮+复用 | cancel→恢复 | close 回收 |
| --- | --- | --- | --- | --- | --- | --- |
| cld-ant (GLM 5.2) | ✅ | `GLM-5.2[1m]`（catalog default） | match ×全轮 | spawns=1 | user_cancelled → 恢复轮完成 | 进程全回收 |
| cld-moonshot (Kimi) | ✅ | `Kimi-K2.5`（route 声明 servesModel，见下） | match ×全轮 | spawns=1 | user_cancelled → 恢复轮完成 | 进程全回收 |
| cld-deepseek | ✅ | `deepseek-v4-pro[1m]`（catalog default） | match ×全轮 | spawns=1 | user_cancelled → 恢复轮完成 | 进程全回收 |
| codex app-server | ✅ | `gpt-5.6-sol`（preferred，catalog 闭集内） | match ×全轮 | spawns=1 | user_cancelled → 恢复轮完成 | 进程全回收 |
| 合并 RSS | ✅ | — | — | — | — | — |

原始结果：`/tmp/ck-stage-a-gate.json`（官方单次全量，08:24Z）；当日更早的分路径运行留档于 `/tmp/ck-stage-a-gate-{deepseek,codex,moonshot,rss}.json`。

## 冷/暖 A/B 数据（官方运行，中位数，ms）

| 路径 | cold prewarm 中位 | warm prep 中位 | prep 降幅 | cold 首 delta 中位 | warm 首 delta 中位 | warm ≤10s |
| --- | --- | --- | --- | --- | --- | --- |
| cld-ant | 581 | 2 | −99.7% ✓ | 520 | 504（≤ cold+500 ✓） | 5/5 |
| cld-moonshot | 581 | 2 | −99.7% ✓ | 1164 | 762 ✓ | 5/5 |
| cld-deepseek | 607 | 2 | −99.7% ✓ | 1589 | 991 ✓ | 5/5 |
| codex | 1506 | 3 | −99.8% ✓ | 10119 | 5805 ✓ | 4/5（阈值 ≥4/5 ✓） |

阈值（计划 Stage A）：warm prep ≤ 20% cold 且省 ≥500ms；warm 首 delta ≤ cold+500ms；≥4/5 warm 首 delta ≤10s。四路径全满足。

## RSS（Host + cld + codex 常驻）

- Host 355MiB（Δ0MiB），两 Driver 进程合计 384MiB，**合并 Δ=384MiB ≤ 2GiB**，通过。

## moonshot 定修（2026-07-17，用户确认后）

- 现象（定修前）：moonshot catalog `default → claude-opus-4-8[1m]`，但 route 实服务 `Kimi-K2.5`（4 次独立 live 探测稳定复现）；driver 按 catalog default 归一化 → verdict=mismatch → 门禁停。
- 用户确认：**Kimi-K2.5 即该 route 的预期模型**（catalog default 为 wrapper 滞后配置，非 provider 故障）。
- 修复（生产代码，driver 显式路由表内）：`runtime-host/drivers/claude-stream-json.ts` 的 `ROUTES.moonshot` 增加 `servesModel: "Kimi-K2.5"` 声明——canonical 以 route 声明的服务模型为准，仍校验其属于 handshake catalog 闭集（不在则 INCOMPATIBLE_DRIVER）；provider 未来换模型时按设计 mismatch 暂停，待人工更新声明。设计依据：计划「模型选择必须来自 Driver 显式映射」「先规范化再比较」。
- 附带变化：`buildBinding`（requested≠canonical 拒绝）此前会在 Host 层拒绝 Kimi-K2.5 请求，定修后 requested=canonical=Kimi-K2.5 全链路一致；首 turn `init_model_drift` 诊断随之消失（init 与 canonical 一致）。
- 回归：`tests/host/claude-stream-json.test.ts` 新增两项（servesModel 归一化 verdict=match；catalog 缺失声明模型时 prewarm 拒绝 INCOMPATIBLE_DRIVER）；fake-cld fixture 支持 `catalog` 覆盖。

## 门脚本修复（测试工具，不改门语义）

1. **RSS 假阳性**：pid 在 watchdog `supervised` 前为 null，原实现只在 spawn 返回时记 pid → driver RSS 恒为 0。改为监听 `supervised` 事件后重测（384MiB 为修复后真实值）。
2. 新增 `--rss-only`：任一路径失败即 exit 的设计下，便于单独重测 RSS 门。
3. `resolveCanonical`：preferred 模型必须属于 live catalog 闭集（codex 路径既有行为，提取共享并加校验）。

## 协议语料

- `tests/fixtures/protocol-corpus/codex/`：0.144.5 正常 turn + 派生崩溃/中断/审批（回放 4 tests）。
- `tests/fixtures/protocol-corpus/cld/ant-glm5.2-session.jsonl`：真实全 turn 会话（initialize → 完整 turn → 中断 turn，74 帧，含真实 `command_lifecycle` 未知帧），`scripts/capture-cld-corpus.mjs` 捕获、`scripts/build-protocol-corpus.mjs` 脱敏，回放断言 output="OK"、usage 差分 {141,3,~$0.00078}、verdict=match、cancel→user_cancelled。
- 真实行为备忘：cld 中断终态是 `result` subtype `error_during_execution`（非 `interrupted`），经 driver `cancelling` 归一为 user_cancelled；中断后 CLI 注入 `[Request interrupted by user]` user 帧（uuid 不匹配 turn，忽略）。

## 遗留问题

1. **codex A/B 的 provider 波动**：当日 codex 路径 3 次通过（4/5 或 5/5）、2 次因外部环境失败（一次 warm 轮 server 终态错误 willRetry=false，一次 warm ≤10s 仅 3/5）；cold 首 delta 8.5–20.6s、warm 2.1–12.4s 均随 provider 排队波动。按 plan line 683 标记「外部环境阻塞」并在稳定窗口重跑通过；Host 侧 prep（1506→3ms）与 warm≤cold 两项在全部 5 次运行中恒绿。provider 持续恶化时该子阈值可能翻挂。
2. 第二 codex 协议版本语料仍缺（本机 0.144.5 为唯一版本；计划允许随 CLI 更新补样）。
3. `/tmp/ck-proto` 原始捕获仍在 tmp（重启即失）；已脱敏部分全部入库。
4. moonshot 的 `servesModel` 声明是人工维护点：provider 更换服务模型时该路径按设计暂停，需更新 driver 路由表一行。
