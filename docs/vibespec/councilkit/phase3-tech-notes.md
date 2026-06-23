# CouncilKit - Phase 3 技术研究笔记

## 1. PRD/DESIGN 技术需求提取

### P0 需求技术映射

- R1（创建房间）: 前端表单 → POST API → 数据持久化
- R2（添加 agent，选模型）: agent 配置 CRUD + 模型列表管理
- R3（定义角色/立场）: agent 元数据（文本字段）
- R4（agent 互相看到发言并质疑补充）: 讨论流引擎 —— 依次调用各模型 API，需传递上下文
- R5（自动生成总结）: 需要额外的总结模型调用或复用最后一个 agent
- R6（同一房间继续追问）: 讨论上下文持久化 + 增量追加
- R7（首条发言 ≤10s）: 并发调用优化或流式优先
- R8（用户参与发言）: 讨论流支持用户消息插入

### DESIGN 技术约束

- 4 个路由 → 至少 3 个页面组件（主页、新建房间、房间讨论）+ 1 个 P1 页面（模板管理）
- 侧边栏 + 主内容区两栏布局 → 需要 layout 组件
- 深色主题 → CSS 变量 / Tailwind dark mode
- 响应式 3 断点（≥1024 / 640-1023 / <640）→ 移动端适配
- 键盘导航 + 屏幕阅读器 → a11y 库
- 时间线视图 + 分栏对比视图切换 → 状态切换逻辑
- 流式输出展示 → SSE / WebSocket 或模拟流式
- 每轮自动总结 → 触发时机 + 模型调用

### 数据实体（来自 DESIGN）

- Room: id, topic, createdAt, lastActiveAt, agentIds, rounds
- Agent: id, model, role, status, roomId/templateId
- Message: id, senderId, senderType(agent/user), content, roundId, timestamp
- Round: id, roundNumber, messageIds, summaryId
- Summary: id, roundId, content, generatedAt
- Template (P1): id, name, agentConfigs

## 2. 现有代码库评估

仓库为全新项目，无已有代码。无历史技术栈约束。可自由选择技术方案。

## 3. 外部依赖与生态研究

### 前端框架候选
- React + Next.js: 生态最成熟，SSR 可选，路由内置
- React + Vite: 更轻量，SPA 够用
- 纯 React SPA + React Router: 最简单，无需 SSR（CouncilKit 是纯客户端工具）

### 样式方案候选
- Tailwind CSS: 快速开发，深色主题内置，响应式工具类完备
- CSS Modules: 零依赖，但深色/响应式需手写

### 状态管理候选
- Zustand: 轻量，适合客户端状态（UI 状态、视图切换）
- React Query (TanStack Query): 服务端状态管理（API 调用缓存、重试）
- 两者可组合使用

### 数据持久化候选
- IndexedDB (via Dexie.js): 浏览器端持久化，适合离线优先
- localStorage: 简单但容量小（5MB），不适合大量讨论历史
- SQLite (via OPFS): 现代浏览器支持，性能好

### 多模型 API 调用
- 直接 HTTP fetch 到各模型 API（Claude API、OpenAI API、DeepSeek API）
- 流式输出通过 SSE / ReadableStream 处理
- 需处理 API Key 管理（本地存储，加密）

### 测试候选
- Vitest: 单元/组件测试，快速
- Playwright: E2E 测试，支持多浏览器
- Testing Library: 组件交互测试

## 4. 技术约束与风险预判

- 部署环境: 纯浏览器端（Web app）或 Tauri/Electron 桌面端
- 性能约束: 多模型并发调用，首条延迟 ≤10s（SC-4）
- 安全约束: API Key 本地加密存储，HTTPS 传输
- 无多租户、无国际化（初期）
- 离线模式: PRD R8 提到离线可用 → 需本地持久化 + 离线队列

### 延后到 Tech 项的初步技术方向

1. 多模型并发 + 延迟 ≤10s: 并行调用所有 agent 首条发言，使用 Promise.all + AbortController 超时控制
2. 上下文压缩: 滑动窗口 + 摘要注入（每轮后压缩历史为摘要）
3. 本地存储: IndexedDB (Dexie.js)
4. Web vs macOS: 先 Web app（MVP 最快），后续可包装为 Tauri 桌面端
5. 流式输出: ReadableStream + React state 逐字更新
6. 总结生成: 每轮结束后调用主模型生成总结（可并行于下一轮准备）