---
phase: tech
status: confirmed
prd: docs/vibespec/councilkit/PRD.md
design: docs/vibespec/councilkit/DESIGN.md
created: 2026-06-22
updated: 2026-06-22
confirmed_at: 2026-06-22T00:00:00Z
---

# CouncilKit - 技术方案

## 技术栈

### 运行时与语言

- 运行时: 浏览器
- 语言: TypeScript 5.x
- 版本约束: TypeScript ≥5.0, Node.js ≥18 (开发环境)

### 框架与核心库

| 类别 | 选择 | 版本 | 用途 |
|------|------|------|------|
| 前端框架 | React | 18.x | UI 组件框架 |
| 构建工具 | Vite | 5.x | 开发服务器与生产构建 |
| 路由 | React Router | 6.x | 客户端路由 (/ /rooms/new /rooms/:roomId /templates) |
| 样式方案 | Tailwind CSS | 3.x | 原子化 CSS，深色主题内置，响应式工具类 |
| 包管理器 | pnpm | 9.x | 依赖管理 |

### 开发工具

- 代码规范: Biome（替代 ESLint + Prettier，单一工具）
- 类型检查: TypeScript strict 模式
- Git hooks: lefthook（轻量替代 Husky）

## 目录结构

```text
src/
  app/                    # 应用入口与路由（对应 DESIGN 路由表）
    layout.tsx            # AppShell 根布局（侧边栏 + 主内容区）
    page.tsx              # 主页 / （空状态或重定向）→ DES: 页面 1
    rooms/
      new/
        page.tsx          # 新建房间 /rooms/new → DES: 页面 2
      [roomId]/
        page.tsx          # 房间讨论 /rooms/:roomId → DES: 页面 3
    templates/
      page.tsx            # Agent 模板管理 /templates → DES: 页面 4 (P1)
  components/             # 共享组件
    ui/                   # 基础 UI 组件
      Button.tsx
      TextInput.tsx
      Textarea.tsx
      Select.tsx          # ModelSelect
      Modal.tsx
      Skeleton.tsx
    layout/               # 布局组件
      AppShell.tsx        # 两栏外壳 → DES: AppShell
      Sidebar.tsx         # 侧边栏 → DES: Sidebar
    room/
      RoomListItem.tsx    # 房间列表项 → DES: RoomListItem
      RoomHeader.tsx      # 话题头部 → DES: RoomHeader
      ViewToggle.tsx      # 时间线/分栏切换 → DES: ViewToggle
      DiscussionStream.tsx # 讨论流 → DES: DiscussionStream
      TimelineView.tsx    # 时间线视图 → DES: TimelineView
      ColumnCompareView.tsx # 分栏对比视图(P1) → DES: ColumnCompareView
      RoundDivider.tsx    # 轮次分隔 → DES: RoundDivider
      SummaryBlock.tsx    # 总结折叠块 → DES: SummaryBlock
      UserInputBar.tsx    # 输入框 → DES: UserInputBar
    agent/
      AgentConfigCard.tsx # Agent 配置卡片 → DES: AgentConfigCard
      AgentConfigList.tsx # Agent 配置列表 → DES: AgentConfigList
      AgentManagePanel.tsx # Agent 管理(P1) → DES: AgentManagePanel
      TypingIndicator.tsx # 打字指示器 → DES: TypingIndicator
    message/
      MessageBubble.tsx   # 发言气泡 → DES: MessageBubble
    template/
      TemplateCard.tsx    # 模板卡片(P1) → DES: TemplateCard
      TemplatePicker.tsx  # 模板引用器(P1) → DES: TemplatePicker
    shared/
      EmptyState.tsx      # 通用空状态 → DES: EmptyState
      ErrorBanner.tsx     # 错误提示 → DES: ErrorBanner
  lib/                    # 工具函数与共享逻辑
    db.ts                 # Dexie.js 数据库初始化
    api.ts                # 模型 API 调用封装
    stream.ts             # 流式输出处理（ReadableStream）
    crypto.ts             # API Key 本地加解密
    context.ts            # 上下文压缩（滑动窗口 + 摘要注入）
    summary.ts            # 独立总结生成
  models/                 # 数据模型定义
    room.ts
    agent.ts
    message.ts
    round.ts
    summary.ts
    template.ts
  services/               # API 调用与外部服务
    claude.ts             # Claude API
    openai.ts             # OpenAI API
    deepseek.ts           # DeepSeek API
    model-registry.ts     # 模型注册与路由
  stores/                 # 状态管理
    ui.ts                 # Zustand: 侧边栏、视图切换、当前房间
    discussion.ts         # Zustand: 讨论流状态（发言队列、轮次）
    queries.ts            # React Query: API 调用缓存与重试
  styles/                 # 全局样式
    globals.css           # Tailwind 指令 + CSS 变量（配色方案）
  types/                  # 共享类型定义
    index.ts
tests/
  unit/                   # 单元测试（工具函数、模型）
  integration/            # 集成测试（API 契约、数据流转）
  e2e/                    # 端到端测试（核心用户流程）
public/                   # 静态资源
```

