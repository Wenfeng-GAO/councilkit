# Runtime Host 运维

Runtime Host 是 CouncilKit 的本地模型执行边界，提供统一的 API 服务于浏览器 UI 与 CLI。本文档涵盖 Host 的启动、托管、诊断与故障排查。

## 目录

- [启动方式](#启动方式)
- [后台托管（launchd）](#后台托管launchd)
- [端口管理](#端口管理)
- [诊断包](#诊断包)
- [Squad / Review 过程观察](#squad--review-过程观察)
- [常见问题](#常见问题)

## 启动方式

### 前台启动（开发与临时使用）

```bash
# 生产模式（需要先构建）
pnpm build
pnpm start

# 开发模式（带 Vite 热重载）
pnpm dev
```

`pnpm start` 以生产模式在固定 canonical origin **http://127.0.0.1:43127** 启动前台 Runtime Host，同时提供构建后的 Web UI 与同源 `/api/v1`。开发模式使用 `pnpm dev`（经 Vite 中间件，同一 origin）。

### 验证 Host 可用

```bash
# 健康检查
curl http://127.0.0.1:43127/api/v1/health

# CLI 自检
pnpm exec councilkit doctor --json
```

浏览器打开 `http://127.0.0.1:43127`，进入 **Settings → Host** 查看 Host 状态、Installations 和 Execution Profiles。

## 后台托管（launchd）

前台 `pnpm start` 之外，可以把 Runtime Host 交给 launchd 托管：登录后自动启动、崩溃自动拉起（KeepAlive，限频 10 秒）。

### 前置条件

确保已 `pnpm build`（托管入口是 `dist-host/main.mjs`）。

### 安装

```bash
# 写入 plist（--dry-run 只打印不写盘）
node scripts/install-service.mjs [--dry-run]

# 显式加载服务
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.councilkit.host.plist
```

安装脚本只写 `~/Library/LaunchAgents/com.councilkit.host.plist`，**绝不代为 load**——上面的 `bootstrap` 需要你显式执行（旧版 macOS 用 `launchctl load -w`）。

### 重要约束

- plist 把 Node 路径固定为运行脚本时的解释器，并注入常见 PATH 以保住 CLI 发现
- **更换 Node 版本或移动仓库目录后必须重跑安装脚本**
- 托管后端口被占时会结构化退出、由 launchd 每 10 秒重拉，先用 `lsof`（见下节）排查占用

### 验证托管生效

```bash
# 检查服务状态
launchctl list | grep councilkit

# 应该看到非 `-` 的 PID
# 例如：12345	0	com.councilkit.host

# 健康检查
curl http://127.0.0.1:43127/api/v1/health

# 浏览器验证
# Settings 页 Installations 仍为 trusted
```

### 日志位置

- **标准输出**：`~/Library/Logs/CouncilKit/host.out.log`
- **标准错误**：`~/Library/Logs/CouncilKit/host.err.log`

### 卸载

```bash
# 先卸载服务
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.councilkit.host.plist

# 再删除 plist（脚本只删 plist，不代为 unload、不删日志）
node scripts/uninstall-service.mjs
```

## 端口管理

Runtime Host 只绑定 canonical origin `http://127.0.0.1:43127`，端口被占用时启动会以结构化错误失败并退出，**origin 永不迁移**。

### 定位占用进程

```bash
lsof -nP -iTCP:43127 -sTCP:LISTEN
```

示例输出：

```
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    12345 user   23u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:43127 (LISTEN)
```

### 终止占用进程

```bash
# 优雅终止（推荐）
kill <PID>

# 强制终止（备选）
kill -9 <PID>
```

结束占用进程后重新 `pnpm start` 或等待 launchd 自动拉起。

### CLI 端口独占

`councilkit run` 的 live smoke 与浏览器/Host 共用 43127，且要求独占串行（不可与 vitest/playwright 并发）。端口被占用时用 `lsof` 定位；CLI 不 kill 任何非自身进程。

## 诊断包

排查 Host 问题时，在 **Settings → Host** 段点击「导出诊断包」，下载单个 JSON 文件（也可 `GET /api/v1/diagnostics`，session 鉴权）。

### 内容

- Host 健康信息与 Driver 状态
- Installations（state/detail）
- Scope/Execution 的分类计数
- 非敏感配置（mode/port/Node 版本/uptime）
- 最近 50 条 warn/error 结构化日志（已过 sanitize）

### 隐私与安全

**注意**：诊断包可能包含本机绝对路径（Installations 的可执行文件 **realpath** 与日志上下文中的路径）——这是本机自诊的必需信息，属同机用户边界，**请勿把诊断包发到公开渠道**。

诊断包**绝不包含**：
- prompt 正文
- 模型输出
- token
- Cookie
- API Key
- 环境变量

入环的 warn/error 日志已对 `token=`、`Cookie:`、`"api_key":` 等秘密形态的**值**统一脱敏为 `[redacted]`。

## Squad / Review 过程观察

观察 **squad / review** 过程需要 Host 读 `COUNCILKIT_HOME/runs` sidecar。

### 关键点

- `councilkit review` / `apply` / `fix`（Autonomous Run）不经 Host 跑 agent，但浏览器打开 `http://127.0.0.1:43127/reports/<runId>` 必须有 Host
- 前台 `pnpm dev` 被杀 ≠ 观察消失——launchd 托管的 Host 仍应响应 `GET /api/v1/cli-runs/ck-squad-…`
- Host 未起时 observe 写盘不失败；浏览器打开失败会提示「Host 未在 127.0.0.1:43127」，不是空白页

### Squad Observe

`ck-squad-<uuid>` / `kind=squad` 是外部 `squadctl --observe` 写入的只读 sidecar（同一 `COUNCILKIT_HOME/runs`）：

- Host 不读 `.squad/`、不 spawn `squadctl`、不对 squad run 提供 fix/re-review
- 报告页走席位过程 + 只读 `handoff` 块 + sidecar 里的 brief/plan/评审/final，不走修复管线
- 旧 sidecar `interrupted` + 全席终态 + `phase≠done` 读时映射为 `awaiting_orchestrator`（「等待编排」）；显式收工为 `closed`（「已收工」）

看过程需要 Host（`pnpm start` 或 launchd）；前台 `pnpm dev` 被杀 ≠ 观察消失。

### Durable Result

`GET /api/v1/cli-runs/:runId/attempts/:attemptId/result` 返回当前执行的 durable 全文（`executionRef/executionStatus/availability/markdown/truncated/failure/reusedFrom`；identity 推导见 `shared/runtime/execution-ref.ts` 与 `docs/verification/2026-09-20-b0-execution-identity.md`）。kind=review 的报告页是固定席位工作台（三栏 + 单一 selectedAttempt），单席「报告」轴只认该端点，不认 live 正文； Aggregator 用 `attemptId="aggregator"`。

## 常见问题

### Q: Host 启动失败，提示端口 43127 被占用

**A**: 使用 `lsof -nP -iTCP:43127 -sTCP:LISTEN` 找到占用进程并终止，然后重新启动。

### Q: launchd 托管的 Host 频繁重启

**A**: 
1. 检查日志：`~/Library/Logs/CouncilKit/host.err.log`
2. 确认端口 43127 没有被其他进程占用
3. 确认 Node.js 版本为 22（其他主版本会拒绝启动）
4. 如果更换了 Node 版本或移动了仓库，重跑 `node scripts/install-service.mjs`

### Q: 更换 Node 版本后 Host 无法启动

**A**: plist 固定了 Node 路径，必须重跑安装脚本：

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.councilkit.host.plist
node scripts/install-service.mjs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.councilkit.host.plist
```

### Q: CLI 提示退出码 3（Host unreachable）

**A**: 
1. 确认 Host 正在运行：`curl http://127.0.0.1:43127/api/v1/health`
2. 如果 Host 未运行，启动它：`pnpm start` 或检查 launchd 状态
3. 确保 CLI 与 Host 是同一 checkout（版本绑定）

### Q: 浏览器打开报告页显示「Host 未在 127.0.0.1:43127」

**A**: 
1. Host 需要运行才能查看报告：`pnpm start` 或确认 launchd 托管生效
2. 即使 `councilkit review` 不需要 Host，查看报告仍然需要
3. 确认 Host 健康：`curl http://127.0.0.1:43127/api/v1/health`

### Q: Settings 页显示某个 Installation 不可用

**A**: 
1. 确认对应 CLI 已安装并在 PATH 中：`which cld` / `which kimi` 等
2. 确认已登录：`cld login` / `kimi login` / `grok login` / `cursor-agent login`
3. 重启 Host 让它重新发现 Installations
4. 查看诊断包中的 Installation 详情

### Q: 如何完全卸载 CouncilKit

**A**: 
1. 卸载 launchd 服务（见上）
2. 删除数据目录：
   - 浏览器数据：Chrome 的 Application → IndexedDB → `http://127.0.0.1:43127`
   - CLI 数据：`~/.config/councilkit/`
3. 删除日志：`~/Library/Logs/CouncilKit/`
4. 删除仓库目录

## 另见

- [CLI 手册](cli-handbook.md) — 完整命令参考与退出码
- [Runtime Host 设计](runtime-host-design.md) — Host 的详细设计文档
- [架构决策记录](adr/) — Host 相关的架构决策
