# CLI init

CLI init discovers local agent CLIs and writes the default councils `pr-jury` and `product-jury` into the CLI store. It does not use the Runtime Host.

## Sub-features

- `init-write` runs `councilkit init --json` and prints the councils it created or reused.
- `init-reread` runs `councilkit council list --json` and shows `pr-jury` from disk.
- `init-isolation` leaves the user's `~/.config/councilkit` (or `$XDG_CONFIG_HOME/councilkit`) unmodified.

## How to get to it (user POV)

- From a terminal at the repo root, run `pnpm exec councilkit init`.
- The home landing copies the same command as `councilkit init`.

## Driving it with verify-councilkit

Preconditions:

- `pnpm build:cli` has produced `cli/dist/main.mjs` (`pnpm build` does this too).
- PATH contains at least one of `cld`, `kimi`, `grok`, or `cursor-agent`. When none of them exist, init exits 2 and the journey fails with that reason.
- The drive sets `COUNCILKIT_HOME` to `artifacts/verify/<sha>/drive/cli-init/home`. It does not require `launch.sh`.

- **Write defaults.** Run `.cursor/skills/verify-councilkit/scripts/drive.sh cli-init`. That executes `pnpm exec councilkit init --json`. Exit code 0. Stdout is one JSON object whose `createdCouncil.name` or `reusedCouncil.name` is `pr-jury`. `drive/cli-init/init.stdout.json` and `init.stderr.txt` keep the streams.
- **Read them back.** The same command then executes `pnpm exec councilkit council list --json`. Exit code 0. The `councils` array includes an object whose `name` is `pr-jury`. `drive/cli-init/council-list.stdout.json` keeps that body.
- **Isolation.** The mtime of the user councilkit config directory is unchanged. `transcript.json` has `"touchedUserHome": false` and `"ok": true`.

## Gotchas

- Exit 2 with `no review drivers found on PATH` is a real failure. Do not mark init verified because the landing page displays the command string.
- `init` can also report `missingDrivers` for CLIs that are absent while still creating `pr-jury` from the CLIs it found. The pass condition is `pr-jury` in both stdout and `council list`, not a full five-seat roster.
- `--force` deletes existing `pr-jury` and `product-jury` in that home. This drive does not pass `--force`.
- The human line `open reports: http://127.0.0.1:43127/reports` is the canonical origin, not the isolated verification port. `--json` keeps that prose off stdout.
- Browser Settings Agents are a different store. A successful init does not add Agents to IndexedDB.
