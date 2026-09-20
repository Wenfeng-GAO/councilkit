import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFindings } from "../src/commands/findings";
import { CliError } from "../src/errors";

const RUN_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";

describe("cli findings accept", () => {
  let home: string;
  const oldHome = process.env.COUNCILKIT_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-findings-"));
    process.env.COUNCILKIT_HOME = home;
  });

  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("writes accepted status and reason onto the ledger", async () => {
    const dir = join(home, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "findings.json"),
      `${JSON.stringify({
        version: 1,
        runId: RUN_ID,
        extractedAt: "2026-09-20T00:00:00.000Z",
        sha: "a".repeat(40),
        againstRunId: null,
        againstRange: null,
        findings: [
          {
            id: "h-abc",
            severity: "nit",
            status: "open",
            title: "naming",
            text: "naming",
            source: "unique",
            reviewer: "review-maintainability",
            files: [],
          },
        ],
      })}\n`,
    );
    let finished: unknown;
    await runFindings(
      ["accept", "--run", RUN_ID, "--id", "h-abc", "--reason", "product contract, not a defect"],
      {
        json: false,
        progress: () => {},
        diag: () => {},
        finish: async (data) => {
          finished = data;
        },
      },
    );
    const file = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as {
      findings: Array<{ status: string; acceptedReason?: string }>;
    };
    expect(file.findings[0]?.status).toBe("accepted");
    expect(file.findings[0]?.acceptedReason).toBe("product contract, not a defect");
    expect(finished).toMatchObject({ findingId: "h-abc", status: "accepted" });
  });

  it("requires a reason", async () => {
    await expect(
      runFindings(["accept", "--run", RUN_ID, "--id", "h-abc"], {
        json: false,
        progress: () => {},
        diag: () => {},
        finish: async () => {},
      }),
    ).rejects.toBeInstanceOf(CliError);
  });
});