目录对应关系:
- `src/app/` 对应 DESIGN 路由表（4 条路由 1:1 映射）
- `src/components/` 对应 DESIGN 组件树（共享组件 + 页面级组件）
- `src/models/` 对应 DESIGN 数据实体（6 个实体）
- `src/services/` 对应 3 个外部模型 API
- `src/stores/` 对应 DESIGN 数据流向

## 数据模型

### 实体定义

#### Room

| 字段 | 类型 | 必填 | 说明 | 约束 |
|------|------|------|------|------|
| id | string | 是 | 房间唯一标识 | 主键，UUID |
| topic | string | 是 | 讨论话题 | 非空，长度 ≤ 200 |
| createdAt | number | 是 | 创建时间戳 | Unix ms |
| lastActiveAt | number | 是 | 最近活跃时间戳 | Unix ms |
| agentIds | string[] | 是 | 关联 agent ID 列表 | 至少 1 个 |
| roundIds | string[] | 是 | 轮次 ID 列表 | 初始为空数组 |
| status | enum | 是 | 房间状态 | idle / discussing / paused |

#### Agent

| 字段 | 类型 | 必填 | 说明 | 约束 |
|------|------|------|------|------|
| id | string | 是 | Agent 唯一标识 | 主键，UUID |
| model | enum | 是 | 底层模型 | claude / openai / deepseek |
| role | string | 是 | 角色/立场 | 非空，长度 ≤ 100 |
| color | string | 是 | 标识色 | hex 色值 |
| roomId | string | 否 | 所属房间 ID（非模板时） | 外键 → Room |
| templateId | string | 否 | 所属模板 ID | 外键 → Template，P1 |
| status | enum | 是 | Agent 状态 | online / offline / typing |

#### Message

| 字段 | 类型 | 必填 | 说明 | 约束 |
|------|------|------|------|------|
| id | string | 是 | 消息唯一标识 | 主键，UUID |
| senderId | string | 是 | 发送者 ID | agentId 或 "user" |
| senderType | enum | 是 | 发送者类型 | agent / user |
| content | string | 是 | 消息内容（Markdown） | 非空 |
| roundId | string | 是 | 所属轮次 ID | 外键 → Round |
| timestamp | number | 是 | 发送时间戳 | Unix ms |

#### Round

| 字段 | 类型 | 必填 | 说明 | 约束 |
|------|------|------|------|------|
| id | string | 是 | 轮次唯一标识 | 主键，UUID |
| roundNumber | number | 是 | 轮次序号 | 从 1 自增 |
| roomId | string | 是 | 所属房间 ID | 外键 → Room |
| messageIds | string[] | 是 | 本轮消息 ID 列表 | 按发言顺序排列 |
| summaryId | string | 否 | 本轮总结 ID | 外键 → Summary，轮次完成前为空 |
| status | enum | 是 | 轮次状态 | pending / active / completed |

#### Summary

| 字段 | 类型 | 必填 | 说明 | 约束 |
|------|------|------|------|------|
| id | string | 是 | 总结唯一标识 | 主键，UUID |
| roundId | string | 是 | 关联轮次 ID | 外键 → Round |
| content | string | 是 | 总结内容（Markdown） | 非空 |
| generatedAt | number | 是 | 生成时间戳 | Unix ms |
| model | enum | 是 | 生成总结使用的模型 | 可与讨论模型不同 |

#### Template（P1）

| 字段 | 类型 | 必填 | 说明 | 约束 |
|------|------|------|------|------|
| id | string | 是 | 模板唯一标识 | 主键，UUID |
| name | string | 是 | 模板名称 | 非空 |
| agentConfigs | object[] | 是 | agent 配置数组 | 每个元素含 model、role、color |
| createdAt | number | 是 | 创建时间戳 | Unix ms |

