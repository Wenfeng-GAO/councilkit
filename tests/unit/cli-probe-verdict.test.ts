import { classifyCliProbe } from "@shared/runtime/cli-probe";
/**
 * #307 / #322: one readiness judgement for all seat CLIs (Host Settings rows,
 * `councilkit doctor` via /health, and the CLI lightweight probe). Exit 0 is
 * not enough; the output must look like the real CLI.
 */
import { DRIVER_IDS, type DriverId } from "@shared/runtime/contracts";
import { describe, expect, it } from "vitest";

// Real probe output shapes (box runs 2026-10-16 + ADR-0012 for kimi).
const REAL: Record<DriverId, string> = {
  "claude-stream-json": "2.1.0 (Claude Code)\n",
  "codex-app-server": "codex-cli 0.162.1\n",
  "kimi-stream-json": "Default model: kimi-code/k3\n",
  "grok-stream-json":
    "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n",
  "cursor-stream-json": "Available models\n\nauto - Auto  (default)\ngpt-5 - GPT-5\n",
};

const ok = (text: string) => ({ code: 0, timedOut: false, text });

describe("seat CLI readiness verdict (#307 / #322)", () => {
  it("CLI-07 #307 fake grok: exit 0 with no output or garbage is check_failed", () => {
    expect(classifyCliProbe("grok-stream-json", ok(""))).toBe("check_failed");
    expect(classifyCliProbe("grok-stream-json", ok("ok\n"))).toBe("check_failed");
    expect(classifyCliProbe("grok-stream-json", ok("%%% ??? garbled output 0xDEAD\n"))).toBe(
      "check_failed",
    );
  });

  it("CLI-07 #322 codex garbled + exit 0 is check_failed (and the same for every seat CLI)", () => {
    for (const driverId of DRIVER_IDS) {
      expect(classifyCliProbe(driverId, ok("%%% ??? garbled output 0xDEAD\n")), driverId).toBe(
        "check_failed",
      );
      expect(classifyCliProbe(driverId, ok("")), driverId).toBe("check_failed");
    }
  });

  it("real CLI output shapes are ready", () => {
    for (const driverId of DRIVER_IDS) {
      expect(classifyCliProbe(driverId, ok(REAL[driverId])), driverId).toBe("ready");
    }
  });

  it("real-looking output with a non-zero exit, a timeout, or an auth error is not ready", () => {
    expect(
      classifyCliProbe("codex-app-server", {
        code: 1,
        timedOut: false,
        text: REAL["codex-app-server"],
      }),
    ).toBe("check_failed");
    expect(classifyCliProbe("grok-stream-json", { code: null, timedOut: true, text: "" })).toBe(
      "check_failed",
    );
    expect(
      classifyCliProbe("kimi-stream-json", {
        code: 1,
        timedOut: false,
        text: "Error: not logged in. Please run kimi login",
      }),
    ).toBe("not_logged_in");
  });
});
