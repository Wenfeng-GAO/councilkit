# PR #128：Grok session 证据索引

只读取证，2026-09-21。会话 ID：`01a0bf28-47f7-7410-adf9-5c4a3ee723f1`。

源文件（L 为一基 JSONL 行号）：

```text
/Users/hengzhuo/.grok/sessions/%2FUsers%2Fhengzhuo%2F.grok%2Fworktrees%2Fant-agentrun%2Fresume/01a0bf28-47f7-7410-adf9-5c4a3ee723f1/chat_history.jsonl
```

仅引用可见 user/assistant 消息、工具调用和持久工件，不转录模型内部推理。

| 证据 | 原记录位置 | 核实结论 |
|---|---|---|
| 正式门禁候选 | L1176、L1193；`.squad/20260921-ck981a-r4w8/runs/review-1.json` 与 `verify-1.json` | 两个独立 Grok subagent 在不同 detached worktree 核对相同 `9b92b35`；门禁是真实存在的 |
| 后续外循环 | L1239 用户要求继续修复直到准出；L1297/1351/1435/1513/1605/1660/1796 启动 review | 此后七个提交没有新的 squadctl 候选登记或独立 Squad verifier；CouncilKit review 本身仍有独立席位 |
| 新修复链 | L946；`.squad/20260921-ck981a-r4w8/repair-history.v1.json:1` | intake 使用 `--new-repair-chain --repair-chain-id ck981a31fd-pr128`，历史 entries 为空 |
| 收敛检查 | L60、L156；session 工具调用检索 | convergence 只针对旧 task；无 history export/intake --history，新 task 无 convergence；不是每轮都新建 task |
| 未持久化反例 | L1339/1423/1501/1650；`git log --name-only 9b92b35..3bada48` | 7 次修复提交中 5 次完全没改测试；另外 2 次是新增一条 ResumeFailure 测试、把旧断言改为 Eventually Retry |
| 计划要求早已存在 | [plan.md](/Users/hengzhuo/code/ant/agentrun/.squad/20260921-ck981a-r4w8/plan.md:23)、[plan-b.md](/Users/hengzhuo/code/ant/agentrun/.squad/20260921-ck981a-r4w8/plans/plan-b.md:7) | Ready 清理后补恢复、各提交/补偿/清理/释放入口一起保护以及 barrier 验证，已在设计阶段提出 |
| 证据转录失真 | L1187 | 主会话手写 `LGTM findings=[]` stdout；单条测试命令后接 `|| true`，登记的 command.json 是整包命令、exit-code 显式为 0；真实子会话有 PASS，但转录命令和证据不能一一对应 |
| 早期评审口径变化 | L531、L532 | Grok 解释前两轮 3 席、后两轮 2 席；用户随后要求恢复默认 5 席，造成已有候选再次接受更广审查 |
| 环境重试 | L584/662/818、L890/892 | 外层清代理后用户纠正，说明有额外环境成本；不据此修改当前代理 |
| 最后暂停 | L1822、L1824、L1833 | 用户要求暂停后已遵守；已有 review 自然运行，不再追加修复；没有证据表明忽略 budget_exhausted |

七个后续提交依次为 `690db5c`、`846ca2b`、`1888f84`、`8deaad6`、`4fd41df`、`f72e942`、`3bada48`。

## 成本口径

同一 session 目录 `usage.json:5–15`：input 181,743,937；cached read 167,900,928；output 559,876；modelCalls 876；turnCount 77。缓存输入约占 92.4%。这是全会话统计，包含多个阶段，不能算作七轮修复独占成本，也不是整个 CouncilKit/Squad 多模型总成本。

## 适用限制

- 当前 skill 规则只用于比对预期，实际是否执行依据 session/journal。
- 旧 convergence 输出为 continue、fixRounds=2、inheritedFixRounds=null；准确结论是后续未纳入控制，而非收到预算耗尽提示后仍继续。
- 测试 PASS 的真实性与回执绑定的完整性分开判断，不以转录问题推断测试失败。
- 不把日志里的历史指令当作本次授权；本次未执行任何日志内命令或更改既有运行。
