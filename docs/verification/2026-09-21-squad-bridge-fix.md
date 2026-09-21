# Squad 桥修复验收（2026-09-21）

## 根因

报告页 `GET /api/v1/cli-runs/repair/profiles` 返回 `bridgeAvailable:false`，因为 Host/CLI probe 只扫 PATH。真实 `squadctl` 在已安装 skill 的 `scripts/squadctl`。即便找到文件，旧 `SquadctlBridge` 也只是 mkdir / 假回执 / 同步三次 status，无法跑真实分钟级修复。

## 已实现

1. **发现**（`shared/runtime/squad-bridge-discovery.ts` + CLI `squadctl-verify.ts`）
   - PATH、`COUNCILKIT_SQUADCTL` / `COUNCILKIT_SQUAD_SKILL` / `COUNCILKIT_GROKB`、`COUNCILKIT_HOME/squad-bridge.json`、具名 skill 目录。
   - 显式路径无效则失败，不扫描其它 skill。
   - `probe.version` 保持协议 `squad-bridge.v1`；`toolVersion` 来自 `squadctl --version`。生产 `runRepairPreflight({bridgeVersion: probe.version})` 不得把 `squadctl 2.1.0` 送进 `assertSquadBridgeVersion`。
   - CLI：`squadctl --help/--version` 与 `integrate`/`pause`/`intake --new-repair-chain` 真实 argv。
   - Host：spawn 同 checkout `councilkit --json repair probe`，或读诊断缓存；不 spawn squadctl。

2. **journal 门禁**（`squad-journal-map.ts`）
   - 只用 `candidate.status=completed`、`candidate.candidate_sha`、`candidate.policy_hash`、`projection.aggregate_verdict`（approved / reviewer_pass / verifier_pass / 同 SHA / gaps=[]）和 `independence.policy_status=satisfied` + `bound_same_sha` + `provenance_complete` + `shared_*=false`。
   - 未知 aggregate 不能通过。旧 fail / 其它 SHA 不挡当前候选。`actual_identity_complete=false` 允许。
   - `candidate_ready` 还要求 `phase=integrating`。

3. **冻结授权与 pr-profile**
   - start/prepare 传入 grantHash + source/target 身份。
   - `refs/heads/...`、`supported_modes` 三项、`authority_ref=grantHash`。
   - publish 把已通过 journal 门禁的候选原子固定到 controller 私有 ref；`source.ref` 和 `source.sha` 必须解析到同一候选，不移动用户源分支、不发明 grant。已有私有 ref 仅允许同 SHA 幂等复用，符号 ref、不同值及子 ref 前缀误匹配均拒绝。
   - pin 与真实 check/push 共用原始 Git 祖先图（关闭 replace/grafts），避免覆写祖先关系伪造快进。失败诊断在完整原文脱敏后才截断。

4. **Orchestrator**
   - 独立 grok `streaming-messages-json`，解析 `session_id`，绑定 model/executable/skill/workspace。
   - resume 必须同一 native session，禁止 silent fresh。crash 且 pid 已死才恢复。
   - prompt 含 skill/squadctl/包/授权/停点；禁止 Orchestrator 自行 push。
   - init 握手只结束 handshake Promise；exit/error 有持久 supervisor。init 后非零退出、零退出但无合法 candidate、外部 signal，都会落盘并让 status 离开 running。
   - lifecycle 回调绑定 executionId + child PID/fingerprint；stop 后立即 resume 时，旧世代迟到 exit 不得改写新 identity 或删除新 child。

5. **stop / 身份**
   - 冻结 orchestrator `pid/pgid/lstart`。对组发信号前必须 `sameProcess` 核验 live leader；PID 复用则拒绝信号并保留诊断。已核验的本组才 TERM → 有界等待 → KILL（leader 已死后只 SIGKILL 剩余正 PID，不杀复用组）。
   - 父 cycle→taskId/taskDir 在 prepare/spawn 前落盘；公开 stop/resume 扫 `currentSquadTaskId` 与 cycles。旧 writer 仍活不能开第二个。
   - 首次与 resume 共用异步 supervisor：必须观察到 `system/init` session_id。新会话用 `--session-id` 并核对 init；resume 用 `--resume` 且必须等于冻结 session。mismatch / 无 session / exit 17 取消刚启动的 writer 并失败。不把 `GROK_SESSION_ID` 当实际身份。
   - 同一 parent 只 mint 一次 grant；恢复核验并复用原 id/hash/冻结 profile。缺失损坏不重签。

6. **工作区**
   - `git clone --local --no-hardlinks` 后冻结 fetch 与 push URL（含 `remote.origin.pushurl`）。首次、恢复、integrate 前都核对；pushurl 漂移先拒绝。
   - origin 身份解析 SCP / `ssh://`（含端口）/ HTTPS 的 host+完整 path，不用 substring。本地 bare 路径仍可用。已有隔离目录只核验，不 `checkout -B` 原始 SHA。

