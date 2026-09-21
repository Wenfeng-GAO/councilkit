# Squad 桥修复验收（2026-09-21）

## 根因

报告页 `GET /api/v1/cli-runs/repair/profiles` 返回 `bridgeAvailable:false`，因为 Host/CLI probe 只扫 PATH。真实 `squadctl` 在已安装 skill 的 `scripts/squadctl`。即便找到文件，旧 `SquadctlBridge` 也只是 mkdir / 假回执 / 同步三次 status，无法跑真实分钟级修复。

## 已实现

1. **发现**（`shared/runtime/squad-bridge-discovery.ts` + CLI `squadctl-verify.ts`）
   - PATH、`COUNCILKIT_SQUADCTL` / `COUNCILKIT_SQUAD_SKILL` / `COUNCILKIT_GROKB`、`COUNCILKIT_HOME/squad-bridge.json`、具名 skill 目录。
   - 显式路径无效则失败，不扫描其它 skill。
   - CLI：`squadctl --help/--version` 与 `integrate`/`pause` 真实 argv。
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

5. **stop**
   - 杀 process group / ChildProcess，确认结束后才 `pause --expected-epoch --worktree`。
   - CLI `repair stop` 调生产 bridge，默认 `isPidAlive` 为真实 `kill(pid,0)`。

6. **工作区**
   - `git clone --local --no-hardlinks` 到 `COUNCILKIT_HOME/repair-workspaces/<runId>`，checkout 冻结源分支/SHA，校验 HEAD 与 origin。不改源仓库内容。

7. **等待与 UI**
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
  cli/tests/repair-command.test.ts
pnpm typecheck
pnpm exec biome check <modified files>
pnpm build
```

真实 smoke 使用安装的 `squadctl 2.1.0` 做 init/intake/status 与 pr-profile `load_pr_profile`。Adapter 测试 fake Grok，不推实际 AntCode PR。

## 边界

- 已安装 skill 仍无 `squadctl orchestrate`；CouncilKit 用独立 grok + 现有控制面补通。
- Host 不读 `.squad/`、不 spawn squadctl。
- 未对用户真实 PR 做 integrate push。
