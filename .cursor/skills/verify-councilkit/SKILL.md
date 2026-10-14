---
name: verify-councilkit
description: "Drive the CouncilKit Runtime Host UI and councilkit CLI on an isolated port, capture proof, and run the unattended pre-merge gate (install if needed, typecheck, lint, test, build, Playwright when src or UI changes). Use before a night-time auto-merge, when a hunt routine must prove a commit, or when an agent needs to launch, doctor, and exercise CouncilKit."
---

# Verify CouncilKit

CouncilKit is a local-first multi-agent decision app. Verification drives two surfaces:

- The browser UI served by the Runtime Host (home, settings, reports, new room).
- The `councilkit` CLI (`init`, `doctor`, `council`, `runs`, `review`, and the other commands in `cli/src/main.ts`).

Browser data (IndexedDB) and CLI data (`COUNCILKIT_HOME`) do not mix. Autonomous commands such as `review`, `apply`, `fix`, `repair`, and `ideate` spawn real agent processes. This skill does not start them.

Run every command from the repo root of an isolated worktree. The shared checkout is `/workspace/councilkit`.

**Auto-merge only when `scripts/gate.sh` exits 0 and CI verify is green for the same SHA and no unresolved Codex P1 remains.** The gate does not query CI and does not clear a Codex P1. A dirty worktree is recorded in `summary.json`; that exit code is not proof of `HEAD` alone.

## Isolation

- Bind a free loopback port other than **43127**. The product only honors `COUNCILKIT_PORT` when `COUNCILKIT_E2E=1` (`runtime-host/config.ts`). Anywhere else the host refuses to move off `http://127.0.0.1:43127`.
- Put the host data in a fresh `COUNCILKIT_HOME` under `/tmp/verify-councilkit.*`. Cleanup deletes that directory. It does not touch `~/.config/councilkit`.
- Node.js **22.x** is required (`SUPPORTED_NODE_MAJOR` in `shared/runtime/contracts.ts`). Scripts prepend a Node 22 binary from `COUNCILKIT_NODE`, then `PATH`, then `/home/box/.local/node/bin/node` when that file is Node 22, then `~/.nvm/versions/node/v22.*/bin/node`.
- If this repo's toplevel is `/workspace/councilkit` and any other process has that tree as its cwd, `launch.sh`, `doctor.sh`, `drive.sh`, `cleanup.sh`, and `gate.sh` exit 2 before they create `artifacts/verify/`. They do not install, build, bind, or signal anything.
- `node_modules` and `cli/node_modules` may be symlinks into another checkout. The gitignore rule `node_modules/` matches directories only, so those symlinks show up as untracked. The gate records them in `externalNodeModules` and does not count them as source dirt. It never runs `pnpm install` while either symlink resolves outside this worktree. When the lockfile is newer than that outside tree, the install step fails instead of rewriting the other checkout.
- Cleanup signals only the recorded supervisor and the child tree whose cwd is still this repo and whose process start time is unchanged. It never uses `pkill`, `killall`, or a process-name match. It never signals whatever is listening on 43127.
- `pnpm test` binds 43127 inside `tests/host`. If that port is taken, the test step fails. The gate records the listener and leaves it alone.

## Launch

Default launch is the documented dev server, which serves Vite and `/api/v1` on one origin:

```bash
.cursor/skills/verify-councilkit/scripts/launch.sh
```

That runs `pnpm dev` (`tsx runtime-host/main.ts`) with `COUNCILKIT_E2E=1`, a free `COUNCILKIT_PORT`, and a private `COUNCILKIT_HOME`. After `pnpm build`, the production bundle is:

```bash
.cursor/skills/verify-councilkit/scripts/launch.sh --production
```

That runs `pnpm start` (`node dist-host/main.mjs`) with the same isolation. It exits 1 when `dist-host/main.mjs` is missing.

Ready means all of the following, not merely an open socket:

- The supervisor PID is still the `host-supervise.mjs` process this launch started, with cwd at this repo.
- The listener on the chosen port is inside that process tree.
- Host stderr contains the JSON event `"event":"host.started"` (`runtime-host/main.ts`).
- `GET /api/v1/health` is `{ ok: true, data: { apiVersion: "v1", node: { major: 22 } } }`.
- `GET /` is HTTP 200 HTML with `<title>CouncilKit</title>`, `id="root"`, a `councilkit_session` cookie, and `<meta name="councilkit-csrf">`. Cookie and CSRF values are not written to evidence.

