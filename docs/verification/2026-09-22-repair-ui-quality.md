# 修复工作台 UI 质量修复

结论：已在本机部署并用用户提供的真实Run只读核对。UI修复提交 `eca18c9`；合入主分支现有模型选择改动后，部署提交 `c4f54038bb48c92764ce3f3347b852a113fe291b`。未推送远端：主分支含本轮之外的既有未推送提交。

## 修复

- kind=repair使用独立、填满可用视口的工作台，移除其下旧review 0/0与report.md缺失兜底。
- 标题从长URL改为可信PR短标识，URL保留为次要来源链接；缺目标不编造。
- 时间线采用中文动作、文件名和相对路径，原始命令/路径/执行身份在详情保留；未记时间用可访问占位符，不反复堆未知字样。
- 桌面活动区由200px扩大；原数据截图1440宽实际 495.5px，1280受控用例435.5px；窄屏筛选与角色选择可达。
- needs_attention按真实reasonCode映射，squad_failed不再假称独立评审额度不足；业务终态不伪造进程退出，残留active不声称角色正在活动。
- 完成项不冒充成功、未收尾记录明确标识；信息/建议抽屉、停止确认、验收列表与可访问焦点统一整理。

## 验证

59项聚焦UT/Host检查通过；50项相关浏览器E2E通过（不含与本轮UI改动无关的E56/E57大日志/时延指标）；完整typecheck/build通过。合入既有主分支改动后额外复跑真实工作台2项质量回归通过。旧测试中误把空“上下文”文案当覆盖、用宽泛正则匹配任意失败文字的断言已替换为明确UI语义；历史轮不再保留无效操作按钮。

真实页面只读复核：标题agentrun #128；显示修复执行失败/需要处理；无假额度告警、无重复本轮审查；列表无绝对HOME路径、无页面横向溢出；无JS异常；没有发送停止/恢复等mutation。

原有source-reader文件替换generation检测测试曾在核查中失败（reader.test.ts:123，相关实现/用例本轮未改），未计入本轮通过范围，未为美化UI修改其判定。此次未修复底层真实修复Run的执行失败或缺失时间戳；只如实显示已有证据。

## 图片与日志

- [修复前](/Users/hengzhuo/.codex/visualizations/2026/09/22/01a0c826-6330-77f3-88e9-b3fe01621538/repair-ui-fix/before-1440.png)
- [真实页面1440](/Users/hengzhuo/.codex/visualizations/2026/09/22/01a0c826-6330-77f3-88e9-b3fe01621538/repair-ui-fix/after-1440.png)
- [真实页面1280](/Users/hengzhuo/.codex/visualizations/2026/09/22/01a0c826-6330-77f3-88e9-b3fe01621538/repair-ui-fix/after-1280.png)
- [真实页面390](/Users/hengzhuo/.codex/visualizations/2026/09/22/01a0c826-6330-77f3-88e9-b3fe01621538/repair-ui-fix/after-390.png)

日志：`/tmp/councilkit-repair-ui-fix-20260922/final-unit.log`、`regression-e2e.log`、`integrated-typecheck.log`、`integrated-ui.log`、`deploy-build.log`、`live-after-quality.json`。前期外部执行器已按用户要求停止，终止时没有代码变更；后续UI由Codex直接完成，状态逻辑由一个受限子agent协助。没有继续使用delegated-build执行开发。
