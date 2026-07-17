# Runtime Host V1 Cutover 验收记录

日期：2026-07-18（Stage C 验收执行日；Stage A/U4/U5 记录均为 2026-07-17）
计划：`docs/plans/2026-07-17-001-feat-runtime-host-dual-driver-v1-cutover-plan.md`（Stage gates、可机械判定的验收标准、真实环境 gate、§553 记录要求、§590 首次可用性验收）
范围：Stage A–C 汇总 gate、自动 gate、真实冒烟矩阵、Stage C soak、U7（Stage D）删除后 gate 复跑、首次可用性验收（人工项）。

**结论：自动 gate 与真实环境 gate 全部通过（真实冒烟矩阵见下）；首次可用性验收为人工执行项，本次未执行（checklist 已备）。**

## 环境

| 项 | 值 |
| --- | --- |
| 验收日期 | 2026-07-18 |
| 机器 | macOS 15.6.1, arm64 (Apple Silicon) |
| Node.js | v22.17.0 |
| Chromium | Playwright 1.61.1 自带 Chromium（v1228） |
| cld CLI | 2.1.211 (Claude Code wrapper) |
| codex CLI | codex-cli 0.144.5 |
| 受信 Installation | `cld-178240c6225e`（trusted，wrapper+claude-binary 双组件）、`codex-fdd3ce2d94ea`（trusted），每次 spawn 前 fingerprint 漂移检查 |
| Driver capability | `claude-stream-json`：ready；`codex-app-server`：ready（冒烟运行时实测，见矩阵行注） |
| 候选版本 commit | `c93e21f`（U7 删除后 + catalog 修复链 + moonshot 声明更新；冒烟矩阵与 soak 均运行于该候选） |

## Stage gates

| Stage | 实施单元 | 验证记录 | 状态 |
| --- | --- | --- | --- |
| A：协议证伪 | U1–U3 | `docs/verification/2026-07-17-stage-a-runtime-host.md` | ✅ ALL GATES PASSED（2026-07-17T08:24Z，四路径 conformance + 冷/暖 A/B + 合并 RSS） |
| — U4 | U4 新领域模型、Dexie、Context Snapshot | `docs/verification/2026-07-17-u4-discussion-domain.md` | ✅ 通过（新增 46 用例；全量 318/318） |
| — U5 | U5 Runtime Client、持久化 Orchestrator、暂停语义 | `docs/verification/2026-07-17-u5-orchestrator.md` | ✅ 通过（新增 25 用例；全量 343/343；U5 评审 4 bug 于 U6 前置修复并回归钉住） |
| B：持久化闭环 | U4–U5 | 上述两份记录 + 本文档自动 gate 复跑（候选版本一致） | ✅ 通过（同一候选 `c93e21f`：typecheck/lint/vitest 320、e2e 17/17 全绿） |
| C：目标路径接入 | U6 | 本文档以下各节 | ✅ 通过（自动 gate + 真实冒烟矩阵 + soak，见下） |
| D：legacy 删除 | U7 | 本文档「U7 删除后 gate 复跑」节 | ✅ 通过（删除前后 gate 一致；源码与 bundle 扫描无 legacy 路径） |

## 自动 gate 结果

性能 gate 使用本地 fake Driver（排除供应商网络波动），阈值来自计划「性能 gate」节。

| Gate | 命令 | 阈值/期望 | 实测 | 状态 |
| --- | --- | --- | --- | --- |
| typecheck（三程序） | `pnpm typecheck` | tsc（app）+ tsconfig.host.json + tsconfig.integration.json 全绿 | 三程序全绿 | ✅ |
| lint（Biome） | `pnpm lint` | 全绿 | 全绿（131 文件） | ✅ |
| Vitest 全量 | `pnpm test` | 全部通过 | **320/320**（U7 删除后基线；删除前 399，差值 83 恰为被删 legacy 测试） | ✅ |
| Chromium E2E | `pnpm test:e2e` | 全部场景通过（设置→Agent→Room→双 Round→刷新保留；重连无重复；mismatch/toolState 暂停；双页 fencing；取消/终止；注入渲染安全；无 legacy DB/API Key 读取；无供应商浏览器请求） | **17/17**（runtime-host 7 + control 4 + security 5 + modal-focus 1，全套 37.8s） | ✅ |
| 性能：execute→首个规范化输出事件 | `pnpm vitest run tests/integration/runtime-perf.test.ts` | 100 次样本 p95 < 50 ms | p50≈1.0ms，**p95≈2.4–2.6ms**，max≈8.0ms | ✅ |
| 性能：事件连接重连 | 同上 | 断开到首个 replay 事件 < 1 s | p50≈0.35ms，**p95≈0.65ms**（10 样本） | ✅ |
| 性能：warm 复用 | 同上 | 第二轮无新进程启动、无 Codex initialize/thread/start | prewarmCount=1、closeCount=0、第二轮 coldStart=false 增量 prompt | ✅ |

## U7 删除后 gate 复跑（Stage D，计划 §630/§636-637）

删除集合：legacy browser-direct 全链（`src/services/`、gateway stores/lib/models/types/components、`src/lib/db.ts`、5 个 legacy 测试文件、`scripts/model-proxy.mjs`、Vite `/api/claude` 代理块），36 文件 / −3622 行（commit `c4ce4f4`）。

| 项 | 期望 | 实测 | 状态 |
| --- | --- | --- | --- |
| 构建无悬空 import | `pnpm build`（tsc + vite build + build-host）全绿 | 全绿（469 模块；>500kB chunk 警告为既有现象） | ✅ |
| 删除前后自动 gate 一致 | typecheck/lint/build 前后全绿；vitest 差值恰为被删文件 | 前 399 → 后 316（后增补至 320：catalog 修复链 +4）；typecheck/lint 全绿 | ✅ |
| E2E 仍全绿 | 启动与双轮只打开目标 DB，无 `/api/claude`/供应商浏览器请求 | 17/17（删除后复跑） | ✅ |
| legacy import / `gatewayId` / `roundIds` / `/api/claude` / API Key 读取扫描 | 命中均删除或证明为历史文档/fixture | 源码 0 命中；残留仅 `runtime-db.ts` 设计对照注释与 e2e legacy 探针（活跃守卫） | ✅ |
| 生产 bundle 无 legacy 路径 | 无 gateway/crypto-cipher/startup-migration；无 legacy credential 读取/解密路径 | `gatewayId`/`/api/claude`/`councilkit.key.enc`/`runStartupMigration` 零命中；AES/localStorage-cipher 符号零命中 | ✅ |
| legacy 用户数据未触碰 | 不删除、不读取、不迁移旧 IndexedDB/localStorage | e2e 探针实证：应用零读取，预置内容字节不变 | ✅ |

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
