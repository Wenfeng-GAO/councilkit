/**
 * QA gate on #293: `--allow-write` was accepted by `review` but appeared in
 * neither `councilkit --help` nor `councilkit review --help`. Similar-bug
 * sweep: every flag the review parser accepts must be documented, generated
 * from the same table the parser uses so the two cannot drift.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REVIEW_FLAGS } from "../src/commands/review";
import { REVIEW_HELP } from "../src/help";

describe("#293 review help documents every review flag", () => {
  for (const name of Object.keys(REVIEW_FLAGS)) {
    it(`review --help lists --${name}`, () => {
      expect(REVIEW_HELP).toMatch(new RegExp(`^  --${name}\\s`, "m"));
    });
  }

  it("review --help says seats are read-only by default", () => {
    expect(REVIEW_HELP).toContain("read-only by default");
  });

  const dist = join(__dirname, "..", "dist", "main.mjs");
  it.skipIf(!existsSync(dist))(
    "built CLI: `councilkit review --help` prints the review help",
    () => {
      const text = execFileSync(process.execPath, [dist, "review", "--help"], { encoding: "utf8" });
      expect(text).toContain("--allow-write");
      expect(text).toContain("councilkit review —");
    },
  );
});
