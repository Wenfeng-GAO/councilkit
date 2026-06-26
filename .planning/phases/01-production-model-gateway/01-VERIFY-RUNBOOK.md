# Phase 1 — 自动化验收 Runbook（面向 Codex）

> **执行者：Codex（具备 computer-use / 浏览器自动化 / shell 能力）**
> **目标：** 对 CouncilKit Phase 1「Production Model Gateway」的 5 项人工验证项（D-13 + SC#1–SC#4）进行端到端自动化验收，并向编排者回传结构化结论。
> **不要修改任何源码。** 你只负责：启服务 → 驱动浏览器 → 断言可观察状态 → 回传报告。发现 bug 时**记录现象**，不修复。

---

## 0. 背景与已就绪状态

- Phase 1 已实现：用户在 `/settings` 配置模型网关（名称/类型/baseUrl/AES 加密 key/默认模型），浏览器直连模型端点，取代旧 dev proxy（`scripts/model-proxy.mjs` → `cld ant glm5.2`）。
- **已自动化通过**（你无需重测）：tsc 0 错、biome clean、vitest 104/104、`vite build` 成功、`src/` 与 `dist/` 均无 `/api/claude` 与 `VITE_*_API_KEY`、adapter 含 `anthropic-dangerous-direct-browser-access` header（`src/services/gateway-adapters.ts:77`）。
- **本轮待你验证的 5 项**：D-13（Anthropic CORS 直连）、SC#1（两类网关配置 + 浏览器直达）、SC#2（完整真实讨论 E2E）、SC#3（干净检出运行时侧）、SC#4（5 类错误呈现 + 致命扩散 + 全离线跳总结）。
- **最近修复（已提交 `d176458`）**：gateways 表索引补了 `createdAt`，修复了「保存网关后列表为空」的 bug。Dexie 会自动从 v2 升级到 v3；若见到 `gateways` 相关异常，清 IndexedDB 重来（见 §1.3）。

---

## 1. 环境准备

### 1.1 工作目录
```
/Users/hengzhuo/code/github/Wenfeng-GAO/councilkit/.claude/worktrees/enchanted-chasing-teapot
```
所有命令在此目录执行。

### 1.2 启动 dev server
```bash
./node_modules/.bin/vite
```
- ⚠ **不要用 `pnpm dev` / `npm run dev`**——pnpm 11 deps-check 冲突会阻塞。直接用 `node_modules/.bin/vite`。
- dev server 默认 `http://localhost:5173`。捕获实际端口（从 vite 启动输出读）。
- **不要启动 `scripts/model-proxy.mjs`**，也不要让 :8788 有任何进程（SC#3 要求无 proxy 进程）。

### 1.3 清理旧浏览器状态（推荐，首次执行前做一次）
- 打开 DevTools → Application → Storage → "Clear site data"，或
- Application → IndexedDB → 删除 `councilkit` 库。
- 目的：避免任何 v2 残留 / 旧 dev 数据干扰；本验收无需保留任何历史数据。
- 清完后**硬刷新**（Cmd+Shift+R）让 v3 schema upgrade 生效。

### 1.4 API key 获取方式
真实 key **不写进本文档**。从环境变量读取（用户已 export），类型时填入表单：
- `ANTHROPIC_API_KEY` ── 形如 `sk-ant-...`（D-13 必需）
- `OPENAI_API_KEY` ── 形如 `sk-...`（SC#1 第二网关用；若 OpenAI 浏览器直连 CORS 受限，改用 `DEEPSEEK_API_KEY`，见 §3 注）

开始前先 `echo` 确认两个变量非空（**不要打印完整 key 值到报告**，只回传前 8 位 + `…`）。

### 1.5 computer-use 能力约定
- 用浏览器快照（accessibility tree / DOM）定位元素，用 ref 或可见文案点击。
- 文案断言用**子串匹配**（中英文案可能含动态片段如网关名），断言**稳定子串**而非整句。
- 颜色/状态断言：优先用 DOM 可见文本（按钮文案、pill 文案）+ `role` 属性；颜色作为辅助。
- 网络断言：若你的 computer-use 能读 DevTools Network 或经 CDP 抓请求，按 §3/§4 的 Network 判据执行；若不能，**降级为 DOM 可观察代理信号**（各步骤已给出代理判据并标注「代理」）。

---

## 2. 全局通过判据（一票否决项）

| 项 | 判据 |
|----|------|
| **G1** | 全程 Console 无 CORS 报错（`Blocked by CORS` / `Access-Control` 字样视为失败） |
| **G2** | 全程 `:8788` 无进程（每步结束可抽检 `lsof -i:8788`，应空） |
| **G3** | 若任一步骤出现未预期的 JS 异常（Console 红色 error，非网络 4xx/5xx 业务错误）记为 fail 并抓 stack |
| **G4** | 业务错误（invalid_key 等）必须**呈现给用户**（DOM 可见），不得静默吞掉 |

