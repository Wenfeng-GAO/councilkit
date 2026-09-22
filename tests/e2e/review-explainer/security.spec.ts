import { expect, test } from "@playwright/test";
import { FINDING, ROUTES, RUN_ID, encodeFileKey } from "../../review-explainer/contract";
import { ORIGIN } from "./constants";
import { getCsrf, installOriginAllowlist, openReport, resetCase } from "./helpers";

test("[A10] real Host rejects absent session, wrong CSRF, foreign Origin, and traversal independently", async ({
  page,
  request,
}) => {
  await installOriginAllowlist(page);
  await resetCase(page);
  await openReport(page);
  // This request fixture has no browser session cookie.
  const anon = await request.get(ROUTES.workspace(RUN_ID));
  expect([401, 403]).toContain(anon.status());
  const csrf = await getCsrf(page);
  const workspace = await page.request.get(ROUTES.workspace(RUN_ID));
  expect(workspace.status()).toBe(200);
  const input = { findingId: FINDING.busy, decision: "will_fix", expectedRevision: 0 };
  const badCsrf = await page.request.post(ROUTES.decisions(RUN_ID), {
    headers: { Origin: ORIGIN, "x-councilkit-csrf": "nope", "content-type": "application/json" },
    data: input,
  });
  expect(badCsrf.status()).toBe(403);
  const badOrigin = await page.request.post(ROUTES.decisions(RUN_ID), {
    headers: {
      Origin: "https://untrusted.invalid",
      "x-councilkit-csrf": csrf,
      "content-type": "application/json",
    },
    data: input,
  });
  expect(badOrigin.status()).toBe(403);

  // Establish that the file route exists before interpreting a traversal 404 as a rejection.
  const ordinary = await page.request.get(
    `${ROUTES.fileContent(RUN_ID, encodeFileKey("README.md"))}?side=new`,
  );
  expect(ordinary.status()).toBe(200);
  const traversal = await page.request.get(
    `${ROUTES.fileContent(RUN_ID, encodeFileKey("../../etc/passwd"))}?side=new`,
  );
  expect([400, 403, 404]).toContain(traversal.status());
  expect(await traversal.text()).not.toMatch(/root:|daemon:|\/etc\/passwd/);
});
