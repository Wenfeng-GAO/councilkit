import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCHIVED_RUNS_FILE,
  parseArchivedRunsFile,
  readArchivedRunIds,
} from "@shared/runtime/archived-runs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUN_A = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const RUN_B = "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
const RUN_C = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";

describe("parseArchivedRunsFile", () => {
  it("parses the exact on-disk shape", () => {
    expect(parseArchivedRunsFile(JSON.stringify({ version: 1, runIds: [RUN_A, RUN_C] }))).toEqual({
      version: 1,
      runIds: [RUN_A, RUN_C],
    });
  });

  it("rejects malformed json and wrong shapes by failing open to null", () => {
    expect(parseArchivedRunsFile("not json")).toBeNull();
    expect(parseArchivedRunsFile(JSON.stringify({ runIds: [RUN_A] }))).toBeNull();
    expect(parseArchivedRunsFile(JSON.stringify({ version: 1, runIds: "ck-review-x" }))).toBeNull();
    expect(parseArchivedRunsFile(JSON.stringify({ version: 1, runIds: [] }))).toEqual({
      version: 1,
      runIds: [],
    });
  });

  it("rejects unsupported versions and non-numeric version values", () => {
    expect(parseArchivedRunsFile(JSON.stringify({ version: 2, runIds: [RUN_A] }))).toBeNull();
    expect(parseArchivedRunsFile(JSON.stringify({ version: "1", runIds: [RUN_A] }))).toBeNull();
    expect(parseArchivedRunsFile(JSON.stringify({ version: 1.5, runIds: [RUN_A] }))).toBeNull();
  });

  it("rejects unknown extra fields instead of guessing at the schema", () => {
    expect(
      parseArchivedRunsFile(
        JSON.stringify({ version: 1, runIds: [RUN_A], reason: "cleanup manifest" }),
      ),
    ).toBeNull();
  });

  it("rejects the whole file when any run id is invalid — never hides by accident", () => {
    expect(
      parseArchivedRunsFile(JSON.stringify({ version: 1, runIds: [RUN_A, "not-a-run-id"] })),
    ).toBeNull();
    expect(parseArchivedRunsFile(JSON.stringify({ version: 1, runIds: [RUN_A, 42] }))).toBeNull();
  });
});

describe("readArchivedRunIds", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-archived-runs-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const env = () => ({ ...process.env, COUNCILKIT_HOME: home });

  it("returns an empty set when the archive file is absent", () => {
    mkdirSync(join(home, "runs"), { recursive: true });
    expect(readArchivedRunIds(env()).size).toBe(0);
  });

  it("reads run ids from the councilkit home", () => {
    writeFileSync(
      join(home, ARCHIVED_RUNS_FILE),
      `${JSON.stringify({ version: 1, runIds: [RUN_A, RUN_B] })}\n`,
    );
    expect(readArchivedRunIds(env())).toEqual(new Set([RUN_A, RUN_B]));
  });

  it("fails open on a corrupt archive: no run is hidden", () => {
    writeFileSync(join(home, ARCHIVED_RUNS_FILE), "{not-json");
    expect(readArchivedRunIds(env()).size).toBe(0);
  });

  it("never follows a symlinked archive file", () => {
    const target = join(home, "target.json");
    writeFileSync(target, JSON.stringify({ version: 1, runIds: [RUN_A] }));
    symlinkSync(target, join(home, ARCHIVED_RUNS_FILE));
    expect(readArchivedRunIds(env()).size).toBe(0);
  });

  it("ignores an oversized archive file", () => {
    writeFileSync(
      join(home, ARCHIVED_RUNS_FILE),
      JSON.stringify({ version: 1, runIds: [RUN_A] }).padEnd(256 * 1024 + 2, " "),
    );
    expect(readArchivedRunIds(env()).size).toBe(0);
  });
});
