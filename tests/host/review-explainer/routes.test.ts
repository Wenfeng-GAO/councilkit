import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ASSERTION,
  DECISION,
  DISK,
  FINDING,
  PR_URL,
  ROUTES,
  RUN_ID,
  encodeFileKey,
  prDecisionsPath,
} from "../../review-explainer/contract";
import {
  BUSY_SNIPPET,
  HIDDEN_CONTEXT_SNIPPET,
  README_SNIPPET,
} from "../../review-explainer/fixtures/sample-diff";
import { seedReviewRun } from "../../review-explainer/fixtures/seed-run";
import { classifyExplainerStatus, infra, required } from "../../review-explainer/load-feature";
import { type ExplainerHttpHost, createExplainerHttpHost } from "./http-helpers";

let home: string;
let host: ExplainerHttpHost | null = null;
const homes: string[] = [];
const oldHome = process.env.COUNCILKIT_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-explainer-http-home-"));
  homes.push(home);
  process.env.COUNCILKIT_HOME = home;
});

afterEach(async () => {
  await host?.close();
  host = null;
  if (oldHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = oldHome;
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<ExplainerHttpHost> {
  host = await createExplainerHttpHost({ home });
  return host;
}

async function json(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

describe("review-explainer HTTP [INFRA]", () => {
  it("serves health and the existing cli-run detail from disk without using 43127", async () => {
    const seeded = seedReviewRun(home);
    const http = await boot();
    expect(http.hostHeader).not.toContain("43127");
    const health = await fetch(`${http.baseUrl}/api/v1/health`);
    if (!health.ok) infra(`health HTTP ${health.status}`);
    const listed = await fetch(`${http.baseUrl}/api/v1/cli-runs/${seeded.runId}`, {
      headers: http.headers(),
    });
    if (listed.status !== 200) infra(`GET cli-runs/${seeded.runId} HTTP ${listed.status}`);
    const body = (await listed.json()) as { ok: boolean; data: { markdown: string; kind: string } };
    expect(body.data.kind).toBe("review");
    expect(body.data.markdown).toContain("Synthetic explainer fixture");
  });
});

describe("A01/A02 workspace and file content", () => {
  it("returns every frozen file, old/new sides, and refuses to forge binary code", async () => {
    const seeded = seedReviewRun(home);
    const http = await boot();
    const res = await fetch(`${http.baseUrl}${ROUTES.workspace(RUN_ID)}`, {
      headers: http.headers(),
    });
    classifyExplainerStatus(res.status, ROUTES.workspace(RUN_ID));
    const { body } = await json(res);
    expect(res.status).toBe(200);
    const data = (body.data ?? body) as {
      identity?: { headSha: string; diffHash: string };
      files?: Array<{ path: string; status: string; binary?: boolean }>;
    };
    expect(data.identity?.headSha).toBe(seeded.repo.headSha);
    expect(data.identity?.diffHash).toBe(seeded.repo.diffHash);
    const paths = (data.files ?? []).map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "README.md",
        "src/busy.go",
        "src/recovery.go",
        "src/deleted.go",
        "assets/icon.bin",
        "tests/WideCoverage.java",
      ]),
    );
    expect(data.files?.find((file) => file.path === "assets/icon.bin")?.binary).toBe(true);

    const readme = await fetch(
      `${http.baseUrl}${ROUTES.fileContent(RUN_ID, encodeFileKey("README.md"))}?side=new`,
      { headers: http.headers() },
    );
    classifyExplainerStatus(readme.status, ROUTES.fileContent(RUN_ID, "README.md"));
    const readmeBody = (await readme.json()) as { data?: { text: string } };
    expect(readmeBody.data?.text ?? "").toContain(README_SNIPPET);

    const busy = await fetch(
      `${http.baseUrl}${ROUTES.fileContent(RUN_ID, encodeFileKey("src/busy.go"))}?side=new`,
      { headers: http.headers() },
    );
    const busyBody = (await busy.json()) as {
      data?: { text: string; lines?: Array<{ number: number; text: string }> };
    };
    const text = busyBody.data?.text ?? JSON.stringify(busyBody);
    expect(text).toContain(BUSY_SNIPPET);

    const binary = await fetch(
      `${http.baseUrl}${ROUTES.fileContent(RUN_ID, encodeFileKey("assets/icon.bin"))}?side=new`,
      { headers: http.headers() },
    );
    const binaryJson = await binary.text();
    expect(binaryJson).toMatch(/binary|not text|不可当代码/i);
    expect(binaryJson).not.toContain("\u0000");
  });
});

describe("A04 decisions persistence", () => {
  it("writes decisions to Host-managed disk and rejects a failed write as not saved", async () => {
    seedReviewRun(home);
    const http = await boot();
    const url = `${http.baseUrl}${ROUTES.decisions(RUN_ID)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: http.headers(),
      body: JSON.stringify({
        findingId: FINDING.busy,
        decision: DECISION.willFix,
        expectedRevision: 0,
      }),
    });
    classifyExplainerStatus(res.status, ROUTES.decisions(RUN_ID));
    expect(res.status).toBe(200);
    const disk = prDecisionsPath(home, PR_URL);
    const saved = JSON.parse(readFileSync(disk, "utf8")) as {
      items: Record<string, { decision: string }>;
    };
    expect(saved.items[FINDING.busy]?.decision).toBe(DECISION.willFix);

    const concurrent = await Promise.all([
      fetch(url, {
        method: "POST",
        headers: http.headers(),
        body: JSON.stringify({
          findingId: FINDING.stale,
          decision: DECISION.wontFix,
          expectedRevision: 1,
        }),
      }),
      fetch(url, {
        method: "POST",
        headers: http.headers(),
        body: JSON.stringify({
          findingId: FINDING.dup,
          decision: DECISION.willFix,
          expectedRevision: 1,
        }),
      }),
    ]);
    const statuses = concurrent.map((row) => row.status).sort();
    expect(statuses).toEqual([200, 409]);
    const after = JSON.parse(readFileSync(disk, "utf8")) as {
      items: Record<string, { decision: string }>;
    };
    const decided = Object.keys(after.items);
    expect(decided).toContain(FINDING.busy);
    expect(decided).toHaveLength(2);
    const winner = required(concurrent[0]).status === 200 ? FINDING.stale : FINDING.dup;
    const loser = winner === FINDING.stale ? FINDING.dup : FINDING.stale;
    expect(after.items[winner]).toBeDefined();
    expect(after.items[loser]).toBeUndefined();

    const beforeFailure = readFileSync(disk, "utf8");
    const parent = dirname(disk);
    renameSync(parent, `${parent}.saved`);
    writeFileSync(parent, "storage path is a file");
    try {
      const failed = await fetch(url, {
        method: "POST",
        headers: http.headers(),
        body: JSON.stringify({
          findingId: FINDING.deleted,
          decision: DECISION.willFix,
          expectedRevision: 2,
        }),
      });
      // Valid current revision; failure must be storage I/O, not the old test's stale-revision 409.
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await failed.text()).not.toMatch(/"saved":\s*true/);
    } finally {
      rmSync(parent);
      renameSync(`${parent}.saved`, parent);
    }
    expect(readFileSync(disk, "utf8")).toBe(beforeFailure);
  });
});

describe("A06 selected repair package", () => {
  it("exports only will_fix ids and keeps undecided out", async () => {
    seedReviewRun(home);
    const http = await boot();
    await fetch(`${http.baseUrl}${ROUTES.decisions(RUN_ID)}`, {
      method: "POST",
      headers: http.headers(),
      body: JSON.stringify({
        findingId: FINDING.busy,
        decision: DECISION.willFix,
        expectedRevision: 0,
      }),
    });
    const res = await fetch(`${http.baseUrl}${ROUTES.repairPackage(RUN_ID)}`, {
      headers: http.headers(),
    });
    classifyExplainerStatus(res.status, ROUTES.repairPackage(RUN_ID));
    const { body } = await json(res);
    const data = (body.data ?? body) as {
      findings: Array<{ id: string; evidence: string }>;
      constraints?: { deferred?: Array<{ id: string }> };
    };
    expect(data.findings.map((row) => row.id)).toEqual([FINDING.busy]);
    expect(data.findings[0]?.evidence).toMatch(/Counterexample|busy/i);
    expect(data.findings.some((row) => row.id === FINDING.dup)).toBe(false);
    expect(JSON.stringify(data)).not.toContain("verified_closed");
  });
});

describe("A07 explanations", () => {
  it("passes frozen input to the executor, persists its actual result, and reuses it", async () => {
    const seeded = seedReviewRun(home, { legacy: true });
    const inputs: unknown[] = [];
    const marker = "EXECUTOR_RESULT_unique_8a4e";
    host = await createExplainerHttpHost({
      home,
      extraServices: {
        reviewExplainerExecutor: {
          async generate(input: unknown) {
            inputs.push(input);
            return {
              kind: "code",
              assertion: marker,
              evidence: [ASSERTION.busy],
              inference: [],
              suggestedCode: {
                before: BUSY_SNIPPET,
                after: "return acceptedTurn",
                verifiedFixed: false,
              },
              modelId: "fake-explainer",
            };
          },
        },
      },
    });
    const url = `${host.baseUrl}${ROUTES.explanation(RUN_ID, FINDING.busy)}`;
    const first = await fetch(url, { method: "POST", headers: host.headers(), body: "{}" });
    classifyExplainerStatus(first.status, ROUTES.explanation(RUN_ID, FINDING.busy));
    expect(first.status).toBe(200);
    expect(await first.text()).toContain(marker);
    expect(inputs).toHaveLength(1);
    expect(JSON.stringify(inputs[0])).toContain(ASSERTION.busy);
    expect(JSON.stringify(inputs[0])).toContain(BUSY_SNIPPET);
    expect(JSON.stringify(inputs[0])).toContain(seeded.repo.headSha);
    const cacheDir = join(seeded.runDir, DISK.explanations);
    const cacheFiles = readdirSync(cacheDir).filter((name) => name.endsWith(".json"));
    expect(cacheFiles).toHaveLength(1);
    expect(readFileSync(join(cacheDir, required(cacheFiles[0])), "utf8")).toContain(marker);
    for (const method of ["POST", "GET"]) {
      const cached = await fetch(url, {
        method,
        headers: host.headers(),
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(cached.status).toBe(200);
      expect(await cached.text()).toContain(marker);
    }
    expect(inputs).toHaveLength(1);
  });

  it.each(["invalid", "timeout"])(
    "does not cache %s output or replace it with a static explanation",
    async (failure) => {
      const seeded = seedReviewRun(home, { legacy: true });
      let calls = 0;
      let fail = true;
      host = await createExplainerHttpHost({
        home,
        extraServices: {
          reviewExplainerExecutor: {
            async generate() {
              calls += 1;
              if (fail) {
                if (failure === "timeout") throw new Error("executor timeout");
                return { unexpected: "not an explanation" };
              }
              return {
                kind: "code",
                assertion: "RECOVERED_MODEL_RESULT",
                evidence: [ASSERTION.busy],
                inference: [],
                modelId: "fake-explainer",
              };
            },
          },
        },
      });
      const url = `${host.baseUrl}${ROUTES.explanation(RUN_ID, FINDING.busy)}`;
      const first = await fetch(url, { method: "POST", headers: host.headers(), body: "{}" });
      classifyExplainerStatus(first.status, ROUTES.explanation(RUN_ID, FINDING.busy));
      expect(first.status).toBeGreaterThanOrEqual(400);
      expect(calls).toBe(1);
      const cacheDir = join(seeded.runDir, DISK.explanations);
      expect(
        existsSync(cacheDir) ? readdirSync(cacheDir).filter((name) => name.endsWith(".json")) : [],
      ).toEqual([]);
      const cached = await fetch(url, { headers: host.headers() });
      expect(cached.status).not.toBe(200);
      expect(calls).toBe(1);
      fail = false;
      const retried = await fetch(url, { method: "POST", headers: host.headers(), body: "{}" });
      expect(retried.status).toBe(200);
      expect(await retried.text()).toContain("RECOVERED_MODEL_RESULT");
      expect(calls).toBe(2);
    },
  );
});

describe("A10 session, path, and payload bounds", () => {
  it("rejects missing session, traversal, and corrupt frozen artifacts with diagnostic errors", async () => {
    seedReviewRun(home);
    const http = await boot();
    const anon = await fetch(`${http.baseUrl}${ROUTES.workspace(RUN_ID)}`);
    expect(anon.status).toBe(401);
    const csrf = await fetch(`${http.baseUrl}${ROUTES.decisions(RUN_ID)}`, {
      method: "POST",
      headers: http.headers({ "x-councilkit-csrf": "nope" }),
      body: JSON.stringify({
        findingId: FINDING.busy,
        decision: DECISION.willFix,
        expectedRevision: 0,
      }),
    });
    expect(csrf.status).toBe(403);

    const traversal = await fetch(
      `${http.baseUrl}${ROUTES.fileContent(RUN_ID, encodeFileKey("../secrets.env"))}?side=new`,
      { headers: http.headers() },
    );

    expect([400, 403, 404]).toContain(traversal.status);
    expect(await traversal.text()).not.toContain("HOME");

    writeFileSync(join(home, "runs", RUN_ID, "review-context.diff"), "not a diff\n\0\0");
    const corrupt = await fetch(`${http.baseUrl}${ROUTES.workspace(RUN_ID)}`, {
      headers: http.headers(),
    });
    classifyExplainerStatus(corrupt.status, ROUTES.workspace(RUN_ID));
    expect(corrupt.status).toBeGreaterThanOrEqual(400);
    const err = await corrupt.text();
    expect(err).toMatch(/corrupt|invalid|损坏|diagnostic/i);
    expect(err).not.toContain("not a diff");
  });
});

describe("A01/A02 legacy frozen Run without explainer sidecars", () => {
  it("derives identity from existing manifest/context and retrieves real out-of-hunk context at frozen SHA", async () => {
    const seeded = seedReviewRun(home, { legacy: true });
    expect(existsSync(join(seeded.runDir, DISK.identity))).toBe(false);
    expect(existsSync(join(seeded.runDir, "review-explainer", "anchors.json"))).toBe(false);
    expect(seeded.repo.diff).not.toContain(HIDDEN_CONTEXT_SNIPPET);
    const http = await boot();
    const response = await fetch(`${http.baseUrl}${ROUTES.workspace(RUN_ID)}`, {
      headers: http.headers(),
    });
    classifyExplainerStatus(response.status, ROUTES.workspace(RUN_ID));
    expect(response.status).toBe(200);
    const responseBody = (await response.json()) as {
      data: { identity: { headSha: string; diffHash: string } };
    };
    const workspace = responseBody.data;
    expect(workspace.identity.headSha).toBe(seeded.repo.headSha);
    expect(workspace.identity.diffHash).toBe(seeded.repo.diffHash);
    expect(JSON.stringify(workspace)).toContain(FINDING.busy);
    expect(JSON.stringify(workspace)).toContain(FINDING.unanchored);
    // Poison the working file: historical code must still come from the frozen blob.
    writeFileSync(join(seeded.repo.repo, "src/busy.go"), "CURRENT_CHECKOUT_POISON\n");
    const context = await fetch(
      `${http.baseUrl}${ROUTES.fileContent(RUN_ID, encodeFileKey("src/busy.go"))}?side=new&start=${seeded.repo.busyContextLine}&end=${seeded.repo.busyContextLine}`,
      { headers: http.headers() },
    );
    expect(context.status).toBe(200);
    const body = await context.text();
    expect(body).toContain(HIDDEN_CONTEXT_SNIPPET.replaceAll('"', '\\"'));
    expect(body).not.toContain("CURRENT_CHECKOUT_POISON");
    expect(readFileSync(join(seeded.runDir, "review-context.diff"), "utf8")).toBe(seeded.repo.diff);
  });
});
