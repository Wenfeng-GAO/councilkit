# Squad 自动修复入口排查

- 日期：2026-09-20
- 代码基线：`2c5b903`
- 来源 Run：`ck-review-a9eeca4f-c329-44ae-9db3-61e116a61789`
- 失败父 Run：`ck-repair-7918d3e0-d397-42c2-a876-146d550758c6`
- 范围：报告页启动、Host、repair CLI、执行器装配、恢复与准出。
- 操作边界：实际 Run 只读；行为探针使用临时 COUNCILKIT_HOME 和模拟执行器，不启动实际修复、不推送、不改真实授权或 Run。本记录不代表缺陷已修复。

## 结论

当前浏览器入口已开放，但真实 Squad 执行器与后续复审没有接通。此次失败是 AntCode 身份读取缺失触发的启动前退出；补一个 SHA 不能完成修复闭环。入口门禁、工作区、恢复和最终准出仍有独立缺陷。

本次父 Run 的 `outerUsed=0`、`businessResult=needs_attention`、`reasonCode=identity_mismatch`，进程已退出，未进入 Squad 修复。远端源分支与来源审查的完整 SHA 均为 `e75ee6755ea846f2772aca2d13d6ec1ac9b87bed`；本次不是实际提交漂移。

## 已确认缺陷

### 1. AntCode 缺失 headSha，确定触发本次失败（P1）

`cli/src/auto/checkout-pr.ts:182` 的 AntCode 分支只返回分支、仓库和 base，不解析或另行获取 headSha；本次 `antcode pr show` 的原始返回也没有 SHA 字段。`repair-preflight.ts:68` 则强制要求完整 SHA。

只读调用真实 inspect 和 preflight 得到：

```text
identity_mismatch
AntCode PR did not include headSha; repair cannot freeze identity
```

应使用可信远端源分支解析完整 SHA，并与审查冻结 SHA 核对。不能把原审查 SHA 直接填成当前远端 SHA 来绕过检查。

### 2. 真实执行器缺失，界面仍宣称可以启动（P1）

- `cli/src/cli.ts:44` 直接调用 runRepair，无生产依赖装配。
- `cli/src/auto/repair-run.ts:66` 默认使用 FakeSquadBridge；仓库内没有另一种 SquadBridge 实现。Fake 不启动 Agent、不推送，默认候选是 `a` 重复 40 次。
- `repair-run.ts:275` 只接受注入的 reviewImpl，没有真实默认实现；到达此处会退出并给出 `review implementation missing`。
- `repair-run.ts:174` 创建的交接内容只有 `{from, cycle}`，`:185` 给 bridge.start 的 packageFields 是空对象，未交接完整修复任务包。
- `src/components/report/RepairRunPanel.tsx:42` 默认 bridgeAvailable=true，`src/app/pages/ReportDetailPage.tsx:275` 未传真实可用性。

计划 `docs/plans/2026-09-20-001-feat-squad-repair-until-approved-plan.md:53` 明确把真实桥接列为外部交付依赖，并要求缺失时禁用入口。当前实现没有落实这个发布门槛。

### 3. 实际工作区错误，修好 SHA 后仍会失败（P1）

`runtime-host/cli-launcher.ts:106` 使用 Host 的 process.cwd() 启动 CLI；lsof 确认当前 Host cwd 为 CouncilKit 仓库。`repair-preflight.ts:77` 默认校验相同 cwd，并明确禁止以 CouncilKit checkout 作为修复工作区。

只读探针仅补上已独立核验的 SHA，结果变为：

```text
pr_drift
repair workspace must not be the CouncilKit checkout
```

必须建立并冻结目标项目的隔离工作区，区分 CLI 启动目录与修复目录。

### 4. 不完整来源被自动修复入口放行（P1）

实际来源：1 个失败席位，reviewEvidence.complete=false、evidenceComplete=false、7 个 uncoveredIds，手工 export 判定不可用。

`runtime-host/routes/cli-runs.ts:475` 只验证来源目录和 profile 存在。`repair-preflight.ts:106` 仅在没有待处理 finding 时检查完整性；本来源有 28 条非 accepted finding，因此绕过完整性检查。

隔离复制真实元数据并模拟 launcher 的结果：

```text
SOURCE complete=false evidenceComplete=false failedSeats=1 uncoveredCount=7
exportAllowed=false
preflight（提供合法 SHA、独立工作区）=ok:true
Host start → started:true，调用 launcher 1 次
```

按需求 R2，应进入补审/恢复审查，补齐同 SHA 的证据后才派发修复。

