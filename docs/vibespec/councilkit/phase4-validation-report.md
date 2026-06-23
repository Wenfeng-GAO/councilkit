# VibeSpec Phase 4 端到端验证报告

> 日期: 2026-06-23
> 验证对象: VibeSpec Phase 4（`skills/phase4-implement/SKILL.md`，含本轮新增的 Step 3.1 MUST-HAVE 与 Step 3.5 升级前对抗审查）
> 验证样例: CouncilKit（React/TS/Vite/Tailwind/Dexie web app，按已确认 TECH.md）
> 执行范围: T1–T4（构建 → 入口 → 数据模型 → 数据库层），不追求产品完整，聚焦机制验证

## 1. 执行结果总览

| Task | 范围 | typecheck | lint | build | Step 3.1 | 结果 |
|------|------|-----------|------|-------|----------|------|
| T1 | 构建工具链脚手架 | ✓ | ✓ | n/a | ✓ passed | completed |
| T2 | 入口/样式/路由 | ✓ | ✓ (retry) | ✓ | ✓ passed | completed |
| T3 | 数据模型 + 校验 + 工厂 | ✓ | ✓ | n/a | ✓ passed | completed |
| T4 | Dexie db + service registry | ✓ | ✓ | ✓ | ✓ passed (attempt 3) | completed |

最终状态: `.vibespec/state.json` 的 `implement.tasks` T1–T4 = completed，`consecutiveFailures` = 0，`currentTask` = T5（后续）。

## 2. Step 3.1 MUST-HAVE（EXISTS / SUBSTANTIVE / WIRED）验证

**机制有效**: 在 T4 真实抓到了 typecheck/lint 全绿但实质占位的代码——

- `model-registry.ts` attempt 1: `stubService.streamMessage` 抛 `throw new Error("not implemented")`。tsc 通过、biome 通过，但 Step 3.1 SUBSTANTIVE 判定"近 stub 占位"→ fail。
- 同文件 `dispatchMessage` 导出但无任何调用者，Step 3.1 WIRED 判定"未接线"→ fail。
- 这正是方案 A（GSD EXISTS/SUBSTANTIVE/WIRED）的设计目标：堵住"typecheck 能过但近 stub / 没接线"的盲点。**验证成立。**

**机械化判定可执行**: EXISTS/SUBSTANTIVE/WIRED 用"文件存在 + 无 placeholder + 符号被 import + 字段匹配 TECH"静态判据，在本次验证中可稳定执行。

### 2.1 发现的规则张力（建议反馈到 SKILL.md）

1. **脚手架/分层 API 的 WIRED 边界**：
   - 脚手架 config 文件（package.json/tsconfig/vite.config/biome.json/index.html）天然没有"被 import 引用"的调用者——它们是被**工具消费**的入口。本验证按"工具成功读取即 wired"判定通过，但 Step 3.1 文本规则只举了"纯类型导出供后续 task"的 n/a 例外，未覆盖"配置/工具入口文件"。**建议在 WIRED 判据里显式纳入"被对应工具消费（tsc/vite/biome 成功解析）视为 wired"。**
   - 数据访问层（db.ts 的 CRUD）与服务注册表（getModelService）在定义 task 内无业务调用者（调用者在 T7）。这些"层 API 导出"与"纯类型导出"不同，按严格规则会被误判 WIRED=failed。本次对 db 单例实例化判 self-wired 通过，但判据模糊。**建议给"层 API 导出（DAL/service registry）"一个明确的 n/a 或"注册表/单例 self-wired"判据，否则会误判合理架构为 unwired-stub。**

2. **SUBSTANTIVE 对"延期实现"的处理**：T4 model-registry 的 service 真实实现本质属 T5（流式 API 调用）。Step 3.1 对"本 task 内无法给出非占位实现"的能力边界——它只能判"是不是占位"，不能判"该占位是否合理（按依赖顺序）"。本次靠 Step 3.5 的验收型审查补上了这一判断。**说明 Step 3.1 + Step 3.5 的组合是必要的：3.1 抓占位，3.5 判占位是否归属错位。**

## 3. Step 3.5 升级前对抗审查验证

**触发门控精确**:
- T4 attempt 1 失败 → `consecutiveFailures` = 1 → **不触发** Step 3.5（正确）。
- T4 attempt 2（retry）仍失败 → `consecutiveFailures` = 2 → **触发** Step 3.5（正确）。
- 验证了"仅 ==2 且本轮仍失败"的触发条件，第 1、3 次失败不触发，避免了每 task 跑审查的过度成本。

