/**
 * QA-PR295-OBS2 (#289): `councilkit runs list` prints the same 需要处理 / 阻塞
 * numbers as the run list and the report page (tests/unit/qa-pr295-obs2-…).
 * Fixture: QA's real task-mode grok run (tests/fixtures/qa-pr295-task-run).
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRuns } from "../src/commands/runs";

const RUN_ID = "ck-review-188cdfd8-2e7e-482a-af6e-87141ce17a91";
const FIXTURE = join(__dirname, "../../tests/fixtures/qa-pr295-task-run");
const EXPECTED = { needsAttention: 6, blocking: 0 };

describe("QA-PR295-OBS2 runs list shows the shared 需要处理 count", () => {
  let home: string;
  let oldHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-obs2-cli-"));
    const dir = join(home, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    cpSync(FIXTURE, dir, { recursive: true });
    oldHome = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });
  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("`runs list` prints the same numbers (human + json)", async () => {
    const lines: string[] = [];
    let human = "";
    let finished: unknown;
    await runRuns(["list"], {
      json: false,
      progress: (m: string) => lines.push(m),
      diag: () => {},
      finish: (d: unknown, render?: (d: unknown) => string) => {
        finished = d;
        human = render ? render(d) : "";
        return Promise.resolve();
      },
    } as never);
    expect(human).toContain(`需要处理 ${EXPECTED.needsAttention}`);
    expect(human).toContain(`阻塞 ${EXPECTED.blocking}`);
    const run = (finished as { runs: { attention: unknown }[] }).runs[0];
    expect(run?.attention).toMatchObject(EXPECTED);
  });
});