---

## 3. TC-1 — D-13 Anthropic CORS 浏览器直连（关键）

**需求：** 浏览器带 `anthropic-dangerous-direct-browser-access: true` 头直连 `https://api.anthropic.com/v1/messages`，返回 200 + 流式 delta，无 CORS 拦截。

### 步骤
1. 导航 `http://localhost:<port>/settings`。
2. 点「+ 添加网关」按钮 → 弹出 Modal（标题「添加网关」）。
3. 填表单：
   - 名称：`Claude 主账号`
   - 类型：选 `Anthropic (/v1/messages)`
   - Base URL：`https://api.anthropic.com`
   - API 密钥：`$ANTHROPIC_API_KEY` 的值
   - 默认模型 ID：`claude-sonnet-4-20250514`（若该模型无权，用你确认该 key 可用的 claude 模型 id，并在报告中注明替换值）
4. 点「保存网关」。
5. **断言 A（保存成功）**：Modal 关闭；列表出现一张网关卡片，含「Claude 主账号」。
6. 在该卡片点「测试连接」按钮。
7. **断言 B（请求，强证据）**：Network 出现 `POST https://api.anthropic.com/v1/messages`：
   - 状态 **200**
   - 请求 Headers 含 `x-api-key`、`anthropic-version: 2023-06-01`、**`anthropic-dangerous-direct-browser-access: true`**
   - 无 CORS error
8. **断言 B（代理，若无法读 Network 则用此）**：测试连接按钮文案变化序列「测试连接」→「测试中…」（disabled）→**「已连接」**（disabled，绿色 tint）；卡片状态 pill 文案 **「已连接」** 且为 success 色。

### 通过判据
- 断言 A + 断言 B 任一形态（Network 强证据 优先；无 Network 能力时代理判据需成立）+ G1（无 CORS 报错）。

### 失败判据
- 「保存网关」后列表无卡片 → 记录（可能 gateways 索引 regression 复现）。
- 测试连接显示「连接失败」/「密钥无效」pill，或 Console 出现 CORS 错 → **D-13 不通过**。记录 pill 文案 + Console 错误 + 若能抓到的 HTTP 状态码。
- 返回 401/403 → key 问题或 adapter 鉴权头问题；记录状态码。

### 失败时回传
- 网关是否出现在列表（是/否）
- 测试连接后 pill 最终文案
- Console 是否有 CORS 错（是/否 + 错误文本）
- Network 能抓到的 HTTP 状态码（若可）
- 请求头是否含 `anthropic-dangerous-direct-browser-access: true`（若可读）

---

## 4. TC-2 — SC#1 OpenAI 兼容网关验证

**需求：** OpenAI 兼容网关（`/v1/chat/completions` + `Authorization: Bearer`）浏览器直达。

### 步骤
1. 仍在 `/settings`，再点「+ 添加网关」：
   - 名称：`OpenAI`
   - 类型：`OpenAI 兼容 (/v1/chat/completions，含 OpenAI/DeepSeek/Ollama/vLLM)`
   - Base URL：`https://api.openai.com`
   - API 密钥：`$OPENAI_API_KEY` 值
   - 默认模型 ID：`gpt-4o-mini`
2. 保存 → 断言卡片出现。
3. 点「测试连接」。
4. **断言**：按钮最终「已连接」+ pill「已连接」绿；Network（若可读）`POST https://api.openai.com/v1/chat/completions` 200 + `Authorization: Bearer ...`。

### 注（降级方案）
- 若 OpenAI 浏览器直连出现 CORS 拦截（OpenAI 偶有限制），改用 DeepSeek：
  - Base URL `https://api.deepseek.com`，key `$DEEPSEEK_API_KEY`，默认模型 `deepseek-chat`，类型仍是 `OpenAI 兼容`。
  - 在报告中注明「OpenAI 直连失败，改用 DeepSeek 验证 openai-compatible 契约」+ OpenAI 失败的 Console 错误文本。这**不构成 Phase 1 失败**（openai-compatible 契约被任一兼容端验证即可），但需如实记录。

### 通过判据
- 至少一个 openai-compatible 网关测试连接「已连接」+ 无 CORS 错。

---

## 5. TC-3 — SC#2 完整真实讨论 E2E

**需求：** 建房间 → 加 2 agent（分用两个网关）→ 跑一轮 → 真实流式发言 → 自动总结 → 追问第二轮。