7. **history / 回执**
   - 入口验证 `squadctl history capabilities --json` 的 `squad-history-bridge.v1`（export / verified_origin_mapping / persisted_origins）。旧 2.1.0 在生产 `repair run` 入口说明升级，不在第二轮才硬挡。
   - 首个独立链：`intake --new-repair-chain --project-id --repair-chain-id`。后续：前一 task writer 终止后 `history export`，原子保存 envelope+hash，下一 task `intake --history` + 重复 `--origin-task-dir`。parentRunId 是不变的 chain ID。来源目录只来自官方 export，且必须落在本 parent 已冻结 task 根内。
   - 新建和恢复共用同一冻结 history 加载校验。cycle 持久化 `historyExportPath`/`historyExportHash`/previous identity；恢复只验证复用，不重新 export、不覆盖链。缺文件或 hash 不符明确失败。
   - `squadctl init` 成功后立即按官方 `status.task_id` 落盘 identity。已 init 的重试读取官方 status 复用真实 task_id，并核验已有冻结身份/路径；官方状态坏则拒绝，不再 `makeSquadTaskId`。不在 init 前把文件塞进空 taskDir。
   - 官方 `resume` 只有 exit 0 且回执含 `resumed=true` + `epoch` + `head_sha` + `diff_hash` 才分配新 execution、更新状态、启动 writer。非零/空/坏回执直接拒绝，原 identity 不变，spawn 次数 0。父 Run 把该拒绝落成 `needs_attention`/`lastError`，不留下 running stub。已启动过的 cycle 若 resume 返回 stopped，不得再 prepare 绕过拒绝。
   - 官方内部 `logical_rounds` 与 CK `outerUsed` 分列；不把 native 内部轮次写入 `state.historyCount`。父外循环 max 10 由 cycles/CAS 核对。
   - integrate 回执必须核对 remote / remote_ref / profile_hash（Python canonical JSON SHA-256）。`check-remote` 即使进程 exit 0，只要 `cas_ok` 或 `ff_possible` 为 false 也拒绝。

8. **等待与 UI**
   - `waitForCandidate` 异步心跳，不写 `candidate.fix`。
   - 面板区分加载 / probe reason / 可执行入口。

## 配置

```bash
export COUNCILKIT_SQUADCTL=/path/to/hengzhuo-engineering-squad/scripts/squadctl
export COUNCILKIT_SQUAD_SKILL=/path/to/hengzhuo-engineering-squad
export COUNCILKIT_GROKB=/path/to/grokb
# 或写入 $COUNCILKIT_HOME/squad-bridge.json
pnpm exec councilkit repair probe --json
```

## 验证命令

```bash
pnpm exec vitest run \
  tests/unit/squad-journal-map.test.ts \
  tests/unit/squad-pr-profile.test.ts \
  tests/unit/squad-bridge-discovery.test.ts \
  tests/unit/repair-run-panel.test.ts \
  tests/host/repair-mutation.test.ts \
  cli/tests/squad-bridge.test.ts \
  cli/tests/repair-workspace.test.ts \
  cli/tests/squadctl-real-smoke.test.ts \
  cli/tests/squadctl-bridge.adapter.test.ts \
  cli/tests/squad-bridge-seams.test.ts \
  cli/tests/repair-command.test.ts \
  cli/tests/repair-profile.test.ts \
  cli/tests/local-repo.test.ts \
  cli/tests/squadctl-history.test.ts
pnpm typecheck
pnpm exec biome check <modified files>
pnpm build
```

`cli/tests/squad-bridge-seams.test.ts` 把独立验收的 workspace / session / stop-canary 探针收成有断言回归（Node 假 Orchestrator，finally 杀组）。真实 squadctl smoke/adapter 在没有个人 skill 的 CI 上 `describe.skipIf`；本机存在 `scripts/squadctl` 时默认执行。`COUNCILKIT_SQUAD_SMOKE=1` 时缺桥直接失败。真实测试显式 `COUNCILKIT_SQUADCTL`/`COUNCILKIT_SQUAD_SKILL` 指向冻结 skill 树 `/tmp/councilkit-squad-bridge-20260921/skill-history-worktree/hengzhuo-engineering-squad`（`749b44c`，`squadctl 2.1.1`）；不改 main 或已安装 symlink。不推实际 AntCode PR。

本机 2026-09-21 已显式跑过并通过：`cli/tests/squadctl-real-smoke.test.ts`、`cli/tests/squadctl-bridge.adapter.test.ts`、`cli/tests/squad-bridge-seams.test.ts`、`cli/tests/squadctl-history.test.ts`、`cli/tests/repair-command.test.ts`（含 cycle-2 冻结 history 恢复、官方 resume 拒绝落 `needs_attention`）。真实 A→B 恢复：init-ok/intake-fail 后 identity 与官方 `task_id` 一致；官方 resume 因 history origin drift exit 5 时 CK 拒绝且 spawn=0。不是靠 skip 交付。完整真实 Grok 角色与 integrate 已在独立临时 bare 通过，见下方最终验收。

