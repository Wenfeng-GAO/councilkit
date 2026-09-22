# 评审解读：开发前冻结的验收合同 v1

日期：2026-09-23。起始代码：`e0ec16d`。分支：`hengzhuo/review-explainer`。
需求来源：`docs/design/2026-09-22-review-explainer/design-notes.md` 与用户已迭代确认的同目录原型。

本轮是正式产品开发，交付真实报告页、Host/CLI 路径和持久数据。原型、预置三条解说或 page.route 返回的假业务响应不能代替功能完成。用户已授权开发及验收，并明确要求先创建 UT/E2E 测试集。

## 固定产品边界

- 全部 PR diff 为主体，不仅显示有评审的文件；同时展示准确的旧/新侧行号与冻结比较区间。
- 行内评审及关联代码，简单项展示建议代码，复杂项采用受控 Canvas 流程/时序模板和等价文字。
- 解读由真实模型按需生成并缓存，不为解释重跑整个 Council；保留原评审和证据边界，不执行模型产生的脚本。
- 只保留待决定、打算修复、不修复。不要场景问卷、理由必填表单或第二套“认可度”流程。
- 打算修复进入修复与验收范围；不修复在同一 PR 的后续普通/对照 review 中跳过同一评审点；可撤回。
- 修复意图不等于已修好，不修复不等于假阳性；同一文件的新问题不可被屏蔽。

## 验收矩阵

| ID | 必须达到的行为 | 自动化证据 |
|---|---|---|
| A01 | 冻结 diff 的全部文件/hunk/增删内容可读，包含无意见文件、新增、删除、改名；旧侧/新侧分别正确；二进制或缺失工件有明确状态，不能伪造代码 | UT：解析及字节/行数断言；HTTP：真实磁盘工件；E2E：普通文件、带意见文件、切换布局 |
| A02 | 注释只锚到对应冻结 SHA 的可信文件与行；删除行在旧侧，多位置可跳转；模糊/过期/缺失位置显示待定位而不是乱贴或丢失意见；上下文不计为新增 | UT：锚点冲突/越界/重命名/缺失；E2E：点击意见与上下文，断言真实代码文本与几何可见性 |
| A03 | 页面有理解入口，原文可回看；仅两个决策按钮、默认待决定，可在行内和解读区选择/切换/撤回；全程没有场景问卷或理由必填 | E2E：用户路径与互相同步，不测试按钮名称存在就算完成 |
| A04 | 选择保存在 Host 管理的真实存储，不依赖浏览器 localStorage；刷新、新标签页及真正 Host 进程重启后保持；写失败不显示保存成功；并发更新不丢失其他意见 | UT/HTTP：原子更新、错误与并发；E2E：同一临时 home 的 Host stop/start 后重新读回 |
| A05 | 不修复绑定规范 PR 身份和稳定评审点；普通新 review 与 --against 均取得跳过清单，不要求模型再次验证已跳过项；输出再提及同一受控身份时不重新制造阻塞；撤回恢复检查；其他 PR/新问题不受影响 | CLI/集成：真实 review 构造与账本落盘，fake 只位于模型/远端解析边界；断言席位及聚合输入、最终账本 |
| A06 | 只有打算修复的选择集合进入该入口导出的修复包，带原断言/反例/预期结果/源码身份作为验收依据；待决定不被悄悄入包或豁免；修复意图及 Builder claim 不得直接写 verified_closed | UT/HTTP/CLI：真实选择→导出→修复任务输入；E2E：清单及导出内容；兼容旧显式 CLI 工作流 |
| A07 | 按需解释真实调用一个已配置、可用的模型执行路径，携带原评审和冻结代码；多次查看复用缓存，同键并发不重复生成；来源/模型/版本改变不能误复用；无模型/超时/无效输出明确失败且能重试，不用原文冒充生成成功 | UT/HTTP：可注入 executor 的成功/失败/重复请求；E2E：页面经真实 Host 调用确定性模型边界；最终追加真实模型 smoke |
| A08 | 解释区分原断言、已有证据、条件推演；简单代码建议未验证时不称已修好；图只能使用受限结构和固定渲染器，不能执行模型 HTML/JS；无图/错误图时文字仍可读 | UT：schema、限制、引用、恶意文本；E2E：建议代码、Canvas 与文字回退、原文 |
| A09 | 1440、678、390 宽度下完整 diff 可读；代码行与行内意见定位不被 sticky header/解读抽屉遮挡；打开图后跳源码关闭遮挡；操作有键盘焦点和明确反馈 | E2E：可视区域的坐标断言、键盘路径、截图 |
| A10 | Host 路由沿用已有 session/CSRF/Origin 保护；只可读取允许的冻结工件/代码，路径穿越、任意文件、越界体积、损坏数据均有可诊断拒绝；测试控制接口不进入生产装配 | HTTP/UT：拒绝与安全边界；构建检查 |
| A11 | 改动通过 typecheck、相关 lint、完整生产 build、冻结的新 UT/HTTP/CLI/E2E 集，以及相关现有回归；失败分类有原始退出码与日志，不靠 retries 掩盖或降低断言 | 实际命令日志与结果 JSON；最终提交/差异身份 |
| A12 | 独立验收在固定候选上按 A01–A11 核对；真实模型解释至少覆盖一个普通写法项、一个复杂项（可一次有界调用）；没有运行实际 PR 修复、没有修改真实决策/Run | 独立会话回执、模型执行身份/来源/输出，最终验收表 |

