# 冻结测试后的修正记录

原始测试先行提交：`cbbf417`。原始内容 hash 保留在 `2026-09-23-review-explainer-test-freeze.json`，不覆盖历史。以下修改不删除、跳过或放宽业务断言。

## 1. 真实模型 smoke 的 UI 服务入口

`tests/host/review-explainer/http-helpers.ts` 增加可选 `uiDistDir`，未传时行为完全不变。目的是让真实默认解释 API、真实模型执行、缓存与构建后的页面在同一隔离 Host 验证。原来空白 HTML 的默认 HTTP helper 无法完成 A12 的页面消费证据。临时占位 index 仍只写临时目录，不覆盖真实 dist。

## 2. 修复链测试对既有 API 的调用错误

`cli/tests/review-explainer-repair-export.test.ts` 的三个问题由 CLI 实现者在 typecheck 中报告，主协调者核对既有实现后修正：

- `response.json()` 是 unknown，补响应 envelope 类型，再保留原 `data.toEqual(pkg)` 精确断言。
- `appendLanding` 的 `LandingRecord` 已要求 `runId`，补入与上方 handoff 相同的合成修复 Run ID，不改变生产接口。
- `loadAgainstContext().findings` 是 `FindingsFile`，数组在 `.findings.findings`；修正访问路径，保留 repairClaim 和 `isFindingVerifiedClosed=false` 断言。

这些是测试编译/调用错误，不应通过更改稳定生产 API 迎合测试。A06 的选择集合、原断言、候选身份、claim 不等于 verified_closed 要求不变。

同类 Node 22 类型修正也用于 `tests/host/review-explainer/routes.test.ts` 的旧报告用例：为 `response.json()` 补已有响应 envelope 类型，仍精确检查 headSha、diffHash、原 finding 和不可变历史源码。

## 3. 键盘操作等待保存收束

首轮 E2E 的 A03 在上一条决定的 POST 返回后，Host 权威状态 GET 尚未收束时对 disabled 按钮调用 focus。错误日志记录了按钮从 disabled 转成 enabled，但焦点请求已丢失。测试在 focus 前增加 `toBeEnabled`，随后仍验证焦点和 Enter 实际触发持久写入；不取消键盘断言，也不要求实现允许保存过程中的并发误操作。

A04 刷新后理解视图退出属于实现问题，由前端修复视图延续，测试未放宽。

## 4. 等待数据就绪与统一刷新行为

- `openExplainer` 原来只等加载壳可见，A02 在真实 diff 尚未返回时捕获 hunk 数为 0。增加等待冻结 SHA 身份出现，再记录 hunk 数；仍要求展开上下文前后 hunk 数严格不变。
- A07 缓存用例刷新后原先再次点击入口，与 A04 要求保留理解视图冲突。改为确认刷新后 reader 已保留，再选择同一意见；仍检查真实缓存内容、模型调用数不增加和原评审一致。

## 5. 无修复选择不生成空任务包

既有 `shared/runtime/repair-package.ts` 明确要求 findings 至少一项。A06 E2E 撤回唯一修复项后原先期待一个 findings=[] 的成功修复包，与这个稳定契约冲突。修正为导出按钮禁用，直接 API 返回明确“先选择修复项”的 400 且没有包数据；保留撤回后原评审点不得被导出的要求。没有降低已有非空选择包的完整相等、原反例或验收依据断言。

关闭的放大对话框仍渲染第二份 Canvas 导致定位歧义属于实现问题，由前端按需挂载修复，未通过测试的 `.first()` 等方式掩盖。

## 6. 补充已确认别名的断言身份反例

A05 追加 9 个用例，覆盖生产账本实际保存的 `` `root-id` — 原断言 src/file:line `` 形状：仅已确认首部别名变化应继承决定；正文内编号、未知首部、断言版本或新增失败机制不得被一起归一化。追加用例的实际 RED 为 18 例中 3 例失败（原 9 例保留）；随后才修正 matcher，首部元数据之外完整比较正文。原测试、冻结 hash 和判定标准不变。日志与新增测试/实现内容 hash 保存在任务工件目录的 `alias-prefix-*-receipt.json`。

## 7. 固定候选独立验收发现的两个遗漏

独立验收对第一候选 `fa5b70d` 复现两项既定合同违例，保留第一候选未通过结论，没有增加产品范围。

- A05：真实 report 提取的无首部 ID 原断言，在后续同 ID 追加新失败机制时仍被包含匹配豁免。追加实际提取→PR 决定持久化→投影链与严格源码引用边界用例；exact RED 为 25 例中 5 例业务失败。随后移除任意正文包含匹配，仅保留同断言及明确格式的末尾一条源码引用兼容。
- A02：重命名文件的旧路径 resolved 意见未归入新文件 diff，整条意见消失。新增生产 DiffDocument 的 React SSR 用例，覆盖 split/unified 的意见呈现和旧侧源码 DOM 身份；4 例先全部 RED。随后按旧/新侧映射文件归属，保留真实旧路径供定位。

新增用例不修改或放宽原冻结断言；先前 GREEN 和独立反例日志均保留。最终候选需覆盖新增用例及原完整测试集。

## 8. CLI 集成反例放入对应运行环境

第二候选全量 typecheck 发现：新增 A05 实际 CLI 提取用例位于 `tests/unit`，会让浏览器 ES2020 配置传递编译 Node 22 CLI，触发既有 `replaceAll` / `Error.cause` 的 lib 错误。将这一例的原始测试体逐字迁至 `cli/tests/review-explainer-assertion-identity.test.ts`，使用项目已有 CLI ES2022 配置；保留所有提取、持久化与未豁免断言，不修改生产代码、不扩大浏览器 target、不排除测试。最终命令显式包含此文件。构建失败时 E2E 未启动，保留失败退出码，不计通过。
