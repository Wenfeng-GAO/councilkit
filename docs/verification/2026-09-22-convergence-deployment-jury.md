# 控制协议部署与默认 jury 配置

已将验收候选 `3892dc16df76d3d52a0385c1428990a387dc5341` 快进合并到 main，完整 pnpm build 通过并推送 origin/main，远端 SHA 已核对。通过现有 com.councilkit.host LaunchAgent 重启；Host instance 从 48167fb0-5c71-4a85-949d-25b3176df6d1 变为 b1787560-9dae-4bbd-981c-5a178e140724，健康检查通过，前端产物可访问。

## 默认 PR jury

- 原 Grok 对抗审查/Reporter 席：改用 cursor-stream-json，模型参数 `grok-4.7[context=500k,reasoning_effort=xhigh,fast=false]`。最小只读请求返回 OK，启动回执为 **Grok 4.7 500K Extra High**。
- cfuse 席：配置为 `glink/GLM-5.3:glink_domestic[1m]`。通过与当前 autonomous driver 一致的 cld cfuse 调用验证，实际启动模型相同，返回 OK。当前 cfuse autonomous 调用跟随 route 默认模型；本次实测与保存的席位配置一致。
- 其余 Cursor auto、Codex gpt-6-astra、Kimi k3 席及 Reporter agent ID 不变。只修改 pr-jury 的 agentOverrides，未修改共享 Agent 定义或 product-jury。
- 当前 revision：071ca0a9aacc1d5dfffd8dfe895e27d68b479f7e319c5b6251000744cd6b2683。

后续操作入口：http://127.0.0.1:43127/reports → 调整席位 → 保存默认席位。参数化 500K 模型已保存，页面会保留并显示当前选择；普通 grok-4.7-xhigh 列表项为 256K，不能替代这个参数化值。CLI 查看：`pnpm exec councilkit jury show --json`。CLI 更新：通过 `jury save --config` 提交最新 revision、完整 seats 和 reporterAgentId；不要用 init --force 调整，避免重置已有覆盖配置。

本次只影响后续默认 PR 审查；已运行任务不改。默认 repair profile/v2 opt-in 设置没有另行改变。

持久回滚资料：`/Users/hengzhuo/.config/councilkit/backups/20260922-jury-grok47-glm53/`。恢复时以 jury-before.json 中 seats/reporter 配合实时新 revision 调用 jury save；不要盲目覆盖整个 councils 文件，以免覆盖随后其他 Council 的修改。

机器回执与构建/模型探针日志：`/tmp/councilkit-deploy-20260922/`。本报告为部署后本地记录，未额外提交到远端。
