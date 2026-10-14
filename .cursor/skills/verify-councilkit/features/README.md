# CouncilKit verification map

This directory is the maintained source for verifying the user-facing behavior of CouncilKit. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Use an isolated git worktree. Refuse the run when the toplevel is `/workspace/councilkit` and another process has that tree as its cwd.
- Launch with `.cursor/skills/verify-councilkit/scripts/launch.sh` so the Runtime Host binds a free port other than 43127.
- The launch script sets `COUNCILKIT_E2E=1`, `COUNCILKIT_PORT`, and a private `COUNCILKIT_HOME` under `/tmp/verify-councilkit.*`.
- Node.js 22.x is on `PATH` (the scripts resolve one; see the skill).
- Run `.cursor/skills/verify-councilkit/scripts/doctor.sh` and require exit 0 before any UI recipe.
- Playwright Chromium is installed for the repo (`pnpm exec playwright install chromium`).
- Never drive a Host this verification run did not start. `councilkit doctor` talks only to `http://127.0.0.1:43127` and is not a substitute for `doctor.sh`.

## Driving conventions

- Start every UI recipe from the fresh origin `launch.sh` printed. IndexedDB for that origin is empty.
- Prefer ARIA roles and accessible names. The recipes below use the strings in `src/`.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run UI actions through `.cursor/skills/verify-councilkit/scripts/drive.sh <feature-id>`.
- Run the CLI init journey through `.cursor/skills/verify-councilkit/scripts/drive.sh cli-init`.
- Do not click `开始审查` and do not start `review`, `run`, `fix`, `apply`, `repair`, or `ideate`.
- Cleanup removes the host and the `/tmp` scratch home. It does not remove `artifacts/verify/<sha>/`.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with CouncilKit visible (document title and a real heading).
- CLI proof includes the command, stdout, stderr, and exit code, plus `council list --json` as a second view of the store.
- Record the feature id with every artifact under `artifacts/verify/<sha>/drive/<feature-id>/`.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-councilkit` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Home landing](./home-landing.md) opens `/` and follows `贴 URL 开审查` to the focused PR URL field.
- [Host settings](./host-settings.md) opens Settings and checks that this Host instance is online.
- [Reports library](./reports-library.md) opens the report library, search box, and case filters on an empty home.
- [New room](./new-room.md) opens the new-discussion gate. Creating a room needs Execution Profiles this fresh origin does not have.
- [CLI init](./cli-init.md) writes the default `pr-jury` council into a disposable `COUNCILKIT_HOME`.
