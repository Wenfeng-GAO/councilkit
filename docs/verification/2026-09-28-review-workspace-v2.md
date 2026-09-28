# Review 工作台 v2 验收

日期：2026-09-28。实现范围见 [计划](../plans/2026-09-28-review-workspace-v2.md)。

## 结果

- 前端、Host、集成与 CLI 四个 TypeScript target 均通过 `pnpm typecheck`。
- `pnpm build` 通过（Playwright webServer 启动前构建前端、Host 和 CLI）。现有大 chunk 提示保留。
- 相关 unit / Host / CLI 16 个测试文件共 102 项覆盖通过；其中一个新增单测初始缺少合法 `code_trace.locations`，修正测试数据后定向 4/4 通过。
- 完整 Review Explainer E2E：31/31 通过，单 worker、独立端口 43839、临时数据目录。主题截图另经 1/1 定向复测，确保截图在数据加载完成后捕获。
- 本次 25 个代码文件 Biome 通过，`git diff --check` 通过。
- 全仓 `pnpm lint` 仍报告 126 项问题，涉及 65 个未修改文件；JSON 诊断路径与本次文件交集为空。本任务未批量修改这些既有问题。

## 实际验证

- 逐文件遍历全部冻结 hunks，保留 split/unified、新增、删除、重命名、二进制与无意见文件。
- 1440 / 678 / 390px 下返回代码后目标行可见；窄屏点击关联位置会关闭抽屉，split 新侧定位包含横向滚动。
- 决定与备注经 Host CAS 持久化；刷新、全新浏览器 context、Host PID 变化后仍保留。真实文件写入失败不显示为已保存。
- 显式 alias 的决定和备注从同一次身份匹配投影；修改 alias 决定不擦除 canonical 备注，不改变断言身份。
- 旧 `closed` 和针对其他 SHA 的关闭核验仍在默认待处理列表；仅当前冻结 SHA 的有效核验算已验证关闭。
- last-commit 来自冻结 head 的 first parent，支持真实 merge、空提交、缺对象与范围外问题；旧侧锚点回全量，不重解释为 parent 的行号。
- 最后提交比较在只引用原 object store 的临时 Git 元数据中执行，隔离 info/global/system attributes、replace refs 和当前工作区变化；70KB 提交消息也能读取 parent。
- 比较、跨问题上下文、同问题后续定位均有迟到响应回归。Run 通过 keyed 子树隔离，并有卸载/请求版本检查。
- 模型解释、缓存、失败/超时/非法输出重试、图解、冻结上下文、修复包原始断言/反例/验收依据均保留。
- session / CSRF / Origin / traversal 独立拒绝测试通过。没有使用用户 Chrome 做 computer use，也没有重启或占用原 43127 实例。

## 独立审查闭环

后端安全/契约、前端状态/竞态、测试/工程规范三组只读审查，发现的 2 个 P1 与 4 个 P2 已修复并补充验证：

1. 本地 attributes 污染冻结 diff。
2. 长提交消息被误认为提交缺失。
3. alias 决定擦除 canonical 备注。
4. 历史 closed 被默认过滤隐藏。
5. 同问题旧上下文响应覆盖新定位。
6. 窄屏定位后抽屉仍遮挡代码。

截图、完整 E2E JSON、主题复测 JSON、typecheck 输出和全仓 lint JSON 存于本机 `~/orca/artifacts/councilkit-review-product-v2/`。截图使用合成 Git fixture，不是线上真实 PR 的核验结论。

## 运行范围

本次完成本地实现与验收，不替换现有运行实例、不发布。新增比较接口与客户端要求同 checkout Host；旧 Git 不支持冻结 attributes 选项时返回明确不可用状态，全量保存的 diff 仍可查看。
