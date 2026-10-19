/**
 * Spec-contract hard gate: no-spec refuse, with-spec auto-bind, verify schedule.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SPEC_REFUSAL_MESSAGE,
  autoDetectSpec,
  bindVerifyFromSpec,
  extractAcceptanceIds,
  extractConventionalSpecRefs,
  fetchPrSpecSearchText,
  formatSpecRefusal,
  formatSpecVerifyUnbound,
  isConventionalSpecPath,
  resolveSpecContract,
} from "../src/auto/spec-detect";
import { AGGREGATE_PROMPT_BUDGET, MAX_SPEC_TEXT_IN_PROMPT } from "../src/auto/templates/review";

describe("conventional path detection", () => {
  it("recognizes docs/plans, design, vibespec, verification, acceptance", () => {
    expect(isConventionalSpecPath("docs/plans/feat-plan.md")).toBe(true);
    expect(isConventionalSpecPath("docs/design/2026-09-20-review-workspace/README.md")).toBe(true);
    expect(isConventionalSpecPath("docs/vibespec/councilkit/VERIFY.md")).toBe(true);
    expect(
      isConventionalSpecPath("docs/verification/2026-09-23-review-explainer-acceptance.md"),
    ).toBe(true);
    expect(isConventionalSpecPath("src/foo.ts")).toBe(false);
    expect(isConventionalSpecPath("README.md")).toBe(false);
  });

  it("extracts path refs from PR/task prose", () => {
    const text = `
See docs/plans/2026-09-28-review-workspace-v2.md and \`docs/verification/foo-acceptance.md\`.
Also docs/vibespec/councilkit/PRD.md.
`;
    const refs = extractConventionalSpecRefs(text);
    expect(refs).toContain("docs/plans/2026-09-28-review-workspace-v2.md");
    expect(refs).toContain("docs/verification/foo-acceptance.md");
    expect(refs).toContain("docs/vibespec/councilkit/PRD.md");
  });

  it("extracts date-heavy docs/plans paths from AntCode-style PR description prose", () => {
    const text = `
## Spec
Contract: \`docs/plans/2026-09-20-session-shutdown-recovery.md\`
`;
    const refs = extractConventionalSpecRefs(text);
    expect(refs).toEqual(["docs/plans/2026-09-20-session-shutdown-recovery.md"]);
  });
});

describe("no-spec hard refuse", () => {
  it("returns null when search text has no conventional contract", () => {
    expect(
      resolveSpecContract({
        searchText: "Please review this PR carefully for bugs.",
        repoRoot: null,
      }),
    ).toBeNull();
  });

  it("refusal copy names missing contract and where to put a spec", () => {
    const msg = formatSpecRefusal();
    expect(msg).toBe(SPEC_REFUSAL_MESSAGE);
    expect(msg).toContain("review refused: no boundable spec-contract found");
    expect(msg).toContain("docs/plans/");
    expect(msg).toContain("docs/vibespec/");
    expect(msg).toContain("docs/verification/");
    expect(msg).toContain("--spec <path>");
    expect(msg).toContain("PR description / --task text alone is not a contract");
  });
});

describe("with-spec auto-bind", () => {
  it("auto-detects and reads a conventional plan under repoRoot", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-spec-"));
    const dir = join(root, "docs", "plans");
    mkdirSync(dir, { recursive: true });
    const rel = "docs/plans/demo-plan.md";
    writeFileSync(
      join(root, rel),
      ["# Demo", "", "## 验收", "", "- [ ] AC-12 cancel deregisters waiters", ""].join("\n"),
      "utf8",
    );
    const detected = autoDetectSpec({
      searchText: `Implements ${rel} as the contract.`,
      repoRoot: root,
    });
    expect(detected).not.toBeNull();
    expect(detected!.origin).toBe("auto-detect");
    expect(detected!.source).toContain("docs/plans/demo-plan.md");
    expect(detected!.text).toContain("AC-12");
  });

  it("binds a nested vibespec PRD.md mentioned only by basename", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-spec-"));
    const rel = "docs/vibespec/demo/PRD.md";
    mkdirSync(join(root, "docs", "vibespec", "demo"), { recursive: true });
    writeFileSync(
      join(root, rel),
      ["# PRD", "", "## 验收", "", "- [ ] cancel deregisters waiters", ""].join("\n"),
      "utf8",
    );
    const detected = autoDetectSpec({
      searchText: "Spec contract: PRD.md",
      repoRoot: root,
    });
    expect(detected?.source).toBe(realpathSync(join(root, rel)));
    expect(detected?.text).toContain("cancel deregisters waiters");
    expect(
      autoDetectSpec({
        searchText: "See docs/plans/missing-plan.md for the contract.",
        repoRoot: root,
      }),
    ).toBeNull();
  });

  it("--spec explicit override binds file body", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-spec-"));
    const rel = "docs/verification/demo-acceptance.md";
    mkdirSync(join(root, "docs", "verification"), { recursive: true });
    writeFileSync(join(root, rel), "# Acc\n\nA01 and A02 must hold.\n", "utf8");
    const detected = resolveSpecContract({
      explicitSpec: rel,
      searchText: "ignored when --spec set",
      repoRoot: root,
    });
    expect(detected?.origin).toBe("explicit-flag");
    expect(detected?.text).toContain("A01");
    expect(detected?.source).toBe(realpathSync(join(root, rel)));
  });

  it("records --spec ../spec.md as an absolute path from the caller's cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-spec-parent-"));
    const sub = join(root, "pkg");
    mkdirSync(sub);
    writeFileSync(join(root, "spec.md"), "# Acc\n\n## 验收\n\n- [ ] AC-1 holds\n", "utf8");
    const previous = process.cwd();
    process.chdir(sub);
    try {
      const detected = resolveSpecContract({ explicitSpec: "../spec.md", repoRoot: null });
      expect(detected?.source).toBe(realpathSync(join(root, "spec.md")));
      expect(detected?.text).toContain("AC-1");
    } finally {
      process.chdir(previous);
    }
  });
});

describe("verify binding from bound spec", () => {
  it("extracts AC/INV/A0x/A1/VT/agentverify IDs", () => {
    const ids = extractAcceptanceIds("AC-12 and INV-1; also A1, A01, VT3, agentverify:cancel-path");
    expect(ids).toEqual(
      expect.arrayContaining(["AC-12", "INV-1", "A1", "A01", "VT3", "agentverify:cancel-path"]),
    );
  });

  it("accepts IN-/SE-/E2E- ids and ignores hash, encoding, ISO, and date lookalikes", () => {
    const ids = extractAcceptanceIds(
      "IN-12 SE-12 E2E-3 E2E-3a AC-12; noise SHA-256 UTF-8 UTF-16 ISO-8601 ISO-3166 GO-1.21 on 2026-10-16",
    );
    expect(ids).toEqual(expect.arrayContaining(["IN-12", "SE-12", "E2E-3", "E2E-3a", "AC-12"]));
    expect(extractAcceptanceIds("IN-12. RFC-2119")).toEqual(
      expect.arrayContaining(["IN-12", "RFC-2119"]),
    );
    expect(ids).not.toEqual(expect.arrayContaining(["SHA-256", "UTF-8", "UTF-16", "ISO-8601"]));
    for (const rejected of [
      "SHA-256",
      "UTF-8",
      "UTF-16",
      "ISO-8601",
      "ISO-3166",
      "2026-10-16",
      "GO-1",
    ]) {
      expect(ids).not.toContain(rejected);
    }
  });

  it("does not accept a generic id that is only a prefix of a longer token", () => {
    const ids = extractAcceptanceIds(
      "See CVE-2026-12345 and FOO-12-34. Still in scope: IN-12 SE-12 E2E-3 E2E-3a RFC-2119.",
    );
    expect(ids).toEqual(expect.arrayContaining(["IN-12", "SE-12", "E2E-3", "E2E-3a", "RFC-2119"]));
    for (const rejected of ["CVE-2026", "CVE-2026-12345", "FOO-12", "FOO-12-34"]) {
      expect(ids).not.toContain(rejected);
    }
    expect(
      bindVerifyFromSpec({ specSource: "sec.md", specText: "CVE-2026-12345 only" }),
    ).toBeNull();
  });

  it("binds an acceptance table of IN-/SE-/E2E- rows", () => {
    const ids = extractAcceptanceIds(
      [
        "# 规格",
        "",
        "## 验收",
        "",
        "| 编号 | 标准 |",
        "| --- | --- |",
        "| IN-12 | 加载配置 |",
        "| SE-12 | 安全边界 |",
        "| E2E-3 | 端到端 |",
        "",
      ].join("\n"),
    );
    expect(ids).toEqual(expect.arrayContaining(["IN-12", "SE-12", "E2E-3"]));
  });

  it("binds a prose acceptance table that has no ids yet", () => {
    const ids = extractAcceptanceIds(
      [
        "## 验收标准",
        "",
        "| 条件 | 期望 |",
        "| --- | --- |",
        "| 空串仍问候 | Greet 保留空串分支 |",
        "",
      ].join("\n"),
    );
    expect(ids.some((id) => id.startsWith("accept:"))).toBe(true);
  });

  it("does not treat a hash table outside an acceptance section as acceptance points", () => {
    const body = ["## 参考", "", "| 名称 | 值 |", "| --- | --- |", "| SHA-256 | abc |", ""].join(
      "\n",
    );
    expect(extractAcceptanceIds(body)).toEqual([]);
    expect(bindVerifyFromSpec({ specSource: "docs/design/x.md", specText: body })).toBeNull();
  });

  it("lists headings and rejected candidate ids when verify cannot bind", () => {
    const body = [
      "# 设计",
      "",
      "对照 SHA-256、UTF-8 和 ISO-8601，日期 2026-10-16，另有小写 in-12。",
      "",
      "## 背景",
      "",
      "这里没有验收表。",
      "",
    ].join("\n");
    expect(bindVerifyFromSpec({ specSource: "docs/design/x.md", specText: body })).toBeNull();
    const message = formatSpecVerifyUnbound({ specSource: "docs/design/x.md", specText: body });
    expect(message).toContain("Headings seen:");
    expect(message).toContain("背景");
    expect(message).toContain("Candidate IDs seen:");
    expect(message).toContain("SHA-256");
    expect(message).toContain("UTF-8");
    expect(message).toContain("ISO-8601");
    expect(message).toContain("in-12");
    expect(message).not.toContain("2026-10-16");
    expect(message).toContain("## 验收");
    expect(message).toContain("| IN-12 | 空串仍返回问候 |");
    expect(message).toContain("IN-12, SE-12, E2E-3");
  });

  it("schedules verify or returns null when unbound", () => {
    const ok = bindVerifyFromSpec({
      specSource: "docs/plans/x.md",
      specText: "## 验收\n\n- AC-9 must hold\n",
    });
    expect(ok).not.toBeNull();
    expect(ok!.acceptanceIds).toContain("AC-9");
    expect(ok!.scheduleNote).toContain("Verify schedule");

    expect(
      bindVerifyFromSpec({
        specSource: "label-only",
        specText: null,
      }),
    ).toBeNull();
  });
});

describe("spec body size cap", () => {
  it("truncates a near-budget spec to the shared prompt cap", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-spec-"));
    const rel = "docs/plans/big-plan.md";
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    const body = `AC-99 keep\n${"x".repeat(AGGREGATE_PROMPT_BUDGET - 80)}`;
    writeFileSync(join(root, rel), body, "utf8");
    const detected = resolveSpecContract({
      explicitSpec: rel,
      repoRoot: root,
    });
    expect(detected?.text).toBeDefined();
    expect(Buffer.byteLength(detected!.text!, "utf8")).toBeLessThanOrEqual(
      MAX_SPEC_TEXT_IN_PROMPT + 64, // allow truncation marker
    );
    expect(detected!.text).toContain(`[truncated at ${MAX_SPEC_TEXT_IN_PROMPT} bytes]`);
    expect(detected!.text).toContain("AC-99");
  });
});

describe("fetchPrSpecSearchText", () => {
  it("fetches GitHub title+body via gh pr view", async () => {
    const calls: string[][] = [];
    const text = await fetchPrSpecSearchText({
      prUrl: "https://github.com/acme/repo/pull/9",
      runCommand: async (input) => {
        calls.push([input.executable, ...input.argv]);
        return {
          stdout: JSON.stringify({
            title: "Ship plan",
            body: "See docs/plans/2026-09-20-session-shutdown-recovery.md",
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    expect(calls[0]?.[0]).toBe("gh");
    expect(text).toContain("Ship plan");
    expect(text).toContain("docs/plans/2026-09-20-session-shutdown-recovery.md");
  });

  it("fetches AntCode title+description via antcode pr show (root cause of SPEC_REQUIRED)", async () => {
    const calls: Array<{ exe: string; argv: string[]; env?: NodeJS.ProcessEnv }> = [];
    const text = await fetchPrSpecSearchText({
      prUrl: "https://code.alipay.com/paas-core/agentrun/pull_requests/130",
      env: { PATH: "/bin", HTTPS_PROXY: "http://proxy.example:8080" },
      runCommand: async (input) => {
        calls.push({ exe: input.executable, argv: input.argv, env: input.env });
        expect(input.executable).toBe("antcode");
        return {
          stdout: JSON.stringify({
            title: "session shutdown recovery",
            description:
              "Plan path: `docs/plans/2026-09-20-session-shutdown-recovery.md`\n\nAcceptance: A1",
            source_branch: "feat/x",
            target_branch: "master",
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    expect(calls).toHaveLength(1);
    const antCall = calls[0];
    expect(antCall?.argv).toEqual([
      "pr",
      "show",
      "130",
      "-P",
      "paas-core/agentrun",
      "--json",
      "--raw",
      "--no-pager",
    ]);
    expect(antCall?.env?.NO_PROXY).toBe("*");
    expect(antCall?.env?.HTTPS_PROXY).toBe("");
    expect(text).toContain("session shutdown recovery");
    expect(text).toContain("docs/plans/2026-09-20-session-shutdown-recovery.md");
    // End-to-end: fetched AntCode description is enough for auto-detect + A1 bind.
    const root = mkdtempSync(join(tmpdir(), "ck-spec-ant-"));
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    const rel = "docs/plans/2026-09-20-session-shutdown-recovery.md";
    writeFileSync(
      join(root, rel),
      ["# Recovery", "", "## 验收", "", "- A1 waiter deregisters on shutdown", ""].join("\n"),
      "utf8",
    );
    const detected = resolveSpecContract({ searchText: text, repoRoot: root });
    expect(detected?.source).toContain(rel);
    expect(detected).not.toBeNull();
    const verify = bindVerifyFromSpec({
      specSource: detected?.source ?? "",
      specText: detected?.text,
    });
    expect(verify?.acceptanceIds).toContain("A1");
  });

  it("returns empty string for unsupported hosts without spawning", async () => {
    let spawned = false;
    const text = await fetchPrSpecSearchText({
      prUrl: "https://example.com/not-a-pr/1",
      runCommand: async () => {
        spawned = true;
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });
    expect(text).toBe("");
    expect(spawned).toBe(false);
  });
});