`launch.sh` prints the origin, for example `http://127.0.0.1:45907`. A second launch while doctor is healthy and the mode matches prints `already running` and does not start another host. A mode mismatch exits 2 until `cleanup.sh`. Port `PORT_IN_USE` retries up to five free ports. `UNSUPPORTED_NODE` does not retry.

`councilkit doctor` is not the launch probe. The CLI host client always uses `http://127.0.0.1:43127` (`cli/src/host/client.ts`).

## Doctor

```bash
.cursor/skills/verify-councilkit/scripts/doctor.sh
```

Read-only. Exit 0 prints `ready <origin> sha=<sha> node=<version> host=<hostInstanceId>` and writes `artifacts/verify/<sha>/doctor.json`. Exit 10 means the process exists and is not usable yet. Exit 1 means the PID, cwd, SHA, port, or health payload does not match this run. Run doctor before every UI drive and whenever the page looks wrong.

## Drive

Recipes live in `features/`. Read `features/README.md`, then one feature file. The harness is:

```bash
.cursor/skills/verify-councilkit/scripts/drive.sh home-landing
.cursor/skills/verify-councilkit/scripts/drive.sh host-settings
.cursor/skills/verify-councilkit/scripts/drive.sh reports-library
.cursor/skills/verify-councilkit/scripts/drive.sh new-room
.cursor/skills/verify-councilkit/scripts/drive.sh cli-init
```

UI drives use Playwright Chromium (headless, viewport 1440×900) against the isolated origin. Selectors are roles and accessible names from `src/`. `cli-init` runs the real CLI:

```bash
pnpm exec councilkit init --json
pnpm exec councilkit council list --json
```

with `COUNCILKIT_HOME` pointed at the evidence directory for that feature. `cli/dist/main.mjs` must exist (`pnpm build:cli`, also performed by `pnpm build`).

Do not click `开始审查`, do not submit the ideate form, and do not run `review`, `run`, `fix`, `apply`, or `repair` from this skill. Those paths spawn agents.

`new-room` on a fresh origin stops on the Execution Profile gate and exits 2 for sub-feature `new-room-create`. That is an unmet precondition, not a pass. `cli-init` exits non-zero when PATH has none of `cld`, `kimi`, `grok`, or `cursor-agent`. Do not weaken either journey.

## Evidence

Proof goes to `artifacts/verify/<full git SHA>/`. Cleanup never deletes that directory.

| Path | Contents |
| --- | --- |
| `doctor.json` | Ready check, origin, SHA, node, host instance id. No cookie or CSRF. |
| `host.log` | Runtime Host stdout and stderr, including `host.started`. |
| `run-state.json` | Supervisor PID, port, mode, scratch path, SHA. |
| `cleanup.json` | PIDs signaled and whether scratch was removed. |
| `drive/<feature>/` | Screenshots, ARIA snapshot, `transcript.json`. |
| `summary.json` | Gate pass/fail per step, SHA, dirty paths, merge rule. |
| `logs/` | One log per gate step. |
| `e2e/` | Copy of `test-results` and `playwright-report` when the e2e step runs. |

UI proof is a screenshot of the action's resulting screen plus the ARIA snapshot. The screenshot must show CouncilKit (the document title and a real heading such as `让模型互相看见` or `发起 PR 审查`). CLI proof is the command, stdout, stderr, and exit code, then a second command that reads the store (`council list --json`). The user config directory's mtime must be unchanged.

Mocks are limited to what the repo's own Playwright host already does (`tests/e2e/host-entry.mts` fake drivers, started only by `pnpm test:e2e`). Feature drives in this skill hit the real dev or production host, not `/api/v1/__test__`.

## Cleanup

```bash
.cursor/skills/verify-councilkit/scripts/cleanup.sh
```

Stops the recorded host, deletes `/tmp/verify-councilkit.*` from `run-state.json`, and leaves `artifacts/verify/<sha>/` on disk. Safe to run when nothing was started. After a failed launch, run cleanup before the next attempt so a half-started supervisor is not left behind.

Confirm survival with `test -f artifacts/verify/<sha>/drive/home-landing/02-review-composer.png` (or the transcript you just wrote) after cleanup.

## Pre-merge gate

```bash
.cursor/skills/verify-councilkit/scripts/gate.sh
.cursor/skills/verify-councilkit/scripts/gate.sh --force-e2e
```

`gate.sh` is fail-fast. It runs, in this order:

