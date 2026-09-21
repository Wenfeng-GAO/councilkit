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
   - publish 只把 `source.sha` 换成 journal 候选 SHA，不发明 grant。

4. **Orchestrator**
   - 独立 grok `streaming-messages-json`，解析 `session_id`，绑定 model/executable/skill/workspace。
   - resume 必须同一 native session，禁止 silent fresh。crash 且 pid 已死才恢复。
   - prompt 含 skill/squadctl/包/授权/停点；禁止 Orchestrator 自行 push。

5. **stop / 身份**
   - 冻结 orchestrator `pid/pgid/lstart`。TERM 整组 → 有界等待 → 对仍活成员 KILL → 确认组空后才 `pause --expected-epoch --worktree` 并清 identity。
   - 父 cycle→taskId/taskDir 在 prepare/spawn 前落盘；公开 stop/resume 扫 `currentSquadTaskId` 与 cycles。旧 writer 仍活不能开第二个。
   - 首次与 resume 共用异步 supervisor：必须观察到 `system/init` session_id。新会话用 `--session-id` 并核对 init；resume 用 `--resume` 且必须等于冻结 session。mismatch / 无 session / exit 17 取消刚启动的 writer 并失败。不把 `GROK_SESSION_ID` 当实际身份。
   - 同一 parent 只 mint 一次 grant；恢复核验并复用原 id/hash/冻结 profile。缺失损坏不重签。

6. **工作区**
   - `git clone --local --no-hardlinks` 后把 origin 设回源仓库的可信 fetch/push URL，并与 profile repo 核对。已有隔离目录只核验，不 `checkout -B` 原始 SHA。

7. **history / 回执**
   - 首个独立链：`intake --new-repair-chain --project-id --repair-chain-id`。
   - 后续外循环：在启动第二个可写子任务前 `HISTORY_INVALID`。已安装 squadctl 2.1.0 的 completeness 只映射当前 task_dir，不能把 CouncilKit 合成 JSON 伪装成官方已校验祖先历史。外循环预算仍是 10，内部门禁不跳过。
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
  cli/tests/repair-profile.test.ts
pnpm typecheck
pnpm exec biome check <modified files>
pnpm build
```

`cli/tests/squad-bridge-seams.test.ts` 把独立验收的 workspace / session / stop-canary 探针收成有断言回归（Node 假 Orchestrator，finally 杀组）。真实 squadctl smoke/adapter 在没有个人 skill 的 CI 上 `describe.skipIf`；本机存在 `scripts/squadctl` 时默认执行。`COUNCILKIT_SQUAD_SMOKE=1` 时缺桥直接失败。不推实际 AntCode PR。

本机 2026-09-21 已显式跑过并通过：`cli/tests/squadctl-real-smoke.test.ts`（真实 squadctl 2.1.0 init/intake `--new-repair-chain`/Python profile hash）、`cli/tests/squadctl-bridge.adapter.test.ts`、`cli/tests/squad-bridge-seams.test.ts`。不是靠 skip 交付。

## 边界

- 已安装 skill 仍无 `squadctl orchestrate`；CouncilKit 用独立 grok + 现有控制面补通。
- 已安装 squadctl 2.1.0 不能 verified 跨任务 ancestor journal 映射，故第二个可写子任务 fail-closed。
- Host 不读 `.squad/`、不 spawn squadctl。
- 未对用户真实 PR 做 integrate push。