**verdict 驱动修正（核心价值）**:
- 盲型视角（仅 diff）发现 `dispatchMessage` 是死代码、`streamMessage` 是空实现。
- 验收型视角（diff + TECH + PRD R4/R7）判定 `dispatchMessage` 的非占位实现依赖 T5 的具体 model service，归属错位。
- verdict = `should-escalate (rescope)` → 据 verdict 执行 attempt 3：移除 `dispatchMessage`（移 T5），T4 只留 interface + registry → passed。
- **这是 Step 3.5 设计目标的有力证明：升级前的第二视角不仅判"该不该升人工"，还能驱动任务边界修正（rescope），而非盲目重试。**

**降级路径**: 环境无法派独立第二 LLM，本次 scope = `single-fallback`（同一 agent 换视角盲型/验收型）。`unavailable` 降级路径已在协议定义但本次未触发。建议后续在能调度异构 runtime 的环境验证完整 `blind+acceptance` 双 LLM。

## 4. faultType 分类验证

在真实失败场景中分类生效：

| Task | Attempt | faultType | 触发 |
|------|---------|-----------|------|
| T2 | 1 | `lint-error` | biome formatter（import 排序 + CSS 换行） |
| T4 | 1 | `unwired-stub` | stub throw + 孤立导出 |
| T4 | 2 | `unwired-stub` | retry 仍占位（同根因） |

- `lint-error` 与 `unwired-stub` 分类准确；自由文本 reason 始终保留为真源。
- T4 的"同根因连续两次 unwired-stub"序列，正是 faultType 序列在升级消息中要呈现的典型形态——证明了故障分类 + 序列对人工定位的价值。

## 5. 其他真实发现

1. **环境: pnpm 11 run 阻塞**（已记入 state.json `environmentNotes`）。pnpm 11 不再读 package.json 的 `pnpm` 字段；`pnpm run` 前置 deps-check 与本地 ignored-builds 策略冲突，阻塞 `pnpm typecheck/lint`。验证命令改用 `./node_modules/.bin/tsc` / `./node_modules/.bin/biome` 直接调用，语义等价、不阻塞。**提示 Phase 4 的"验证命令"协议对工具链碎片化（pnpm 版本/策略差异）的鲁棒性：建议在 skill 里说明"验证命令以实际可执行的等价命令为准，记录偏离"。**

2. **Scope cap（3-5 文件/task）与脚手架/数据模型的张力**：T1 脚手架 6 文件、T3 数据模型本可 5 文件但 6 实体天然偏多。本次控制在了可接受范围并记录偏离。**提示 cap 对"逻辑单元天然文件数多"的场景（脚手架、多实体模型）需有弹性表述或允许标注偏离。**

3. **TASKS 拆分依赖倒置**（由 Step 3.5 暴露）：Step 0a 把 `dispatchMessage` 划进 T4，但其实现依赖 T5。Step 3.5 审查纠正了这点。**提示 Step 0a 的 11 层依赖排序对"调度逻辑 vs 具体实现"的归属需要更细，避免把依赖下游实现的调度放进前置 task。**

## 6. 对 Phase 4 SKILL.md 的改进建议（反馈）

基于本次验证，建议后续迭代：

1. **WIRED 判据补全**（§2.1-1）：明确"工具消费型配置文件"与"层 API 导出（DAL/registry/单例）"的 wired 判定，避免误判。
2. **Step 3.1 与 Step 3.5 的分工写清**（§2.1-2）：3.1 判"是否占位"，3.5 判"占位是否合理/归属错位"——当前 SKILL 已隐含，建议显式表述两者互补。
3. **验证命令鲁棒性条款**（§5-1）：允许"以可执行的等价命令替代约定命令并记录"，避免工具链碎片化阻断自检。
4. **Scope cap 弹性**（§5-2）：对脚手架/多实体等天然多文件逻辑单元，允许标注偏离与理由。

## 7. 结论

本轮 T1–T4 端到端验证了 Phase 4 新增的两项机制：

- **Step 3.1 MUST-HAVE**：成功抓到"typecheck 绿但占位/未接线"，体现设计价值；同时暴露 WIRED 判据对配置文件与分层 API 的边界需补全。
- **Step 3.5 升级前对抗审查**：`consecutiveFailures==2` 触发门控精确，verdict 真实驱动了任务边界修正（rescope），证明了"升级前第二视角"高于盲目重试的价值。

两项机制在真实代码上可用、有效，且验证过程产出了 4 条可落地的 SKILL.md 改进反馈。CouncilKit 本轮实现链路（构建→入口→模型→db+registry）typecheck/lint/build 全绿，可作为后续 T5–T12 的基座。
