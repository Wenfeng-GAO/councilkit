import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  FINDING,
  PR_URL,
  ROUTES,
  RUN_ID,
  UI,
  prDecisionsPath,
} from "../../review-explainer/contract";
import { seedReviewRun } from "../../review-explainer/fixtures/seed-run";
import { createSyntheticRepo } from "../../review-explainer/fixtures/synthetic-repo";
import { installOriginAllowlist, openExplainer, resetCase, selectFinding } from "./helpers";

test.beforeEach(async ({ page }) => {
  await installOriginAllowlist(page);
});

function seedLastCommit(home: string) {
  const original = createSyntheticRepo(join(home, `comparison-${Date.now()}`));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", original.repo, ...args], { encoding: "utf8" }).trim();
  appendFileSync(join(original.repo, "README.md"), "LAST_COMMIT_ONLY_SENTINEL\n");
  git("add", "README.md");
  git("commit", "-m", "Last commit changes only documentation");
  const headSha = git("rev-parse", "HEAD");
  const diff = `${git("diff", "--no-color", "--no-ext-diff", original.mergeBaseSha, headSha, "--")}\n`;
  seedReviewRun(home, {
    repo: {
      ...original,
      headSha,
      diff,
      diffHash: createHash("sha256").update(diff).digest("hex"),
    },
  });
  return { ...original, fromSha: original.headSha, headSha };
}

test("filters preserve stable numbers, synchronize selection, and make empty results non-actionable", async ({
  page,
}) => {
  await resetCase(page);
  await openExplainer(page);
  await selectFinding(page, FINDING.stale);
  await page.getByLabel("严重程度", { exact: true }).selectOption("nit");
  const row = page.getByTestId(`review-explainer-finding-${FINDING.dup}`);
  await expect(row).toContainText("#3");
  await expect(page.getByTestId(UI.drawer)).toContainText("duplicate error string");
  await expect(page.getByRole("button", { name: "下一个问题", exact: true })).toBeDisabled();
  await page.getByLabel("搜索问题或文件", { exact: true }).fill("there-is-no-such-finding");
  await expect(page.getByTestId(/^review-explainer-finding-/)).toHaveCount(0);
  await expect(page.getByText(/没有匹配的问题/).first()).toBeVisible();
  for (const button of await page.getByTestId(UI.willFix).all())
    await expect(button).toBeDisabled();
  await page.getByLabel("搜索问题或文件", { exact: true }).fill("");
  await expect(row).toContainText("#3");
  await expect(page.getByTestId(UI.drawer)).toContainText("duplicate error string");
});

test("themes persist and preserve the selected code and details", async ({ page }) => {
  await resetCase(page);
  await openExplainer(page);
  await selectFinding(page, FINDING.busy);
  const root = page.getByTestId(UI.root);
  const theme = await root.getAttribute("data-theme");
  expect(["light", "dark"]).toContain(theme);
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  const changed = theme === "light" ? "dark" : "light";
  await expect(root).toHaveAttribute("data-theme", changed);
  await expect(page.getByTestId(UI.drawer)).toContainText("prompt accepted then busy");
  await page.screenshot({ path: test.info().outputPath(`workspace-${changed}.png`) });
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", changed);
  await selectFinding(page, FINDING.busy);
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(root).toHaveAttribute("data-theme", theme ?? "light");
  await page.screenshot({ path: test.info().outputPath(`workspace-${theme}.png`) });
});

test("optional notes are explicitly saved through the Host and survive reload without deciding repair", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  await openExplainer(page);
  await selectFinding(page, FINDING.busy);
  const notes = page.getByLabel("处理备注", { exact: true });
  await notes.fill("先补充并发反例，再决定是否修复。");
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(ROUTES.decisions(RUN_ID)) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存备注", exact: true }).click();
  expect((await saved).status()).toBe(200);
  const disk = JSON.parse(readFileSync(prDecisionsPath(seeded.home, PR_URL), "utf8"));
  expect(disk.items[FINDING.busy]).toMatchObject({
    decision: "undecided",
    audit: { reason: "先补充并发反例，再决定是否修复。" },
  });
  await page.reload();
  await selectFinding(page, FINDING.busy);
  await expect(notes).toHaveValue("先补充并发反例，再决定是否修复。");
  await selectFinding(page, FINDING.stale);
  await expect(notes).toHaveValue("");
});

