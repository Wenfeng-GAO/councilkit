---
name: verify-councilkit
description: "Drive the CouncilKit Runtime Host UI and councilkit CLI on an isolated port, capture proof, and run the unattended pre-merge gate (install if needed, typecheck, baseline-relative lint, baseline-relative test, build, baseline-relative Playwright when src or UI changes). Use before a night-time auto-merge, when a hunt routine must prove a commit, or when an agent needs to launch, doctor, and exercise CouncilKit."
---

# Verify CouncilKit

CouncilKit is a local-first multi-agent decision app. Verification drives two surfaces:

- The browser UI served by the Runtime Host (home, settings, reports, new Council).
- The `councilkit` CLI (`init`, `doctor`, `council`, `runs`, `review`, and the other commands in `cli/src/main.ts`).

Browser data (IndexedDB) and CLI data (`COUNCILKIT_HOME`) do not mix. Autonomous commands such as `review`, `apply`, `fix`, `repair`, and `ideate` spawn real agent processes. This skill does not start them.

Run every command from the repo root of an isolated worktree. The shared checkout is `/workspace/councilkit`.

**Merge only when `scripts/gate.sh` exits 0, the PR body Verify section shows CI green for that SHA, and no unresolved Codex P1 remains on the latest commit. Otherwise leave the PR open and report.** The gate does not merge, does not query CI, and does not clear a Codex P1. A dirty worktree is recorded in `summary.json`; that exit code is not proof of `HEAD` alone.

## Isolation

- Bind a free loopback port other than **43127**. The product only honors `COUNCILKIT_PORT` when `COUNCILKIT_E2E=1` (`runtime-host/config.ts`). Anywhere else the host refuses to move off `http://127.0.0.1:43127`.
- Put the host data in a fresh `COUNCILKIT_HOME` under `/tmp/verify-councilkit.*`. Cleanup deletes that directory. It does not touch `~/.config/councilkit`.
- Node.js **22.x** is required (`SUPPORTED_NODE_MAJOR` in `shared/runtime/contracts.ts`). Scripts prepend a Node 22 binary from `COUNCILKIT_NODE`, then `PATH`, then `/home/box/.local/node/bin/node` when that file is Node 22, then `~/.nvm/versions/node/v22.*/bin/node`.
- If this repo's toplevel is `/workspace/councilkit` and any other process has that tree as its cwd, `launch.sh`, `doctor.sh`, `drive.sh`, `cleanup.sh`, and `gate.sh` exit 2 before they create `artifacts/verify/`. They do not install, build, bind, or signal anything.
- `node_modules` and `cli/node_modules` may be symlinks into another checkout. The gitignore rule `node_modules/` matches directories only, so those symlinks show up as untracked. The gate records them in `externalNodeModules` and does not count them as source dirt. It never runs `pnpm install` while either symlink resolves outside this worktree. When the lockfile is newer than that outside tree, the install step fails instead of rewriting the other checkout.
- Cleanup signals only the recorded supervisor and the child tree whose cwd is still this repo and whose process start time is unchanged. Launch stores that supervisor start time next to the PID. A reused PID, whose start time no longer matches, is not signaled. It never uses `pkill`, `killall`, or a process-name match. It never signals whatever is listening on 43127.
- `pnpm test` binds 43127 inside `tests/host`. The gate records the listener and leaves it alone. A failure caused only on this run, and absent from the merge-base set, still fails the test step.
- The e2e step also stays off 43127. Specs that require that port are not proven by the isolated run. They are covered only by the baseline comparison described in Pre-merge gate.

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