### 实体关联

- Room 与 Agent: 1:N，关联方式: Room.agentIds 引用 Agent.id
- Room 与 Round: 1:N，关联方式: Room.roundIds 引用 Round.id
- Round 与 Message: 1:N，关联方式: Round.messageIds 引用 Message.id
- Round 与 Summary: 1:1，关联方式: Round.summaryId 引用 Summary.id
- Template 与 Agent: 1:N，关联方式: Agent.templateId 引用 Template.id（P1）

### 数据约束

- Room.topic 非空且长度 ≤ 200 字符
- Room.agentIds 至少包含 1 个 agent
- Round.roundNumber 在同一 Room 内唯一且连续递增
- Message.senderType 为 "user" 时，senderId 固定为 "user"
- 每个 Round 完成后必须生成本轮 Summary（Summary block 在 DESIGN 中要求出现）

## API 契约

由于 CouncilKit 是纯客户端 Web app，无自有后端。以下 API 契约定义的是**客户端对模型服务的调用接口**以及**本地数据操作接口**。

### 模型 API 调用

#### `POST {model-api-base}/v1/messages`（流式）

三个模型 API（Claude / OpenAI / DeepSeek）统一封装为此契约。

- 用途: 发送消息并获取流式回复
- 对应 PRD 需求: R4, R7
- 请求:
  - Headers: `Authorization: Bearer {apiKey}`, `Content-Type: application/json`
  - 请求体:

```typescript
interface ModelRequest {
  model: string;           // 模型名
  messages: ModelMessage[]; // 对话上下文
  stream: true;            // 流式输出
}

interface ModelMessage {
  role: "user" | "assistant" | "system";
  content: string;
}
```

- 响应:
  - 流式 (SSE):

```typescript
interface StreamChunk {
  type: "content_block_delta" | "message_stop" | "error";
  delta?: { text: string };
  error?: { message: string; code: string };
}
```

  - 错误:
    - `401`: API Key 无效或已过期
    - `429`: 速率限制，返回 Retry-After
    - `500`: 模型服务内部错误
    - `timeout`: 超时（10s），标记 agent 离线并继续其他 agent

### 本地数据操作（IndexedDB via Dexie.js）

#### `db.rooms.add(room)` — 创建房间

- 用途: 新建房间并持久化
- 对应 PRD 需求: R1

#### `db.rooms.get(id)` — 获取房间

- 用途: 加载房间详情（含讨论历史查询）
- 对应 PRD 需求: R6, R12

#### `db.messages.where({roundId}).toArray()` — 获取轮次消息

- 用途: 加载某轮讨论的全部消息
- 对应 PRD 需求: R4

#### `db.rounds.add(round)` — 创建轮次

- 用途: 开始新一轮讨论

#### `db.summaries.add(summary)` — 保存总结

- 用途: 持久化轮次总结
- 对应 PRD 需求: R5

### 流式/实时通信

- 协议: SSE（Server-Sent Events，由模型 API 原生返回）
- 端点: 各模型 API 的 `/v1/messages`（stream 模式）
- 消息格式: 见上文 `StreamChunk` 类型定义
- 重连策略: 不重连（单次请求-响应模型）。若流中断，标记该 agent 为 error 状态，用户可手动重试

## 状态管理

### 状态分类

| 状态类别 | 管理方式 | 存储位置 | 示例 |
|----------|----------|----------|------|
| 服务端状态 | React Query（TanStack Query） | 内存 + QueryCache | 模型 API 调用（发送消息、获取流式响应）、总结生成 |
| 客户端状态 | Zustand | 内存 | 侧边栏展开状态、当前路由、视图切换（时间线/分栏）、当前选中房间 ID |
| 持久化状态 | IndexedDB（Dexie.js） | 磁盘 | 房间列表、讨论历史、agent 配置、轮次与总结 |
| URL 状态 | React Router search params | URL | /rooms/:roomId 的 roomId |

### 状态流转

- 发起讨论: 用户点击"发起讨论" → Zustand 创建 Round(active) → React Query 并行调用各 agent → 流式 chunk 更新 Zustand 讨论流 → 全部完成触发 Summary 生成 → Round 状态 → completed → 写入 IndexedDB
- 追问: 用户输入 → Zustand 插入用户 Message → 创建新 Round → 同上流程
- 视图切换: Zustand viewMode 状态变更 → TimelineView / ColumnCompareView 条件渲染（同一份 Message 数据源）
- 房间切换: URL roomId 变更 → IndexedDB 加载房间数据 → Zustand 初始化讨论流快照

