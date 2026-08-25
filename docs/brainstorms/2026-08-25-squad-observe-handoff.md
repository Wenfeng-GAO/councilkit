# Pointer: Squad observe / 收工态 / live 过程

正文在 skill 仓，避免两份 drift：

`~/code/ant/hengzhuo-personal-skills/hengzhuo-engineering-squad/docs/2026-08-25-observe-loop-handoff.md`

本仓要动的面（详见正文 P0-A、P0-B、P1）：

- `shared/runtime/schemas.ts` — `awaiting_orchestrator` / `closed`，可选 `handoff` 块
- `src/app/pages/ReportsPage.tsx` / `ReportDetailPage.tsx` / `components/report/LiveReviewProgress.tsx`
- `src/lib/live-transcript.ts` — lastActivity、时长、fold
- Host 常驻（launchd / 现有 watchdog），前台 `pnpm dev` 被杀 ≠ 观察消失

Host 仍只读 `COUNCILKIT_HOME/runs/ck-squad-*`，不读 `.squad/`、不 spawn `squadctl`。
