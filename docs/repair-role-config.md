# Squad 修复席位配置

默认所有席位是 Cursor，模型 `grok-4.7[context=500k,reasoning_effort=xhigh,fast=false]`（回执名 `Grok 4.7 500K Extra High`）。这是默认配置，不是唯一允许的型号。配置在 `COUNCILKIT_HOME/squad-bridge.json`，用下面的命令查看或修改。不改全局 skill，也不改 pr-jury。

```bash
pnpm exec councilkit repair roles show
pnpm exec councilkit repair roles set --reviewer codex:gpt-5.6-sol
pnpm exec councilkit repair roles set --reviewer cursor:composer-2.5
pnpm exec councilkit repair roles set --verifier cursor:grok-4.7-xhigh
pnpm exec councilkit repair roles reset
```

`set --orchestrator cursor:<model>` 会把 `planner_a` 和 `coder` 写成同一个 runtime/model。这三席续接同一次 native session。把 Builder 配成另一个模型会被拒绝：那需要 fresh session，当前控制器不做独立 Builder，避免把另一次会话说成连续 Builder。

`planner_b`、`reviewer`、`verifier` 可以单独换成 Cursor 的其他明确模型，或 Codex 的明确模型。`auto` / `default` / `configured` 会被拒绝，也不会自动改用别的付费模型。

## 单独替换 Reviewer

```bash
pnpm exec councilkit repair roles set --reviewer cursor:composer-2.5
pnpm exec councilkit repair roles show
```

下一次新建的 Squad 任务会把该绑定写进 `squadctl init --contract`。Reviewer 仍是独立 adapter run：另一个 native session、只读 sandbox、单独的 review worktree。

换回默认：

```bash
pnpm exec councilkit repair roles reset
```

整条修复改回 Grok Orchestrator（不加载这份 Cursor 合同）时，在 `squad-bridge.json` 写 `"orchestratorRuntime": "grokb"`。没有 `roles` 覆盖时，init 不再传自定义 contract。

## 额度耗尽后换席

`repair roles set` 只改 `COUNCILKIT_HOME/squad-bridge.json`。它不删 `repair.json`，也不改持久 chain 里的 `sourceFixUsed`。

旧 repair run 的 `repair resume` 仍续接该 run 已冻结的 Squad session 和旧模型。额度已经耗尽的那个 cycle 不必先做完才能换席。换席用同 PR、同目标上的新 parent run。`loadOrCreateChain` 会按 repo 和 PR 找到已有 chain，把新的 `parentRunId` 加进去，并保留原来的 `sourceFixUsed`。这不是一条新 chain，预算也不会因此从 0 开始。

```bash
pnpm exec councilkit repair status --run <old-ck-repair-id> --json
pnpm exec councilkit repair stop --run <old-ck-repair-id>
pnpm exec councilkit repair roles set --reviewer cursor:composer-2.5
pnpm exec councilkit repair run --from <ck-review-id> --profile <name> --run-id <new-ck-repair-id>
pnpm exec councilkit repair status --run <new-ck-repair-id> --json
```

新 run 的 `remainingBudget` 来自同一条 chain，应与 stop 之前已经用掉的 source-fix 次数一致，而不是一份全新的零用量预算。旧 run 不要再 `repair resume`。

旧 Squad 任务目录和它的 builder worktree 留在原地，这条命令不会覆盖它们。新 Squad 任务是新的 task 目录，候选从 repair package 里的可信 SHA 重新取出，不把旧 worktree 里未提交的改动带过去。那些未提交改动只留在旧 worktree 里；当前命令没有把它们自动应用到新候选。

新 parent run 的第一轮 squad init 使用 `--new-repair-chain`。CouncilKit 的 source-fix 预算仍在上面的持久 chain 里。Squad 任务内部的 repair-history 计数从这次新任务开始，不会自动导入旧 Squad 任务的 history。旧任务的 history 文件还在旧 task 目录里。