test("last-commit shows the real frozen parent range, keeps out-of-range findings readable, and restores old anchors in full", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  const repo = seedLastCommit(seeded.home);
  await openExplainer(page);
  await selectFinding(page, FINDING.busy);
  const comparison = page.waitForResponse((r) => r.url().includes("/comparison?mode=last-commit"));
  await page.getByLabel("比较范围", { exact: true }).selectOption("last-commit");
  const result = (await (await comparison).json()).data;
  expect(result).toMatchObject({
    fromSha: repo.fromSha,
    toSha: repo.headSha,
    availability: "available",
  });
  expect(result.files.map((file: { path: string }) => file.path)).toEqual(["README.md"]);
  await expect(page.getByTestId(UI.identity)).toContainText(repo.fromSha.slice(0, 7));
  await expect(page.getByTestId(UI.diff)).toContainText("LAST_COMMIT_ONLY_SENTINEL");
  await expect(page.getByTestId(UI.drawer)).toContainText("prompt accepted then busy");
  await selectFinding(page, FINDING.unanchored);
  await expect(page.getByTestId(UI.diff)).toContainText("LAST_COMMIT_ONLY_SENTINEL");
  await expect(page.getByTestId(UI.drawer)).toContainText("src/missing.go");
  await selectFinding(page, FINDING.deleted);
  await expect(page.getByLabel("比较范围", { exact: true })).toHaveValue("full");
  await expect(
    page.getByTestId(UI.line("old", "src/deleted.go", repo.deletedOldLine)),
  ).toBeVisible();
});

test("an empty last commit remains an available empty comparison", async ({ page }) => {
  await resetCase(page); // the harness adds a real empty commit for isolation
  await openExplainer(page);
  await page.getByLabel("比较范围", { exact: true }).selectOption("last-commit");
  await expect(page.getByTestId(UI.diff)).toContainText(/没有.*变更|无.*变更|没有.*文件/);
  await expect(page.getByTestId(UI.root)).not.toContainText("冻结源码不可用");
});

test("a late last-commit response cannot replace a newer full-range choice", async ({ page }) => {
  const seeded = await resetCase(page);
  const repo = seedLastCommit(seeded.home);
  await openExplainer(page);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finished = () => {};
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route("**/review-explainer/comparison?mode=last-commit", async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    try {
      await route.fulfill({ response });
    } catch {
      /* client cancellation is expected */
    }
    finished();
  });
  try {
    await page.getByLabel("比较范围", { exact: true }).selectOption("last-commit");
    await pending;
    await page.getByLabel("比较范围", { exact: true }).selectOption("full");
    release();
    await done;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByTestId(UI.identity)).toContainText(repo.mergeBaseSha.slice(0, 7));
    await expect(page.getByLabel("比较范围", { exact: true })).toHaveValue("full");
    await selectFinding(page, FINDING.busy);
    await expect(page.getByTestId(UI.line("new", "src/busy.go", repo.busyNewLine))).toBeVisible();
  } finally {
    release();
  }
});

test("an explicit alias shows and preserves the canonical note when its decision changes", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  await openExplainer(page);
  await selectFinding(page, FINDING.busy);
  const note = "保留原始并发反例，别名仅表示同一评审点。";
  await page.getByLabel("处理备注", { exact: true }).fill(note);
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(ROUTES.decisions(RUN_ID)) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存备注", exact: true }).click();
  expect((await saved).status()).toBe(200);
  const path = prDecisionsPath(seeded.home, PR_URL);
  const decisions = JSON.parse(readFileSync(path, "utf8"));
  const alias = "h-busy-confirmed-alias";
  decisions.items[FINDING.busy].aliases = [{ id: alias, basis: "explicit" }];
  writeFileSync(path, JSON.stringify(decisions));
  const ledgerPath = join(seeded.home, "runs", RUN_ID, "findings.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  ledger.findings.find((f: { id: string }) => f.id === FINDING.busy).id = alias;
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  await page.reload();
  await selectFinding(page, alias);
  await expect(page.getByLabel("处理备注", { exact: true })).toHaveValue(note);
  const changed = page.waitForResponse(
    (r) => r.url().endsWith(ROUTES.decisions(RUN_ID)) && r.request().method() === "POST",
  );
  await page.getByTestId(UI.drawer).getByTestId(UI.willFix).click();
  expect((await changed).status()).toBe(200);
  const after = JSON.parse(readFileSync(path, "utf8"));
  expect(after.items[FINDING.busy]).toMatchObject({
    decision: "will_fix",
    audit: { reason: note },
  });
  expect(after.items[alias]).toBeUndefined();
});

