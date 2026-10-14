# Reports library

The reports library lists CLI runs for this `COUNCILKIT_HOME` and offers a search box plus case-status filters. A verification launch uses an empty home, so the library shows its empty state.

## Sub-features

- `reports-open` shows the library heading and the review composer.
- `reports-empty` shows the empty-library copy when no runs exist.
- `reports-search` accepts a query in `搜索报告` without leaving the page.
- `reports-filter` toggles the `全部案件` status filter.

## How to get to it (user POV)

- Choose `查看审查案件` or `打开报告库` on the home landing.
- Choose `报告` in the sidebar.
- Open `/reports` on the Runtime Host origin.

## Driving it with verify-councilkit

Preconditions:

- `launch.sh` has printed an origin and `doctor.sh` exited 0.
- That launch's `COUNCILKIT_HOME` has no `runs/` entries, which is true for a home the launch script just created.

- **Open the library.** Load `/reports`. Run `.cursor/skills/verify-councilkit/scripts/drive.sh reports-library`. The heading `审查与报告` and the heading `发起 PR 审查` are visible.
- **Empty state.** The text `第一份报告，从一个 PR 开始` is visible. `drive/reports-library/01-empty-library.png` shows it.
- **Search.** Fill the searchbox named `搜索报告` with `verify-no-such-run`. The same empty copy stays visible because there are no runs to filter. `drive/reports-library/02-search-empty-library.png` shows the query.
- **Status filter.** Choose the button whose name contains `全部案件`. Its `aria-pressed` becomes `true`.
- **Proof.** `drive/reports-library/transcript.json` and `reports.aria.txt` record the three actions.

## Gotchas

- With zero runs, a search does not switch the copy to `没有找到匹配案件`. That sentence is for a non-empty home whose current filter matches nothing. Do not treat the empty-home copy as a failed search.
- The default status filter is `需要处理` (`aria-pressed` starts `true` on that button).
- Filling a PR URL and choosing `开始审查` starts a real review. This recipe does not do that.
- The library reads CLI runs through the Host. A wrong `COUNCILKIT_HOME` shows another user's runs. Doctor and launch must be the same state file.