- The supervisor PID is still the `host-supervise.mjs` process this launch started, with cwd at this repo and the same recorded start time.
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
.cursor/skills/verify-councilkit/scripts/drive.sh new-council
.cursor/skills/verify-councilkit/scripts/drive.sh cli-init
```

UI drives use Playwright Chromium (headless, viewport 1440×900) against the isolated origin. Selectors are roles and accessible names from `src/`. `cli-init` runs the real CLI:

```bash
pnpm exec councilkit init --json
pnpm exec councilkit council list --json
```

with `COUNCILKIT_HOME` pointed at the evidence directory for that feature. `cli/dist/main.mjs` must exist (`pnpm build:cli`, also performed by `pnpm build`).

Do not click `开始审查`, do not submit the ideate form, and do not run `review`, `run`, `fix`, `apply`, or `repair` from this skill. Those paths spawn agents.

`new-council` on a fresh origin stops on the Execution Profile gate and exits 2 for sub-feature `new-council-create`. That is an unmet precondition, not a pass. `cli-init` exits non-zero when PATH has none of `cld`, `kimi`, `grok`, or `cursor-agent`. Do not weaken either journey.

## Evidence

Proof goes to `artifacts/verify/<full git SHA>/`. Cleanup never deletes that directory.

| Path | Contents |
| --- | --- |
| `doctor.json` | Ready check, origin, SHA, node, host instance id. No cookie or CSRF. |
| `host.log` | Runtime Host stdout and stderr, including `host.started`. |
| `run-state.json` | Supervisor PID, supervisor start time, port, mode, scratch path, SHA. |
| `cleanup.json` | PIDs signaled and whether scratch was removed. |
| `drive/<feature>/` | Screenshots, ARIA snapshot, `transcript.json`. |
| `summary.json` | Gate pass/fail per step, SHA, dirty paths, merge rule. Lint step records `headDiagnostics` and `baselineDiagnostics`. Test and e2e steps record `headFailed` and `baselineFailed`. |
| `logs/` | One log per gate step. The e2e step also writes `logs/playwright.json`. |
| `e2e/` | Copy of `test-results` (screenshots and traces) and `playwright-report` when those directories exist. The realistic UI evidence is `drive/home-landing/`, attached whenever the e2e step runs. |

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
3. Baseline-relative Biome lint (`scripts/lint-baseline.mjs`). Plain `pnpm lint` is not the gate. `origin/main` already has on the order of 204 Biome errors, so a full `biome check` of the lint paths fails before this branch changes a file. The step takes every path changed versus the merge-base with `origin/main` (working tree versus that commit, plus untracked files; `git diff -M` keeps renames paired). It keeps paths `pnpm lint` would check — `src/`, `shared/`, `runtime-host/`, `tests/`, `scripts/`, `cli/`, `playwright.config.ts`, and `playwright.review-explainer.config.ts` — when the extension is one Biome lints (`.js`, `.jsx`, `.cjs`, `.mjs`, `.ts`, `.tsx`, `.cts`, `.mts`, `.json`, `.jsonc`, `.css`). It skips `node_modules`, `dist`, `dist-host`, `coverage`, `tests/fixtures`, `test-results`, and `playwright-report`. It runs `biome check --reporter=json --max-diagnostics=none --diagnostic-level=error` on the working-tree bytes, then again on the merge-base blobs of those paths (`git cat-file` into a temp directory that contains the merge-base `biome.json`). The step fails when a file's error-diagnostic count is higher than at the merge-base, or when a file that did not exist at the merge-base has any error diagnostic. Warnings are not counted, which matches `biome check` without `--error-on-warnings`. A file that trades one error for a different error, with the count unchanged, does not fail. Both totals are recorded on the lint step as `headDiagnostics` and `baselineDiagnostics`. No lint-scoped diff records 0 and 0 and passes. When `biome.json` or `biome.jsonc` changes, the step compares the full lint scope, not an empty pair list. Node 22 is required; `verify_init` puts it on `PATH`, and this script exits 1 when `process.versions.node` is not 22.
4. Baseline-relative Vitest (`scripts/test-baseline.mjs`). The suite is the same one `pnpm test` runs (`vitest run`, includes from `vitest.config.ts`: unit, host, integration, and `cli/tests`). The command is `pnpm exec vitest run --reporter=default --reporter=json`. Before the suite it records who is listening on 43127 and does not signal them. A failing name is `<repo-relative file> :: <suite > test>`, with empty ancestor titles dropped. A suite that fails to load is `<file> :: <suite failed>`. The step fails only when HEAD's set contains a name the merge-base set does not. Failures that already fail on the merge-base stay green for this gate, including environment failures in `tests/host/installation-registry`, `cli/tests/fix-command` probe tests, `review-title-format`, and `review-explainer-skip` / `review-explainer-repair-export` when this machine still produces them. Both counts are recorded on the test step as `headFailed` and `baselineFailed`, plus `newFailures`. The merge-base set is cached at `artifacts/verify/baseline-<merge-base SHA>/failing-tests.json` (raw report in `vitest.json` beside it). A cache file is reused only when `mergeBase` is that SHA and `node` equals the full `process.version`. Delete the directory to force a new baseline run. On a cache miss, a product-file diff runs Vitest in a detached `git worktree` at the merge-base. When `pnpm-lock.yaml` matches this worktree, `node_modules` and `cli/node_modules` are copied in; otherwise the worktree runs `pnpm install --frozen-lockfile` and this checkout is left alone. The worktree is removed when that run finishes. When no product file differs, the HEAD run is the baseline and is written to the cache. Product files are every changed path except `.cursor/`, `artifacts/verify/`, and `.gitignore`. The HEAD side is the working tree. The raw HEAD report is `logs/vitest.json`. Node 22 is required the same way as lint.
5. `pnpm build` (`tsc --noEmit`, Vite, `dist-host`, and `cli/dist`).
6. Baseline-relative Playwright (`scripts/e2e-baseline.mjs`) when the diff touches src or UI, then the home-landing screenshot drive.

The diff is `merge-base(HEAD, origin/main|main|master)...HEAD`, plus unstaged, staged, and untracked files. UI means any path under `src/`, `public/`, `runtime-host/`, `shared/`, `tests/e2e/`, or the files `index.html`, `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, and `playwright*.config.ts`. No merge-base means the e2e baseline cannot be computed (exit 2, fail closed). `--force-e2e` runs the step even when the diff is docs-only.

