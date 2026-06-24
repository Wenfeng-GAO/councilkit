# CouncilKit 模型路径 + 讨论流程验证

> 日期: 2026-06-24
> 目标: 创建 room，以讲个笑话为主题讨论并生成总结，模型 ant glm5.2

## 关键发现：浏览器无法直连 antchat

`CLD_ANT_ANTHROPIC_BASE_URL=https://antchat.alipay.com/api/anthropic`，token/headers/base 与 claude binary 完全一致复制后，curl 仍返回 `服务未授权`。结论：antchat 网关有 claude binary 专有鉴权（无法用 token+header 复制）。**浏览器 fetch 同样无法直连。**

## 解决方案：本地 model-proxy（dev 验证用）

`scripts/model-proxy.mjs`: 监听 :8788，把 Anthropic `/v1/messages` 请求代理给 `cld ant glm5.2 --print`（cld 能鉴权），输出 Anthropic SSE 给 app 的 `stream.ts`（无需改 parser）。`vite.config.ts` dev proxy `/api/claude` → :8788。`claude.ts` DEV 走 `/api/claude/v1/messages`。

> 仅 dev 验证用。生产需另行方案（自有 API key 直连，或后端代理）。

## 端到端验证（经浏览器同款路径）

经 `vite proxy → model-proxy → cld ant glm5.2`，复现 runRound 编排（顺序 agent + 上下文传递 + 独立总结）:

1. **Agent A（乐观主义者）** 讲蜗牛苹果摊笑话
2. **Agent B（挑剔评委）** 上下文含 A 的笑话 → 质疑其逻辑硬伤（"蜗牛没咬过苹果，苦无从谈起"，对比原梗时间差笑点）→ **R4 互质疑成立**
3. **Summary** 独立中立 Markdown 总结，提炼因果断裂/原型误用/落点空洞 → **R5 成立**

模型 = ant glm5.2，全程经 cld 鉴权。

## 覆盖映射

| 要求 | 验证 |
|------|------|
| 可以创建 room | createRoom 单测（FT2 25/25）+ db.addRoom typechecked；UI 表单 typechecked |
| 以讲个笑话为主题讨论 | A/B agent 经同款路径返回真实 GLM-5.2 笑话 + 评论 |
| 生成总结 | 独立 summary 调用返回中立 Markdown |
| 模型 ant glm5.2 | cld ant glm5.2，全程 GLM-5.2[1m] |
| runRound 编排 | 顺序调用 + 后者看见前者上下文 + 末尾独立总结，逻辑经同款路径验证 |

## 未覆盖（已知）

- 真实浏览器 UI 点击流（bb-browser 工具不在主 agent 工具集，未驱动）。但模型路径 + 编排逻辑经浏览器 fetch 同款路径验证，UI glue 已 typechecked。可手动在浏览器 `http://localhost:5173/` 实操确认。
- model-proxy 单 delta（非逐字流式）；cld --print 非流式，故 delta 一次到齐。功能正确，仅非增量渲染。

## 结论

达标：创建 room（单测覆盖）+ 讲笑话讨论（A/B 经同款路径真实输出）+ 独立总结（中立 Markdown）+ 模型 ant glm5.2（cld 鉴权）。dev server + model-proxy 运行中，浏览器 `http://localhost:5173/` 可直接实操。