test("historical and stale closed findings stay in the default unresolved work list", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  const path = join(seeded.home, "runs", RUN_ID, "findings.json");
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  const legacy = ledger.findings.find((f: { id: string }) => f.id === FINDING.dup);
  legacy.status = "closed";
  legacy.severity = "major";
  const stale = ledger.findings.find((f: { id: string }) => f.id === FINDING.stale);
  stale.status = "closed";
  stale.verification = {
    outcome: "verified_closed",
    candidateSha: "0".repeat(40),
    runId: RUN_ID,
    attemptId: "attempt-old",
    reviewer: "review-correctness",
    method: "code_trace",
    reason: "Verified only on an earlier candidate",
    evidence: "Historical evidence",
    locations: ["src/recovery.go:4"],
    runComplete: true,
  };
  writeFileSync(path, JSON.stringify(ledger));
  await openExplainer(page);
  await expect(page.getByTestId(`review-explainer-finding-${FINDING.dup}`)).toBeVisible();
  await expect(page.getByTestId(`review-explainer-finding-${FINDING.dup}`)).toContainText(
    "历史未验证",
  );
  await expect(page.getByTestId(`review-explainer-finding-${FINDING.stale}`)).toBeVisible();
  await expect(page.getByTestId(`review-explainer-finding-${FINDING.stale}`)).toContainText(
    "待验证当前提交",
  );
  await page.getByLabel("问题状态", { exact: true }).selectOption("closed");
  await expect(page.getByTestId(/^review-explainer-finding-/)).toHaveCount(0);
});

test("a resolved anchor supersedes a pending context request on the same problem", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  await openExplainer(page);
  await selectFinding(page, FINDING.busy);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finished = () => {};
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route("**/review-explainer/files/**", async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    try {
      await route.fulfill({ response });
    } catch {
      /* cancellation is valid */
    }
    finished();
  });
  try {
    await page
      .getByTestId(UI.drawer)
      .getByRole("button", { name: /查看冻结上下文/ })
      .click();
    await pending;
    await page
      .getByTestId(UI.drawer)
      .getByRole("button", { name: /定位代码/ })
      .first()
      .click();
    const response = page.waitForResponse((r) => r.url().includes("/review-explainer/files/"));
    release();
    await done;
    await response;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByTestId(UI.line("new", "src/busy.go", seeded.busyNewLine))).toHaveClass(
      /focused/,
    );
    await expect(
      page.getByTestId(UI.line("new", "src/busy.go", seeded.busyContextLine)),
    ).toHaveCount(0);
  } finally {
    release();
  }
});

test("a narrow inspector closes when a resolved anchor is selected", async ({ page }) => {
  await page.setViewportSize({ width: 678, height: 863 });
  const seeded = await resetCase(page);
  await openExplainer(page);
  await selectFinding(page, FINDING.busy);
  const pane = page.getByTestId(UI.drawer);
  await expect(pane).toBeVisible();
  await pane
    .getByRole("button", { name: /定位代码/ })
    .first()
    .click();
  await expect(pane).toBeHidden();
  const line = page.getByTestId(UI.line("new", "src/busy.go", seeded.busyNewLine));
  await expect(line).toBeVisible();
  await expect
    .poll(() =>
      line.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.max(0, r.left) + 80, r.top + r.height / 2);
        return r.top >= 0 && r.bottom <= innerHeight && hit !== null && element.contains(hit);
      }),
    )
    .toBe(true);
});

test("a late frozen-context response cannot move code away from a newly selected problem", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  await openExplainer(page);
  await selectFinding(page, FINDING.busy);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finished = () => {};
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route("**/review-explainer/files/**", async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    try {
      await route.fulfill({ response });
    } catch {
      /* an aborted request is safe */
    }
    finished();
  });
  try {
    await page
      .getByTestId(UI.drawer)
      .getByRole("button", { name: /查看冻结上下文/ })
      .click();
    await pending;
    await selectFinding(page, FINDING.stale);
    const applied = page
      .waitForResponse((r) => r.url().includes("/review-explainer/files/"))
      .catch(() => null);
    release();
    await done;
    // Observe after response delivery and a browser rendering turn, not just route.fulfill.
    await applied;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByTestId(UI.drawer)).toContainText("stale generation commits late");
    await expect(
      page.getByTestId(UI.line("new", "src/recovery.go", seeded.staleNewLine)),
    ).toBeVisible();
    await expect(
      page.getByTestId(UI.line("new", "src/busy.go", seeded.busyContextLine)),
    ).toHaveCount(0);
  } finally {
    release();
  }
});