### 关于身份和历史

“同一个评审点”不等于相同文件或相似标题。至少支持原稳定 ID、显式确认别名和冻结原断言的身份延续；不能利用模糊匹配把新的失败机制当成已豁免。无法确认的别名保持待决定，不虚构跨语义匹配保证。不修复记录可使用用户明确点击这一事实作审计理由，无需额外逼用户填理由。

### 关于测试数据

使用临时 COUNCILKIT_HOME、临时小型 Git 仓库、合成 PR URL 与可控制的模型输出。不得写真实 `~/.config/councilkit`、操作 PR #128 或调用真实修复/推送。解释质量 smoke 使用合成源码和评审样本，保存真实原始结果，不能把 fixture 回应标成 live。

### 测试集冻结前的证据补充

- A07/A12 的真实模型 smoke 必须走生产解释 API，并将同一执行的结果沿缓存文件和页面展示核对；单独在终端跑模型、另在页面显示预置文字不算通过。相同输入第二次读取无新增模型调用。
- A06 的合成链须延伸至候选回执与复审输入：UI 选择→真实任务包→受控候选回执→复审仍绑定该选择集合与原断言。未选项不能偷偷纳入该修复任务的验收，也不能因此被判整体 PR 通过；claim 不能代替验证。
- A05 的撤回至少包含已有子 Run 继承 accepted 后再撤回的情况，防止只更新最初 Run 而子 Run 继续跳过。

## 测试先行顺序

1. 创建 A01–A10 对应的 UT/HTTP/CLI/E2E 测试文件、fixture 和独立测试配置；先不实现生产功能。
2. 运行测试基线，保存实际失败原因。缺接口/行为的预期失败要与编译、端口、鉴权、依赖等基础设施失败分开；模块无法导入不能单独证明业务反例。
3. 冻结测试清单、内容 hash、执行命令和 RED 回执，再开始生产实现。实现过程中可以补测试，但不能删除、skip 或放宽既有用例来获得 GREEN；必要的合同更正须记说明和证据。
4. 按完整路径逐项实现，针对失败用例修正；不追加多轮全量 LLM PR 审查。
5. 固定候选，独立验收新测试和相关回归，再进行受控真实模型 smoke。最后填完成矩阵与具体限制。

## 测试运行与判定规则

- E2E 使用单 worker、retries=0、独立临时 Host，禁止复用日常 43127；端口冲突只报告，不 kill 其他进程。
- 参考既有 `tests/e2e/repair-observability/host-entry.mts` 的真实 server/routes/session/磁盘装配；不复制其仅计数 launcher 作为真实 CLI 链路证明。
- 业务 diff/decision/export/explanation API 不能被 page.route.fulfill 全量替代。允许控制模型执行器与远端 PR 解析边界，必须记录这些模拟边界。
- 真正重启验收必须结束自己启动的 Host 进程并以相同临时 home 启动新进程；page.reload 不算 Host restart。
- RED/GREEN 回执保存原始命令、退出码、时间与输出路径。最终验收对应固定提交；有脏改动时记录实际差异 hash，不能借用旧 SHA。
- 任一 A01–A12 缺关键证据则不得报告整体通过。可以如实报告部分通过，但不能把缺项标成成功或擅自移出范围。

## 开发开始前待补齐的执行字段

测试集、实际命令、RED 回执路径由测试先行阶段补齐；填入后记录本文 hash。公开接口与 fixtures 的具体选择可以依据现有代码确定，产品行为和本矩阵不变。

### 测试先行补齐（2026-09-23）

公开契约：`tests/review-explainer/contract.ts`。实现分工：`docs/plans/2026-09-23-review-explainer-implementation.md`。

测试文件：

- UT：`tests/unit/review-explainer/*.test.ts`（A01–A08、A10 生产装配）
- HTTP：`tests/host/review-explainer/routes.test.ts`（独立临时端口，不绑定 43127）
- CLI：`cli/tests/review-explainer-skip.test.ts`、`cli/tests/review-explainer-repair-export.test.ts`、`cli/tests/review-explainer-explain-spawn.test.ts`
- E2E：`tests/e2e/review-explainer/*.spec.ts` + `playwright.review-explainer.config.ts`（43839，workers=1，retries=0，reuse=false；真实 `createRuntimeServer`；Host 重启杀 worker 进程）

命令：

```bash
pnpm exec vitest run tests/unit/review-explainer tests/host/review-explainer \
  cli/tests/review-explainer-skip.test.ts \
  cli/tests/review-explainer-repair-export.test.ts \
  cli/tests/review-explainer-explain-spawn.test.ts
pnpm exec playwright test -c playwright.review-explainer.config.ts
```

RED 回执：`/Users/hengzhuo/.codex/artifacts/councilkit-review-explainer-20260923/red/red-receipt.json`。

## 最终验收（尚未执行）

候选：待填写。独立验收者：待填写。A01–A12：均待验证。