## 外部依赖

### 运行时依赖

| 依赖 | 版本 | 用途 | 评估 |
|------|------|------|------|
| react | 18.x | UI 框架 | 活跃度: 高，许可证: MIT，风险: 低 |
| react-dom | 18.x | DOM 渲染 | 活跃度: 高，许可证: MIT，风险: 低 |
| react-router-dom | 6.x | 客户端路由 | 活跃度: 高，许可证: MIT，风险: 低 |
| @tanstack/react-query | 5.x | 服务端状态管理 | 活跃度: 高，许可证: MIT，风险: 低 |
| zustand | 4.x | 客户端状态管理 | 活跃度: 高，许可证: MIT，风险: 低 |
| dexie | 4.x | IndexedDB 封装 | 活跃度: 高，许可证: Apache-2.0，风险: 低 |
| react-markdown | 9.x | Markdown 渲染 | 活跃度: 高，许可证: MIT，风险: 低 |
| crypto-js | 4.x | API Key 本地 AES 加密 | 活跃度: 中，许可证: MIT，风险: 低（可考虑 Web Crypto API 替代） |

### 开发依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| typescript | 5.x | 类型检查 |
| vite | 5.x | 构建工具 |
| @vitejs/plugin-react | 4.x | Vite React 插件 |
| tailwindcss | 3.x | CSS 框架 |
| @biomejs/biome | 1.x | 代码格式化和 lint |
| vitest | 1.x | 单元/组件测试 |
| @testing-library/react | 14.x | 组件测试 |
| @testing-library/user-event | 14.x | 用户交互模拟 |
| playwright | 1.x | E2E 测试 |
| lefthook | 1.x | Git hooks |

### 外部服务

| 服务 | 用途 | 认证方式 | 备用方案 |
|------|------|----------|----------|
| Claude API (Anthropic) | Claude 模型对话与总结 | API Key（x-api-key header） | 降级到 OpenAI |
| OpenAI API | GPT 模型对话 | API Key（Bearer token） | 降级到 Claude |
| DeepSeek API | DeepSeek 模型对话 | API Key（Bearer token） | 降级到 Claude |

## 安全和权限边界

### 身份认证

- 方案: API Key（本地输入，本地存储）
- 令牌存储: localStorage（AES 加密），不使用 cookie
- 令牌刷新: 无（API Key 长期有效，用户手动更新）

### 授权模型

- 角色定义: 单用户，无角色区分。所有数据属于当前用户
- 权限粒度: 不适用（本地单用户应用）
- 越权处理: 不适用

### 数据安全

- 传输加密: 所有模型 API 调用必须通过 HTTPS
- 敏感数据: API Key 在 localStorage 中使用 AES-256 加密存储，内存中仅在调用 API 时解密使用
- 输入校验: 话题输入长度校验（前端），agent 配置完整性校验（前端）
- XSS 防护: React 默认转义 + Markdown 渲染使用 react-markdown（不渲染 HTML 标签）+ CSP header
- CSRF 防护: 不适用（纯客户端应用，无 cookie 认证）

## 测试策略

### 测试层级

| 层级 | 工具 | 覆盖目标 | 运行方式 |
|------|------|----------|----------|
| 单元测试 | Vitest | 工具函数（上下文压缩、加密解密、消息格式化）、数据模型校验 | `pnpm test:unit` |
| 组件测试 | Testing Library + Vitest | 关键 UI 组件交互（MessageBubble、AgentConfigCard、DiscussionStream 状态切换） | `pnpm test:unit` |
| 集成测试 | Vitest | API 契约（mock 模型 API）、数据流转（React Query → Zustand → IndexedDB） | `pnpm test:integration` |
| 端到端测试 | Playwright | P0 核心用户流程（新建房间 → 发起讨论 → 查看总结 → 追问） | `pnpm test:e2e` |

### 测试要求

- 关键数据模型（Room、Message、Round）必须有校验函数的单元测试；
- 每个模型 API 调用封装（claude.ts、openai.ts、deepseek.ts）必须有集成测试（mock 响应）；
- P0 用户流程（场景 1: 快速发起讨论 + 场景 2: 继续追问）必须有端到端测试；
- 测试不追求覆盖率数字，追求关键路径全覆盖。