### 步骤
1. 导航 `/rooms/new`。
2. 话题输入：`Phase 1 网关方案评审`。
3. 加 agent 1：角色 `产品经理` → 网关选「Claude 主账号」→ 模型 `claude-sonnet-4-20250514`（或 TC-1 实际可用的 claude 模型）→ 确认添加。
4. 加 agent 2：角色 `架构师` → 网关选「OpenAI」（或 DeepSeek）→ 对应模型 → 确认添加。
   - 断言：agent 卡片副标题形如 `Claude 主账号 · claude-sonnet-4-20250514`（含网关名 · 模型 id）。
5. 点「创建并进入」→ 进入房间页。
6. 点「发起讨论」。
7. **断言 A（真实流式）**：两个 agent 依次出现 typing 状态后产出**非空文本**（真实模型响应，非占位/空字符串）。每个 agent 发言后状态为 online。
8. **断言 B（自动总结）**：讨论结束后 SummaryBlock 出现**非空总结文本**。
9. 在 UserInputBar 输入「请补充安全考虑」→ 提交。
10. 点「开始新一轮」。
11. **断言 C（追问第二轮）**：第二轮 agent 再次产出非空文本（应能体现看到上一轮 summary + 用户消息的上下文衔接）。

### 通过判据
- 断言 A + B + C 全成立；全程无 agent 非预期 offline；Console 无非业务错误。

### 失败时回传
- 哪一 agent / 哪一步失败（建房 / 加 agent / 发起 / 流式 / 总结 / 追问）
- 是否有 agent 显示 offline + 其 inline 文案
- SummaryBlock 是否出现 + 是否为空
- Console / Network 异常

---

## 6. TC-4 — SC#3 干净检出运行时侧

**需求：** 生产运行路径不依赖 dev proxy；E2E 在此前提下跑通。

### 步骤（可与 TC-3 并行观察）
1. shell 执行 `lsof -i:8788` → **断言**：无输出（无 model-proxy 进程）。
2. DevTools Network 过滤框输入 `/api/claude` → **断言**：列表为空（全程无对 dev proxy 的请求）。
3. TC-3 的 E2E 在此前提下完整跑通（已由 TC-3 覆盖）。

### 通过判据
- :8788 无进程 + Network 无 `/api/claude` + TC-3 通过。

---

## 7. TC-5 — SC#4 5 类错误呈现 + 致命扩散 + 全离线跳总结

**需求：** 网关错误分类呈现（invalid_key/rate_limit/upstream/timeout/network），致命（invalid_key）扩散整网关离线、可恢复只标单 agent；全离线跳总结 + banner 提示。

### 子用例 5a — invalid_key 致命扩散
1. `/settings` → 编辑「Claude 主账号」→ API 密钥改为 `sk-ant-INVALID` → 保存。
2. `/rooms/new` → 话题 `错误呈现验证` → 加 **2 个 agent 都选「Claude 主账号」** → 发起讨论。
3. **断言**：
   - 第一个 agent 气泡内联出现 `role="status"` 块，文案含 `密钥无效` + `已离线`。
   - 第二个 agent 气泡内联 `role="status"` 块，文案含 `网关已离线`（且应**未发起真实请求**——若你能读 Network，断言第二个 agent 无 `POST .../v1/messages`）。
   - 顶部 ErrorBanner 含 `role="alert"`，文案含 `已离线` + `密钥无效`。
   - 无 SummaryBlock；额外出现黄色 banner，文案含 `本轮无有效发言，未生成总结`。

### 子用例 5b — 部分成功（致命 + 可恢复混合）
1. `/settings` 把 Claude key 改回正确值（`$ANTHROPIC_API_KEY`）→ 测试连接「已连接」。
2. `/rooms/new` → 加 1 agent（Claude，但先把 key 再改错一次）+ 1 agent（OpenAI，正确 key）→ 发起讨论。
   - 简化：若不便反复改 key，可：建 1 借 Claude 错 key agent + 1 OpenAI 对 key agent。
3. **断言**：Claude agent 红色 inline 错误；OpenAI agent 正常非空发言；SummaryBlock 基于成功发言生成（非空）。

### 子用例 5c — 恢复
1. `/settings` 把 Claude key 改回正确 → 测试连接「已连接」。
2. 重开一轮讨论（同房追问或新建）→ **断言**：所有 agent 正常发言，无离线。

### 通过判据
- 5a 三项断言全成立（致命扩散 + 跳总结 + 双 banner）；5b 部分成功 + summary 非空；5c 恢复正常。
- 所有错误块 `role` 正确（status=inline, alert=banner）且 DOM 可见。

### 失败时回传
- 每个 inline/banner 的实际文案（截图或文本）
- 第二个 agent 是否仍发起了请求（Network 观察）
- 全离线时是否仍尝试生成 summary（不应）