The command is `pnpm exec playwright test -c <config> --reporter=json`. `PLAYWRIGHT_JSON_OUTPUT_FILE` is `logs/playwright.json`, so the JSON reporter writes that file and Playwright adds its stdio reporter (line, or dot when `CI` is set) to the log. Screenshots and traces still follow the Playwright config (`trace: retain-on-failure`, and `screenshot: only-on-failure` where a config sets it). Before the run, `test-results/` and `playwright-report/` in the repo are removed so the copy is this run. They are then copied to `e2e/test-results/` and `e2e/playwright-report/`. A failing id is `<repo-relative file> :: <title path>`. The title path is the describe titles plus the test title. Empty titles and the file-suite title (Playwright sets it to the file path) are dropped. When the report contains more than one project, the id ends with ` [<project>]`. A skipped test, including one Playwright did not run after an earlier failure in the same file, is not a failing id. The step fails only when HEAD's set contains an id the merge-base set does not. Playwright's own exit code does not fail the step. Both counts are recorded on the e2e step as `headFailed` and `baselineFailed`, plus `newFailures`. The merge-base set is cached at `artifacts/verify/baseline-<merge-base SHA>/failing-e2e.json` (the worktree's raw report is `playwright.json` beside it). A cache file is reused only when `mergeBase` is that SHA, `node` equals the full `process.version`, and `suiteKey` is `<config>@<port mode>` for this run. Delete the file to force a new baseline run. On a cache miss, a product-file diff runs the same Playwright command in a detached `git worktree` at the merge-base. When `pnpm-lock.yaml` matches this worktree, `node_modules` and `cli/node_modules` are copied in; otherwise the worktree runs `pnpm install --frozen-lockfile` and this checkout is left alone. The worktree is removed when that run finishes. When no product file differs, the HEAD run is the baseline and is written to the cache. Product files are every changed path except `.cursor/`, `artifacts/verify/`, and `.gitignore`. The HEAD side is the working tree. Node 22 is required the same way as lint.

Config choice:

- `src/` or a broad UI change, and `--force-e2e`: `playwright.config.ts` with `COUNCILKIT_E2E_PORT` set to a free port (`suiteKey` `playwright.config.ts@isolated`). Playwright's `reuseExistingServer` stays off, so a developer's host on 43127 is not reused or killed. The gate never passes port 43127.
- Only `tests/e2e/review-explainer/` or `playwright.review-explainer.config.ts`: `playwright.review-explainer.config.ts` (fixed port 43839, `suiteKey` `playwright.review-explainer.config.ts@fixed:43839`).
- Only `tests/e2e/repair-observability/`: `playwright.repair-observability.config.ts` (fixed port 43837).
- Only `tests/e2e/repair-panel-ui.spec.ts`: `playwright.repair-ui.config.ts` (fixed port 4188).
- Only `tests/e2e/finding-ledger-layout.spec.ts`: `playwright.preview.config.ts` (fixed port 4179).

Fixed ports that are already taken fail the step. The gate does not kill the occupant.

E2E specs that require port 43127 cannot be proven by the isolated gate. They are covered only by this baseline comparison. Security tripwires that hard-require `http://127.0.0.1:43127`, repair-observability and review-explainer specs when the default config serves them, and clipboard reads that throw `NotAllowedError` already fail on `origin/main` when the suite is pointed at any other port. Those failing ids are in the merge-base set, so they do not fail this gate. An id that is not in that set still fails it.

Whenever the e2e step runs, including when Playwright exits non-zero and every failing id was already in the baseline, the gate then runs `launch.sh --production`, `doctor.sh`, `drive.sh home-landing`, and `cleanup.sh`. Those screenshots are the realistic UI evidence (`drive/home-landing/01-home.png` and `02-review-composer.png`), the built UI on a non-canonical port. A failed screenshot drive fails the step.

Each step appends to `artifacts/verify/<sha>/summary.json` with `pass`, `fail`, or `skip`, the exit code, the log path, and the git SHA. The lint step also stores `headDiagnostics` and `baselineDiagnostics`. The test and e2e steps also store `headFailed`, `baselineFailed`, and `newFailures`. The process exits with the failing step's code. Exit 0 rewrites `summary.json` with `"ok": true`.

The test baseline cache is `artifacts/verify/baseline-<merge-base SHA>/failing-tests.json`. The e2e baseline cache is `failing-e2e.json` in that same directory. Cleanup never deletes either. `artifacts/verify/` is gitignored.

## Hunt routine usage

Run the gate from the isolated worktree that contains the commit to prove. The script changes to the repo root.

```bash
.cursor/skills/verify-councilkit/scripts/gate.sh
.cursor/skills/verify-councilkit/scripts/gate.sh --force-e2e
```

`--force-e2e` runs Playwright even when the diff does not touch src or UI.

The e2e step is baseline-relative, the same way the test step is. Playwright's raw exit code does not fail the gate. The step fails when the JSON report is missing or unusable (exit 2), or when a failing id (`<file> :: <title path>`) is absent from `artifacts/verify/baseline-<merge-base SHA>/failing-e2e.json` (exit 1). When the product tree equals the merge-base, that HEAD run is written as the baseline. E2E specs that require port 43127 cannot be proven by the isolated gate. Security tripwires that hard-require `127.0.0.1:43127`, repair-observability and review-explainer specs served under the default config, and clipboard `NotAllowedError` failures are covered only by that baseline comparison. Whenever the e2e step runs, the home-landing drive screenshots are attached as the realistic UI evidence, including when the only Playwright failures are already in the baseline.

Exit codes:

| Exit | When |
| --- | --- |
| 0 | Every step passed or was skipped. `artifacts/verify/<sha>/summary.json` has `"ok": true`. |
| 1 | A step failed (typecheck, new lint diagnostics, new test failures, build, new e2e failures, screenshot drive, install, or a fixed e2e port already in use), or Node.js is not 22.x. Step failures write `summary.json` with `"ok": false`. A missing Node 22 binary exits before any evidence directory is created. |
| 2 | The gate refused to start, or a baseline could not be produced. Not the councilkit repo, the shared checkout held by another process, and an unknown argument all exit before `summary.json` exists. No merge-base with `origin/main`, or Biome, Vitest, or Playwright failing to write a usable report, writes `summary.json` with `"ok": false` and exits 2. |

`summary.json` lands at `artifacts/verify/<full HEAD SHA>/summary.json`. The SHA is `git rev-parse HEAD` at the start of the run.

Merge only when all three are true for the latest commit on the PR:

1. `gate.sh` exits 0 and that SHA's `summary.json` has `"ok": true`.
2. The PR body has a Verify section and CI is green for that same SHA.
3. No unresolved Codex P1 remains on that commit.

If any condition is false, leave the PR open and report which condition failed. The gate does not merge, does not query CI, and does not clear a Codex P1.

When `summary.json` has `"dirty": true`, exit 0 is not proof of `HEAD` alone. Commit and run the gate again before merging. Do not run the gate in `/workspace/councilkit` while any other process has that checkout as its cwd; the gate exits 2 in that case.

## Helpers

| Script | Role |
| --- | --- |
| `scripts/launch.sh` | Start `pnpm dev` or `pnpm start` on a free port. |
| `scripts/doctor.sh` | Read-only ready check. |
| `scripts/drive.sh <feature>` | One feature recipe. |
| `scripts/cleanup.sh` | Stop the recorded host. Keep evidence. |
| `scripts/gate.sh` | Pre-merge gate. |
| `scripts/lint-baseline.mjs` | Biome counts for changed files at HEAD and at the merge-base. |
| `scripts/test-baseline.mjs` | Vitest failing-name diff against the cached merge-base set. |
| `scripts/e2e-baseline.mjs` | Playwright failing-id diff against the cached merge-base set. |
| `scripts/baseline-lib.mjs` | Comparison helpers. `node scripts/baseline-lib.mjs --self-test` checks them. |
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