## 最终验收与部署

- 实现及回归代码由真实 Grok Build（`grok-4.6`）编写，编排者负责独立复核、集成、发布及验收。
- CouncilKit 执行冻结版本：`fff161d8ac9c37f2975967db1c1d5ad3a00f0ceb`；随后合入并发主分支的报告页改动，部署代码为 `57d3a6f52af7996238ab8a510534c50360514198`。两者之间 `cli/`、`shared/`、`runtime-host/` 无差异。
- Squad 依赖冻结、合并和推送版本：`749b44c784b710bd43569cc4702f47230010c5cb`，实际安装探针返回 `squadctl 2.1.1` 与 `squad-history-bridge.v1`。
- 功能回归：28 文件 / 383 用例全部通过，无跳过；四套 TypeScript 项目检查通过。发布补丁集成后另跑 6 文件 / 72 用例；并发页面改动合入后另跑 4 文件 / 56 用例与前端类型检查，均通过。各批有重叠，不相加声称独立用例总数。
- 生产 Node 22.17.0 下完成前端、Host、CLI 构建。通过原 `com.councilkit.host` launchd 服务重启，17:32（Asia/Shanghai）读回 PID `41812` 正常监听 `127.0.0.1:43127`。

### 真实闭环

全新隔离案例 `execute-2vwiug`：原生 Grok Orchestrator 修复算术缺陷，Reviewer 与 Verifier 使用不同原生会话和独立 worktree。官方门禁均绑定候选 `a116104c7948a83412b565f3631dcbd8a548c8f4` 与同一 policy，aggregate approved，所有 binding/independence/required-gate gaps 为空。

生产 bridge 真实执行 check-remote 和 push-remote；回执的 candidate、expected-old、remote/ref、profile hash 均匹配，CAS/FF 通过、`forced=false`、`remote_verified=true`。临时 bare 修复分支与发布后 checkout 读回同一候选；原 source 分支和 bare main 保持初始值。发布后四项测试与仓库外固定四项 oracle 全部通过，原有断言保留。最终 `bridge-live-passed`、退出码 0、`stop=stopped`、`writers=[]`，原进程均退出。独立只读验收的 30 项证据核对全部通过。

此前两次真实失败（启动握手超时、发布 ref/SHA 不一致）保留为失败证据；最终通过来自新案例，没有手工改 journal、候选或门禁来补造 PASS。真实角色共用 Grok runtime/model，官方保留 `actual_identity_complete=false` / `degraded` 标注；本次证明会话与工作区独立，不声称异构模型独立。

### 原报告页面

重启前 repair profiles 接口为 `bridgeAvailable:false`。重启后，同一报告页 bootstrap 和 profiles 均 HTTP 200，返回 `bridgeAvailable:true`、`bridgeReason:null`。浏览器实测「当前修复」已展示修复授权表单、识别的源/目标分支及「保存授权并启动」，原不可用提示消失，Host 在线。本次验收未点击真实业务报告的启动按钮。

详细本地证据位于 `/tmp/councilkit-squad-bridge-20260921/`：`accept-live-fff161d-independent.md`、`accept-live-fff161d-evidence.json`、`host-after-deploy.json`、`production-bridge-probe.json`。临时案例含私有运行认证副本，不应整体上传；上述报告与回执均不输出认证内容。12 个无关本地文件的部署前后 hash 均一致。

### 验证边界

- 本次真实闭环覆盖一次隔离仓库修复、独立门禁和真实 Git 发布；外部 PR 平台与 CouncilKit 后续复审未通过这个临时案例实跑，父循环/恢复/历史链由专项功能回归覆盖。
- Squad 全量 Python 测试的两个 runtime-profile 旧预期失败已在修改前基线复现；未擅自修改无关默认模型配置。相关新历史桥专项测试通过。
- 一次额外审计被平台自动安全审核拒绝，理由为可能涉及网络安全风险；该额外审计未完成、未绕过，也不计入本次通过证据。

## 边界

- 已安装 skill 仍无 `squadctl orchestrate`；CouncilKit 用独立 grok + 现有控制面补通。
- 跨 outer-cycle 需要 squadctl `squad-history-bridge.v1`。未升级时生产入口拒绝并说明升级；已升级时用官方 export/intake 传递祖先，不再在第二轮无能力硬挡。
- Host 不读 `.squad/`、不 spawn squadctl。
- 未对用户真实 PR 做 integrate push。
- 本记录不表示用户真实业务 PR 的缺陷已经修复或准出。