> **文案容差：** 各错误块只需含上表关键子串（`密钥无效`/`已离线`/`网关已离线`/`本轮无有效发言`），完整句子允许与 UI-SPEC 微差。

---

## 8. TC-6（可选）— 删除流程

> 非阻塞项，时间允许时执行。

1. `/settings` 任意网关点「删除」→ 确认 Modal 出现，含：网关名 + `gatewayId 将被清空` 字样 + `此操作不可撤销`；默认焦点在「取消」（ESC 可关）。
2. 确认删除 → 网关从列表消失。
3. DevTools Application → localStorage：`councilkit.gateways.<id>.enc` 被清除。
4. 若有 agent 引用该网关，其 `gatewayId` 变空串（IndexedDB agents 表）。

---

## 9. 收尾：恢复 key
若你在 TC-5 改坏了 Claude key，**确保最后改回正确 key 并测试连接「已连接」**，避免影响后续 Phase 2。

---

## 10. 回传报告格式（必须严守）

执行完毕（或中途失败需反馈）后，向编排者回传以下结构化 Markdown。**不要省略用例**，未执行的标 `SKIPPED` + 原因。

```markdown
## CouncilKit Phase 1 自动化验收报告

执行者: Codex
执行时间: <开始-结束>
dev port: <实际端口>
ANTHROPIC_API_KEY: <前8位>…
OPENAI_API_KEY: <前8位>…（或 DEEPSEEK_API_KEY: <前8位>…）

### 全局判据
- G1 无 CORS 报错: PASS / FAIL
- G2 :8788 无进程: PASS / FAIL
- G3 无非预期 JS 异常: PASS / FAIL
- G4 错误均用户可见: PASS / FAIL

### 用例结论
| 用例 | 结论 | 备注 |
|------|------|------|
| TC-1 D-13 Anthropic CORS | PASS / FAIL / SKIPPED | <pill 文案 / HTTP 状态 / header 是否含 dangerous-direct-browser-access / CORS 情况> |
| TC-2 SC#1 openai-compatible | PASS / FAIL / SKIPPED | <OpenAI 还是 DeepSeek / pill 文案 / CORS 情况> |
| TC-3 SC#2 完整 E2E | PASS / FAIL / SKIPPED | <流式非空 / summary 非空 / 第二轮 / 失败步骤> |
| TC-4 SC#3 干净检出运行时 | PASS / FAIL / SKIPPED | <lsof 输出 / /api/claude Network 是否为空> |
| TC-5 SC#4 错误呈现 | PASS / FAIL / SKIPPED | <5a致命扩散 / 5b部分成功 / 5c恢复 三项各结论> |
| TC-6 删除流程 | PASS / FAIL / SKIPPED | <可选> |

### 失败详情（仅 FAIL 时填，每条含：用例 / 步骤 / 实际现象 / Console 错误文本 / Network 状态码 / 截图路径或 DOM 快照）
- <若无失败写 "无">

### 现象性观察（非阻塞，但值得记录）
- <UI 异常、文案微差、性能、a11y 等，或 "无">

### 推荐编排者动作
- 全 PASS → 写 `approved`，编排者关闭 Phase 1
- 有 FAIL → 写 `FAILED: <用例>`，并在此给出建议回退到哪个 plan（01-02 adapter / 01-03 settings / 01-04 error orchestration）+ 证据指针
```

---

## 11. 回传信号约定（给编排者）

回传报告后，**等待编排者**根据报告决定：
- **全 PASS** → 编排者将执行 `approved` 流程：把 GW-01 + 01-05 plan mark-complete、Phase 1 关闭、勾选 ROADMAP、进入 Phase 2。
- **有 FAIL** → 编排者据你报告的「推荐回退 plan」回退到 01-02 / 01-03 / 01-04 修正，修复后重跑本 runbook 对应用例。

**你不负责**：修改源码、标 Phase 完成、更新 STATE/ROADMAP。

---

## 12. 速查：关键可观察文案对照表

| 场景 | DOM 期望含（子串） | role |
|------|---------------------|------|
| 测试连接-成功 | 按钮与 pill「已连接」 | — |
| 测试连接-测试中 | 「测试中…」(disabled) | — |
| 测试连接-密钥错 | pill「密钥无效」 | — |
| 测试连接-其他失败 | pill「连接失败」 | — |
| 空网关列表 | 标题「还没有网关」 | — |
| invalid_key 气泡 | `密钥无效` + `已离线` | `status` |
| 致命扩散气泡 | `网关已离线` | `status` |
| 顶部错误汇总 | `已离线` + `密钥无效`（含网关名） | `alert` |
| 全离线提示 | `本轮无有效发言` + `未生成总结` | — |
| 删除确认 Modal | `gatewayId 将被清空` + `此操作不可撤销` | — |