1. `pnpm install --frozen-lockfile` only when `node_modules/.bin` or `node_modules/.modules.yaml` is missing, or `pnpm-lock.yaml` is newer than `.modules.yaml`, and only when `node_modules` is a real directory inside this worktree. An outside symlink with a current lockfile is `skip`. An outside symlink that still needs an install is a failure. Otherwise a matching tree is `skip`.
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm test` (Vitest unit, host, integration, and `cli/tests`, per `vitest.config.ts`). Before the suite it records who is listening on 43127 and does not signal them.
5. `pnpm build` (`tsc --noEmit`, Vite, `dist-host`, and `cli/dist`).
6. Playwright when the diff touches src or UI, then a realistic screenshot drive.

The diff is `merge-base(HEAD, origin/main|main|master)...HEAD`, plus unstaged, staged, and untracked files. UI means any path under `src/`, `public/`, `runtime-host/`, `shared/`, `tests/e2e/`, or the files `index.html`, `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, and `playwright*.config.ts`. No merge-base means the e2e step runs (fail closed). `--force-e2e` runs it even when the diff is docs-only.

Config choice:

- `src/` or a broad UI change: `pnpm test:e2e` with `COUNCILKIT_E2E_PORT` set to a free port (Playwright's `reuseExistingServer` stays off, so a developer's host on 43127 is not reused or killed).
- Only `tests/e2e/review-explainer/` or `playwright.review-explainer.config.ts`: `pnpm test:e2e:review-explainer` (port 43839).
- Only `tests/e2e/repair-observability/`: `pnpm test:e2e:repair-observability` (port 43837).
- Only `tests/e2e/repair-panel-ui.spec.ts`: `pnpm exec playwright test -c playwright.repair-ui.config.ts` (port 4188).
- Only `tests/e2e/finding-ledger-layout.spec.ts`: `pnpm exec playwright test -c playwright.preview.config.ts` (port 4179).

Fixed ports that are already taken fail the step. The gate does not kill the occupant. After Playwright exits 0, the gate runs `launch.sh --production`, `doctor.sh`, `drive.sh home-landing`, and `cleanup.sh`. The screenshots are the built UI on a non-canonical port (`drive/home-landing/01-home.png` and `02-review-composer.png`).

Each step appends to `artifacts/verify/<sha>/summary.json` with `pass`, `fail`, or `skip`, the exit code, the log path, and the git SHA. The process exits with the failing step's code. Exit 0 rewrites `summary.json` with `"ok": true`.

### How a hunt routine invokes it

From the isolated worktree that contains the commit to merge:

```bash
.cursor/skills/verify-councilkit/scripts/gate.sh
```

Read `artifacts/verify/<sha>/summary.json`. Auto-merge only when all three are true:

1. `gate.sh` exited 0 and `summary.json` has `"ok": true` for that SHA.
2. CI verify is green for that same SHA.
3. No unresolved Codex P1 remains on the change.

Do not auto-merge when `summary.json` has `"dirty": true`. Commit first and run the gate again on a clean tree. Do not auto-merge from `/workspace/councilkit` while any other process has that checkout as its cwd; the gate exits 2 in that case.

## Helpers

| Script | Role |
| --- | --- |
| `scripts/launch.sh` | Start `pnpm dev` or `pnpm start` on a free port. |
| `scripts/doctor.sh` | Read-only ready check. |
| `scripts/drive.sh <feature>` | One feature recipe. |
| `scripts/cleanup.sh` | Stop the recorded host. Keep evidence. |
| `scripts/gate.sh` | Pre-merge gate. |
| `scripts/proc.mjs` | Port and PID lookup. `node scripts/proc.mjs self-test` checks listener detection. |
| `scripts/host-supervise.mjs` | Parent process cleanup is allowed to signal. |
| `scripts/doctor-check.mjs` | HTTP and identity check used by `doctor.sh`. |
| `scripts/drive.mjs` | Playwright and CLI driver used by `drive.sh`. |
| `scripts/cleanup.mjs` | Signal and scratch removal used by `cleanup.sh`. |
| `scripts/summary.mjs` | Writes `summary.json`. |

Shell entrypoints are the interface. The `.mjs` files expect `VERIFY_ENTRY=1`, which the shell scripts export after the shared-checkout check.

Machine precondition for UI drives and the e2e step: Chromium for the repo's Playwright (`pnpm exec playwright install chromium` once per machine). The gate does not download browsers itself.

## Maintenance

When routes, accessible names, or the verify commands change, update `features/` with `/maintain-verification-skill` and re-run one feature drive plus `gate.sh` on a clean commit.