### 5. 本次恢复入口不可用，且错误不可见（P2）

`repair-run.ts:121` 在 preflight 通过后才写 repair-grant.json；本次提前退出，文件不存在。Host resume 在 `runtime-host/routes/cli-runs.ts:286` 强制要求这个文件。

隔离调用真实 handler：

```text
resume → HTTP 400: repair grant is missing.
新增 launcher 调用次数：0
```

`RepairRunPanel.tsx:101` 对 needs_attention 加 reasonCode 就显示恢复按钮。repair 分支提前 return 且不渲染 error；SSR 复现同时显示恢复按钮、不显示传入的 resume 错误。

另外 `repair-run.ts:393` 的 finish 收到详细 message 后不持久化、不返回，因此页面只剩错误码。应保存诊断详情，并由持久化阶段和有效授权决定可执行的恢复动作，不能伪造 grant。

### 6. 已进入周期后的恢复不幂等（P1）

`repair-run.ts:174` 对原 cycle 再创建相同 handoff；`repair-handoff.ts:33` 使用 wx 排他创建，已有文件必失败。后续也总是 bridge.start，没有调用 bridge.resume。

隔离完整执行一次失败周期，再恢复同一 Run：

```text
首次 → needs_attention / JOURNAL_GATES_INCOMPLETE / outerUsed=1
恢复 → CliError exitCode=5
cannot create repair handoff; use a new cycle file
```

代码还显示：`repair-preflight.ts:95` 恢复时始终对比最初来源 SHA，合法发布新候选后也会被当成漂移。恢复应读取已落盘任务、handoff、发布阶段与候选，复用原任务并核对对应阶段的远端身份。

### 7. 准出判定覆盖真实复审裁决（P1，隔离复现）

`repair-run.ts:461` 将 aggregatorVerdict 固定为 approve。临时 child report 明确 changes-requested，但账本闭合且覆盖完整时，真实 executeRepairLoop 返回 approved/exitCode=0。同样的数据将实际 verdict 传给 evaluateRepairGate，则正确返回 verdict_contradiction。

必须传递真实裁决；缺失或矛盾不能补成通过。

### 8. 准出前没有最终远端核验（P1，隔离复现）

`repair-run.ts:322` 将 remoteHead 固定为候选、baseUnchanged 和 prOpen 固定为 true。最后一次 inspect 在复审之前。

隔离模拟复审期间远端 HEAD 改变、base 改变和 PR 关闭，循环仍返回 approved/exitCode=0，inspect 总计只有两次。把实际状态交给 gate 则返回 pr_drift。

复审结束后必须重新读远端并校验。第 7、8 项未在本次实际 Run 触发；本次更早就退出。这两项是接通真实执行器后必须修复的后续风险。

## 验证与测试缺口

运行以下现有测试，5 个文件、54 个测试全部通过：

```bash
pnpm exec vitest run \
  cli/tests/repair-command.test.ts \
  cli/tests/checkout-pr.test.ts \
  tests/host/repair-mutation.test.ts \
  tests/unit/repair-run-panel.test.ts \
  tests/unit/repair-gate.test.ts
```

通过原因与缺口：

- 外循环成功测试注入 workspaceCwd、inspectPr、reviewImpl，默认使用 FakeSquadBridge，未覆盖生产装配。
- Host 测试模拟 launcher，不执行真实 CLI；不验证不完整来源应补审。
- UI 的 bridge 不可用测试显式传 false，但报告页没有真实可用性来源；错误展示测试使用 review，而非 repair 分支。
- 恢复测试手工拼状态，source/candidate/published/remote 都是同一个 SHA，且没有保留真实执行留下的 handoff。
- 纯 gate 测试能拒绝矛盾，但未覆盖控制器构造 gate 输入时覆盖真实数据。

## 建议修复顺序及验收边界

1. 真实桥接未就绪时，UI、Host、CLI 均在派发前返回明确的不可用原因；持久化具体错误并修正恢复入口。
2. 接通版本化真实桥接、隔离工作区、完整任务包、冻结配置和真实 review；补齐 AntCode SHA 读取和不完整来源补审。
3. 修复恢复幂等、阶段化 SHA 校验及基于真实证据的最终准出。
4. 隔离仓验收通过后再开放 CTA。必须走真实 Host→CLI 装配，使用不同来源/候选 SHA，覆盖 partial 来源、发布前后中断恢复、拒绝裁决、复审期间远端漂移。

仅让本次 identity_mismatch 消失不足以验收。此次排查未修改业务代码、实际 PR、Run 或授权。
