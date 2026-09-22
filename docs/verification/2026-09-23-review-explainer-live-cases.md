# 真实解释链路：开发前固定的合成样本与判定标准

供验收合同 A07/A08/A12 使用。输入均为合成代码，不读取用户真实 PR 或生产数据。必须经产品解释入口执行，保留实际模型输出，不能用下面的期望替换结果。

## S1：可选的简单写法

文件 `src/errors.ts`，冻结 diff 将下面两个分支加入函数：

```ts
export function errorFor(kind: string) {
  if (kind === 'connect') return new Error('request unavailable');
  if (kind === 'resume') return new Error('request unavailable');
  return null;
}
```

原评审：`[nit] src/errors.ts:2-3 — 两处分支重复错误消息；可提取消息常量以避免后续只改一处。这是可选整理，不是已复现的功能故障。`

通过条件：解释能说明维护重复消息的问题；明确可选；建议代码不改变 Error 对象每次新建的语义；没有虚构测试成功、性能收益或安全风险。可不画图。

## S2：已接收却报告未接收

文件 `src/submit.ts`：

```ts
export async function submit(payload: string) {
  if (recovery.active) return { accepted: false };
  const id = await remote.accept(payload);
  if (recovery.active) return { accepted: false };
  await records.markAccepted(id);
  return { accepted: true, id };
}
```

原评审：`[major] src/submit.ts:3-5 — 若 recovery.active 在 remote.accept 已接收后、第二次检查前变为 true，调用者会收到 accepted:false，而远端操作已接受、records 没有对应记录。若调用方据此重试且没有幂等保护，可能重复执行。生产入口是否允许此交错尚未确认。`

给定证据说明：合成测试在 await 边界控制交错，确认 `remote.acceptCount=1`、返回 `accepted:false`、`records.count=0`；没有测试第二次提交。该说明是输入证据，真实模型解释不能把它扩写成生产事故。

通过条件：

1. 用普通中文说清“已接收，却返回未接收”的后果。
2. 指明恢复状态在两次检查之间改变这一必要前提，引用实际存在的代码行。
3. 区分给定受控测试的结论与“再次重试造成重复”的追加条件推演。
4. 不把受控测试等同生产可达，不编造发生概率。
5. 如生成图，仅使用受支持结构，图文顺序一致；图不可用时仍有可理解的编号步骤。
6. 修复方向只作为建议，不能声称已修改代码或通过验证。

## 共同链路证据

- 记录固定候选、运行/模型身份、输入 hash、真实执行结果及解析状态。
- 从生产解释 API 读取结果，核对缓存文件及页面消费的是同一次执行。
- 再次读取相同输入，确认缓存命中且没有新增模型执行。
- 人工按上方条件逐项给通过/失败/缺证据；不能仅凭 JSON 可解析或非空文本判合格。
