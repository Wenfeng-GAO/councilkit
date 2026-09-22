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

`repair roles set` 只改 `squad-bridge.json`。它不删 `repair.json`，不改 `sourceFixUsed`，也不把 `remainingBudget` 清零。已有 Squad 任务的 `councilkit-bridge.json` 仍记下原来的 `model` 和 `nativeSession`。

先记下预算：

```bash
pnpm exec councilkit repair status --run <ck-repair-id> --json
```

记下输出里的 `remainingBudget`。

停掉当前 writer，再改席位，然后核对预算没变：

```bash
pnpm exec councilkit repair stop --run <ck-repair-id>
pnpm exec councilkit repair roles set --reviewer cursor:composer-2.5
pnpm exec councilkit repair status --run <ck-repair-id> --json
```

第二次 status 的 `remainingBudget` 必须和改席位之前相同。

恢复同一条 repair run 时，当前 cycle 如果已经有 native session，会继续那个旧 Squad 任务，启动参数仍是冻结的旧模型，不会读取新的 reviewer 配置：

```bash
pnpm exec councilkit repair resume --run <ck-repair-id>
```

新的席位配置要等这条 run 把当前 cycle 做完、并且 `sourceFix` 预算还允许下一轮时，由同一次 `repair resume --run <ck-repair-id>` 打开下一个 outer cycle。那一轮的 squad init 使用 `--contract`，并且 `newRepairChain` 为 false，会带上上一轮导出的 history。不要省略 `--run-id` 去另起一条 repair run 来换模型。不要删除 `repair.json` 或 chain 里的已用预算。

同一次 native session 里原地换模型不受支持。`repair resume` 不会把旧 Grok 或旧 Cursor session 交给另一个模型。
