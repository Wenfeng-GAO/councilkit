# Runtime Host V1 Cutover 验收记录

日期：待填（执行验收时填写）
计划：`docs/plans/2026-07-17-001-feat-runtime-host-dual-driver-v1-cutover-plan.md`（Stage gates、可机械判定的验收标准、真实环境 gate、§553 记录要求、§590 首次可用性验收）
范围：Stage A–C 汇总 gate、自动 gate、真实冒烟矩阵、Stage C soak、首次可用性验收。Stage D（U7 删除 legacy 源码）完成后另起记录。

**结论：待填**

## 环境

| 项 | 值 |
| --- | --- |
| 验收日期 | 待填 |
| 机器 | macOS 15.6.1, arm64 (Apple Silicon) |
| Node.js | v22.17.0 |
| Chromium | 待填（`pnpm test:e2e` 实际使用版本） |
| cld CLI | 2.1.211 (Claude Code wrapper) |
| codex CLI | codex-cli 0.144.5 |
| 受信 Installation | `cld-178240c6225e`（trusted，wrapper+claude-binary 双组件）、`codex-fdd3ce2d94ea`（trusted），每次 spawn 前 fingerprint 漂移检查 |
| Driver capability | `claude-stream-json`：待填；`codex-app-server`：待填（checking/ready/auth_required/incompatible，以真实 handshake 为准） |
| 候选版本 commit | 待填 |

## Stage gates

| Stage | 实施单元 | 验证记录 | 状态 |
| --- | --- | --- | --- |
| A：协议证伪 | U1–U3 | `docs/verification/2026-07-17-stage-a-runtime-host.md` | ✅ ALL GATES PASSED（2026-07-17T08:24Z，四路径 conformance + 冷/暖 A/B + 合并 RSS） |
| — U4 | U4 新领域模型、Dexie、Context Snapshot | `docs/verification/2026-07-17-u4-discussion-domain.md` | ✅ 通过（新增 46 用例；全量 318/318） |
| — U5 | U5 Runtime Client、持久化 Orchestrator、暂停语义 | `docs/verification/2026-07-17-u5-orchestrator.md` | ✅ 通过（新增 25 用例；全量 343/343） |
| B：持久化闭环 | U4–U5 | 上述两份记录 + 本文档自动 gate 复跑（候选版本一致） | 待填 |
| C：目标路径接入 | U6 | 本文档以下各节 | 待填 |

## 自动 gate 结果

性能 gate 使用本地 fake Driver（排除供应商网络波动），阈值来自计划「性能 gate」节。

| Gate | 命令 | 阈值/期望 | 实测 | 状态 |
| --- | --- | --- | --- | --- |
| typecheck（三程序） | `pnpm typecheck` | tsc（app）+ tsconfig.host.json + tsconfig.integration.json 全绿 | 待填 | 待填 |
| lint（Biome） | `pnpm lint` | 全绿 | 待填 | 待填 |
| Vitest 全量 | `pnpm test` | 全部通过 | 待填（通过数/总数） | 待填 |
| Chromium E2E | `pnpm test:e2e` | 全部场景通过（设置→Agent→Room→双 Round→刷新保留；重连无重复；mismatch/toolState 暂停；双页 fencing；取消/终止；注入渲染安全；无 legacy DB/API Key 读取；无供应商浏览器请求） | 待填（通过场景数/总场景数） | 待填 |
| 性能：execute→首个规范化输出事件 | `pnpm vitest run tests/integration/runtime-perf.test.ts` | 100 次样本 p95 < 50 ms | 待填（p95 ms） | 待填 |
| 性能：事件连接重连 | 同上 | 断开到首个 replay 事件 < 1 s | 待填（ms） | 待填 |
| 性能：warm 复用 | 同上 | 第二轮无新进程启动、无 Codex initialize/thread/start | 待填 | 待填 |

## 真实冒烟矩阵

命令：`pnpm exec tsx tests/smoke/live-runtime-smoke.ts --route all`（不得与 `pnpm test` 并发运行）。每行：对应 `cld` route + Codex 两个 Participant，完成两个连续 Round 与一次显式 Codex Summary。requested/effective model 任一不一致按产品语义暂停，不得人为标记通过（计划 §587）。

