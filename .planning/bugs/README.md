# Bug Tickets (.planning/bugs/)

本目录记录由 **bug-hunter**(`~/code/me/squad/bug-hunter`)在 CouncilKit 仓库上扫描发现、并经 validator 独立证伪后仍 **CONFIRMED** 的真实缺陷。每张 ticket 是一份可交接的修复工单,目标读者是接手修复的 squad。

## 每张 ticket 包含

- **Bug 描述** + 根因 + 代码位置(file:line)
- **复现步骤**(static-proof 或 dynamic)
- **验收方法**(acceptance criteria)——修复后须全部 PASS
- **修复方向**(suggested fix,非强制)
- **证据链**(evidence,引用实际读取的代码/测试)
- **追溯**:bug-hunter `scan_id` + `fingerprint` + 对应 `engineering-handoff` JSON

## 修复流程(接手 squad)

1. 用 `/gsd-debug` 进入此 ticket(或新建 phase 引用 ticket)。
2. 修复须满足该 ticket 的全部 acceptance criteria。
3. 修复后跑 acceptance criteria 对应的定向门 + 现有 `tests/host/runtime-host.test.ts`。
4. 闭环后在本 ticket 顶部标注 `Status: FIXED @ <sha>`,并保留 ticket 用于追溯。

## 目标 squad

bug-hunter 的 `engineering-handoff` schema 当前把 `assignment.target_squad_name` 硬编码为 `squad-engineering-codex`(见 `squad/bug-hunter/schemas/engineering-handoff.schema.json:113`)。本仓库的修复 squad 为 **claude-only**(用户要求),所以 ticket 的 `target_squad` 字段以本目录 Markdown 为准(handoff JSON 的 codex 字段是 schema 约束遗留,待 bug-hunter 后续参数化)。

## 与 bug-hunter 的关系

- bug-hunter `finalize.py` 在 validator `CONFIRMED` 时生成 `engineering-handoff` artifact(JSON,机器可读)。
- 本目录 `<candidate_id>.md` 是同一 bug 的人/squad 可读 ticket,`.handoff.json` 是对应机器可读 handoff。
- bug-hunter 默认 `--publish-mode shadow` 不自动写入目标项目;本目录由 Orchestrator 根据用户指示手动落地,作为"shadow → 项目内 ticket"的桥梁。
