# Home landing

Home landing is the CouncilKit front door. It states the two ways to work (讨论 and 陪审) and sends the user to a PR review, the report library, a new room, or Host settings.

## Sub-features

- `home-open` shows the landing heading and the four primary links.
- `home-review-cta` opens the PR review composer and focuses the PR URL field.
- `home-reports-link` is the same destination as the sidebar `报告` link, reached here from `查看审查案件`.
- `home-room-link` is the landing path to `去新建房间`.
- `home-host-link` is the landing path to `检查 Host`.

## How to get to it (user POV)

- Open the Runtime Host origin. The document title is `CouncilKit` and the path is `/`.
- Choose `首页` in the sidebar when it is expanded (viewport at least 768px wide).
- Choose `贴 URL 开审查`, `查看审查案件`, `去新建房间`, or `检查 Host` on the landing page.

## Driving it with verify-councilkit

Preconditions:

- `launch.sh` has printed an origin and `doctor.sh` exited 0.
- The browser context is fresh, so this origin has no IndexedDB rooms.

- **Open home.** Load `/`. Run `.cursor/skills/verify-councilkit/scripts/drive.sh home-landing`. The heading matching `让模型互相看见` is visible, and the links `贴 URL 开审查`, `查看审查案件`, `去新建房间`, and `检查 Host` are visible. `drive/home-landing/01-home.png` shows that screen.
- **Open the review composer.** Choose `贴 URL 开审查`. The same command clicks that link. The URL matches `/reports#review`. The heading `发起 PR 审查` is visible. The textbox `#review-pr-url` (accessible name `PR URL`) is focused. The checkbox named `强制按 spec review` is visible. The button `开始审查` is visible and is not activated. `drive/home-landing/02-review-composer.png` and `02-review-composer.aria.txt` show that state.
- **Proof.** `drive/home-landing/transcript.json` records both actions, the origin, and `"ok": true`.

`查看审查案件`, `去新建房间`, and `检查 Host` are covered as their own features (`reports-library`, `new-room`, `host-settings`). This drive does not claim those deeper screens.

## Gotchas

- `开始审查` asks the Host to start a real review and can spawn local CLIs. Leave it unclicked.
- The default jury readout may say the CLI is not initialized. The composer still renders. A missing jury is not a failed landing.
- `councilkit doctor` does not observe this origin. Use `doctor.sh`.
- Sidebar `首页` is hidden while the sidebar is collapsed. The landing proof uses the page links at 1440×900, where the sidebar is open, and does not depend on the sidebar for the click.