## 验证命令

| 命令 | 用途 | 预期结果 | 备注 |
|------|------|----------|------|
| `pnpm install` | 安装依赖 | 无错误，node_modules 生成 | 首次运行前执行 |
| `pnpm dev` | 启动开发服务器 | Vite 启动，http://localhost:5173 可访问 | 开发中持续运行 |
| `pnpm build` | 生产构建 | 输出到 dist/，无 TypeScript 错误 | 部署前执行 |
| `pnpm test:unit` | 运行单元测试 | 全部通过 | CI 执行 |
| `pnpm test:e2e` | 运行 E2E 测试 | Playwright 启动浏览器并验证核心流程 | 需要模型 API mock |
| `pnpm typecheck` | TypeScript 类型检查 | 无类型错误 | CI 执行 |
| `pnpm lint` | Biome 代码检查 | 无 lint 错误 | CI 执行 |

所有命令在项目初始化后可执行。`test:e2e` 需要先配置 Playwright 和 mock 环境（延后到实现）。

## 实现风险

| 风险 | 等级 | 影响 | 缓解措施 |
|------|------|------|----------|
| 多模型 API 并发调用延迟超过 10s（SC-4） | 高 | 用户感知慢，放弃使用 | Promise.all 并行 + 流式输出首 chunk 即展示 + AbortController 10s 超时回退 |
| IndexedDB 容量因浏览器而异（Safari 限制严格） | 中 | 讨论历史在 Safari 中可能被截断 | 监控 quota 使用量，接近上限时提示用户清理或导出 |
| 模型 API Key 本地存储安全风险 | 中 | 用户 API Key 可能被盗用 | AES-256 加密 + CSP 限制脚本执行 + 不通过网络传输 Key |
| 上下文窗口超过模型限制导致讨论中断 | 中 | 长对话后半段 agent 遗忘早期结论 | 滑动窗口 N=5 轮 + 每轮摘要注入作为固定前缀 |
| 不同模型输出格式不统一（Markdown 渲染差异） | 低 | 讨论流展示不一致，但不影响理解 | react-markdown 统一渲染 + 允许少量格式差异 |
| 浏览器不支持 IndexedDB（极旧设备） | 低 | 无法持久化，只能内存中使用 | 启动时检测 IndexedDB 可用性，不可用时降级为内存模式并告知用户 |

## 技术决策记录

| 决策 | 选择 | 放弃的替代方案 | 原因 |
|------|------|----------------|------|
| 产品形态 | 纯 Web app（浏览器运行） | macOS native app（Tauri/Electron） | MVP 最快交付，零安装门槛；后续可包装为 PWA |
| 前端框架 | React + Vite (SPA) | Next.js | CouncilKit 是纯客户端工具，无 SSR/SEO 需求；Vite 更轻量，构建更快 |
| 本地存储 | IndexedDB (Dexie.js) | localStorage | 讨论历史数据量可能远超 5MB；IndexedDB 支持复杂查询和事务 |
| 状态管理 | Zustand + React Query | 纯 Zustand | 多模型 API 调用需要缓存、重试、乐观更新，React Query 专业化处理 |
| 样式方案 | Tailwind CSS | CSS Modules | 深色主题内置、响应式工具类内置，开发速度快；符合 DESIGN 视觉方向 |
| 总结生成 | 独立模型调用 | 最后一个 agent 直接输出总结 | DESIGN 要求总结"有用的综合"，独立调用更中立客观 |
| 上下文压缩 | 滑动窗口 + 摘要注入 | 智能摘要链 | MVP 阶段实现简单，每轮已有总结可复用，注入成本低 |
| 代码规范 | Biome | ESLint + Prettier | 单一工具替代两个，配置更简单，速度更快 |
| Git hooks | lefthook | Husky | 更轻量，pnpm 兼容性好 |

## 延后到实现

- CSS 变量具体色值（DESIGN 已给出约值，实现阶段精确匹配）
- CSP header 具体配置
- API Key AES 加密密钥的存储位置（Web Crypto API vs crypto-js）
- 流式输出中间状态的降级展示策略（所有 agent 都慢时的 loading 体验）
- 端到端测试 mock 环境搭建细节

## 确认记录

- 技术栈与目录结构: 已确认
- 数据模型与 API 契约: 已确认
- 状态管理与外部依赖: 已确认
- 安全边界与测试策略: 已确认
- 实现风险与技术决策: 已确认