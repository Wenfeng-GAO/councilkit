# 采用本地 Runtime Host 作为模型执行边界

CouncilKit 保留浏览器 UI 与本地讨论数据，但所有模型执行均由仅限本机访问的 Runtime Host 承担。V1 只实现 `claude-stream-json` 与 `codex-app-server` 两个 Runtime Driver：Ant GLM5.2、Kimi 和 DeepSeek 分别经 `cld ant glm5.2`、`cld moonshot` 与 `cld deepseek` 执行，Codex 经官方 `app-server` 协议执行。认证模式统一称为 `installation-managed`：Codex 或 `cld` Installation 自行解析本机凭据，Host 不读取秘密；V1 不提供 HTTP Driver、API Key 或 macOS Keychain 配置。

V1 正式只支持 macOS。Host 是用户主动启动的单一 Node.js/TypeScript 前台进程，以固定 canonical origin 同时提供构建后的 Web UI、同源 JSON API 与可恢复事件流，退出时终止其子进程。V1 不引入 LaunchAgent 常驻服务、Tauri/Electron 桌面壳，也不复用 Multica daemon；Host 不可用时不回退到浏览器直连，现有 Gateway 仅作为 legacy 数据保留且不参与执行。该决定替代原有“纯客户端、无本地服务”的约束；各协议仍隔离在可替换的 Runtime Driver 后面，未来可以独立增加 HTTP Driver 和系统密钥存储。
