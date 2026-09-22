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

`repair roles set` 不改正在跑的 session，不改修复链，也不把已用预算清零。已冻结的 native session 不能用另一个模型 `--resume`。

1. `pnpm exec councilkit repair stop --run <ck-repair-id>` 停掉当前 writer。
2. `pnpm exec councilkit repair roles set --reviewer <runtime>:<model>`。
3. 让同链的下一次任务重新 init。它会导入 history，已用预算保留。
4. 不要新开 repair chain。新链会把预算从 0 算起。

同一次执行里原地换模型不受支持。
