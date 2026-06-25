# Phase 1: Production Model Gateway - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-25
**Phase:** 1-Production Model Gateway
**Areas discussed:** Provider/Key 配置模型, 设置页与密钥 UX, 错误呈现粒度

---

## Area selection

| Option | Description | Selected |
|--------|-------------|----------|
| 生产传输方式 | 浏览器直连 vs 后端代理（SC#1/SC#3 字面锁定直连，未单独讨论，作为继承决策） | |
| Provider/Key 配置模型 | 通用 gateway 列表 vs 固定 N provider vs 按 agent 自带 | ✓ |
| 设置页与密钥 UX | 入口、crypto 多 key 化、master passphrase、测试连接 | ✓ |
| 错误呈现粒度 | 401/429/5xx/timeout 映射、呈现位置、整 provider 离线 vs 单 agent | ✓ |

**Notes:** 用户未选「生产传输方式」——按 SC#1/SC#3 字面锁定为浏览器直连（D-13），Anthropic CORS 头可行性作为研究项交 researcher 验证。

---

## Provider/Key 配置模型

### Q1 — Provider/Key 数据模型
| Option | Description | Selected |
|--------|-------------|----------|
| 通用 gateway 列表 | 命名 gateway {name,type,baseUrl,apiKey(AES),defaultModel}，Dexie 存储，Agent 引用 {gatewayId,model} | ✓ |
| 固定 N provider | 保留 Claude/OpenAI/DeepSeek 枚举，按 provider 存 {key,baseUrl,modelId} | |
| 按 agent 自带 | 每个 agent 自带 key+baseUrl+model | |

**User's choice:** 通用 gateway 列表

### Q2 — Agent 字段形态与旧数据迁移
| Option | Description | Selected |
|--------|-------------|----------|
| gatewayId+model 替换 | Agent 改 {gatewayId,model}，defaultModel 预填，旧 tag seed 占位 gateway 回填 | ✓ |
| 保留标签加引用 | 保留 model:ModelType 展示标签 + gatewayId + modelId，老数据免迁移 | |
| 只存 gatewayId | model 一律用 gateway.defaultModel | |

**User's choice:** gatewayId+model 替换

### Q3 — gateway.type 种类
| Option | Description | Selected |
|--------|-------------|----------|
| 两种：anthropic + openai-compatible | /v1/messages 与 /v1/chat/completions 两契约，service 收敛两 adapter | ✓ |
| 三种独立 | anthropic/openai/deepseek 各独立 | |
| 只 openai-compatible | 强制全走 openai 契约 | |

**User's choice:** 两种：anthropic + openai-compatible

**Area check:** 用户选「下一个灰区」。

---

## 设置页与密钥 UX

### Q1 — gateway 管理入口
| Option | Description | Selected |
|--------|-------------|----------|
| sidebar 第 4 项 | /settings 页，CRUD 空间充足 | ✓ |
| header 齿轮抽屉 | 保 3 入口，抽屉拥挤 | |
| 内嵌 agent 页 | 不利于共享资源全局管理 | |

**User's choice:** sidebar 第 4 项

### Q2 — 多 gateway key 加密策略
| Option | Description | Selected |
|--------|-------------|----------|
| 固定 passphrase 多 key | 扩 crypto.ts 按 gatewayId 存 cipher，沿用固定 passphrase | ✓ |
| master passphrase | 首次设主密码派生密钥，更安全但增摩擦 | |
| 明文不加密 | 违反 AES 约束 | |

**User's choice:** 固定 passphrase 多 key

### Q3 — gateway 元数据存储
| Option | Description | Selected |
|--------|-------------|----------|
| Dexie 表 + key 入 localStorage | 元数据 Dexie gateways 表，apiKey AES 入 localStorage | ✓ |
| 全量存 Dexie | 统一但 key 进 IndexedDB 违约束 | |
| 全量存 localStorage | 与其他实体不一致 | |

**User's choice:** Dexie 表 + key 入 localStorage

### Q4 — 测试连接
| Option | Description | Selected |
|--------|-------------|----------|
| 有，发最小流式请求 | 验 200 + 至少一个 delta | ✓ |
| 无，靠错误兜底 | 最简 | |
| 轻量 health 检查 | anthropic 无 models list，兼容差 | |

**User's choice:** 有，发最小流式请求

**Area check:** 用户选「下一个:错误处理」。

---

## 错误呈现粒度

### Q1 — 错误分类映射
| Option | Description | Selected |
|--------|-------------|----------|
| 五类结构化 | invalid_key/rate_limit/upstream/timeout/network，service 层透传 | ✓ |
| 两类：可恢复/致命 | 粗粒度 | |
| 不分类 | 不达 SC#4 | |

**User's choice:** 五类结构化

### Q2 — 呈现位置
| Option | Description | Selected |
|--------|-------------|----------|
| 气泡内联 + 顶部 banner | 定位准 + 可见性强 | ✓ |
| 仅气泡内联 | 多 agent 出错时分散 | |
| 仅顶部 banner | 失去 agent 定位 | |

**User's choice:** 气泡内联 + 顶部 banner

### Q3 — 离线粒度
| Option | Description | Selected |
|--------|-------------|----------|
| 致命扩散/可恢复单 agent | invalid_key 扩散 gateway，其余只标单 agent | ✓ |
| 只标单 agent | 同 bad key 重复 401 | |
| 全标 gateway | 一个 timeout 拖垮全 | |

**User's choice:** 致命扩散/可恢复单 agent

### Q4 — 全离线总结 + 超时策略
| Option | Description | Selected |
|--------|-------------|----------|
| 沿 10s/全离线跳总结 | R7 locked，全离线 banner 提示无总结 | ✓ |
| 放宽超时 | 与 R7 冲突需 CR | |
| 仍尝试总结 | 无意义 | |

**User's choice:** 沿 10s/全离线跳总结

**Final check:** 用户选「写入 CONTEXT」。

---

## Claude's Discretion

- gateway Dexie 表结构细节、crypto.ts 多 key 的 localStorage key 命名
- baseUrl 拼 /v1 路径策略（建议用户只填 host，代码按 type 拼路径）
- 测试连接请求的 model/max_tokens 取值
- 五类错误文案措辞
- sidebar 第 4 项图标/位置

## Deferred Ideas

- gateway 后台健康监控 / 延迟展示
- 速率限制自适应退避
- model 选择器升级为下拉拉取 /v1/models
- 生产放宽超时（需重开 R7 CR）