| Route（+ Codex） | requested model | effective model | verdict | spawn 计数（cld / codex） | cold 首 delta (ms) | warm 首 delta (ms) | close 干净 | Codex approval 被拒绝 | cwd sentinel 不可写 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cld ant glm5.2` + Codex | 待填 | 待填 | 待填 | 待填（期望各 1） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 |
| `cld moonshot` + Codex | 待填 | 待填 | 待填 | 待填（期望各 1） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 |
| `cld deepseek` + Codex | 待填 | 待填 | 待填 | 待填（期望各 1） | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 |

剩余风险声明（计划 §588/§694）：Codex 路径使用 `read-only` sandbox、`never` approval 与专用 cwd；approval 被拒绝与 sentinel 不可写已逐行验证，但读取其他本地文件和网络能力仍可能受用户本机 Codex 配置影响，属已接受且文档化的剩余风险。

## Stage C soak

| 场景 | 要求 | 实测 | 状态 |
| --- | --- | --- | --- |
| GLM 5.2 + Codex 代表性 Room | 10 个连续 Round 或持续 ≥15 分钟（以较晚者为准）：进程/init 不增长、Codex thread 不重建、内存/事件缓存不越硬上限、无 ACK pending 泄漏、每轮 Message/Summary 唯一 | 待填（Round 数 / 时长 / 各不变量） | 待填 |

## 结果模板（每条真实路径 / 每次验收运行）

按计划 §553 填写；**禁止记录 prompt 正文、token、Cookie 或模型正文**。

```text
- 环境：日期 / 机器 / Node 版本 / Chromium 版本 / 候选 commit
- Installation 与 Driver capability：Installation id + trust state；各 Driver checking/ready/auth_required/incompatible
- 选用 route 与模型：route、requested model、effective model（canonical）
- 关键计数：每 Participant spawn/init 计数、Message/Summary 数量、ACK 状态分布、重试次数
- 首事件延迟：cold / warm 首 delta（ms，注明样本数与中位数）
- 结论：通过 / 按设计暂停 / 失败
- 失败归因：见「常见失败归因」分类；外部环境阻塞须注明并在稳定窗口重跑
```

## 常见失败归因

| 现象 | 归因方向 | 处置 |
| --- | --- | --- |
| requested/effective model 不一致（verdict=mismatch，Round 按设计暂停） | provider 更换了 route 实际服务模型，或 Driver 闭集映射滞后 | 按产品语义暂停即正确行为，不得标记通过；确认 provider 侧实际服务模型后更新 Driver 路由表声明（先例：Stage A moonshot `servesModel` 定修），再重跑该路径 |
| Codex 冷/暖首 delta 波动大、warm ≤10s 样本不足 | provider 排队/网络波动，非 Host 回归 | 标记「外部环境阻塞」，在稳定窗口重跑；不得以 fake Driver 指标替代通过（计划 §683） |
| Host 启动失败、报端口占用 | 固定 canonical origin `127.0.0.1:43127` 被其他进程占用；Host 永不迁移 origin | `lsof -nP -iTCP:43127 -sTCP:LISTEN` 定位并结束占用进程后重启 |
| Driver capability = `auth_required` | 本机 `cld` 或 Codex CLI 未登录 / 登录过期 | 在终端完成登录后于 Settings 重新检查；CouncilKit 不保存凭据，登录状态只能由 Installation 自行解析 |

## 首次可用性验收（计划 §590，人工执行项）

由一名未参与实现的测试者，在干净目标库上仅按 `README.md` 操作；全程不接触 secret。逐项填写实测值。

- [ ] 环境就绪：干净 clone、Node 22、`cld`/Codex 已安装并登录
- [ ] Host 启动成功（`pnpm install` → `pnpm build` → `pnpm start`），origin `http://127.0.0.1:43127` 可打开
- [ ] Settings 中 Host 与 Installation/登录能力段显示 ready
- [ ] 创建两个 Execution Profile
- [ ] 创建两个 Agent（各绑定 Profile 与 `modelId`）
- [ ] 创建 Room（选择两个 Agent、显式指定 Facilitator）
- [ ] 启动首轮并看到两个 Participant 发言与 Facilitator Summary
- [ ] 总耗时 ≤ 5 分钟（实测：待填）
- [ ] 主要提交/确认 ≤ 8 次（实测：待填）
- [ ] 全程未复制任何 secret
- [ ] 空 Room 列表文案明确说明 V1 未导入但也未删除 legacy 数据

执行人 / 日期：待填
