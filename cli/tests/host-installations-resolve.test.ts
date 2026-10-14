/**
 * Installation selection for doctor/models/run: trusted-only, host order, and
 * the structured zero-trusted error.
 */
import type { InstallationDto, InstallationsResponse } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "../src/errors";
import { listTrusted, resolveInstallations } from "../src/host/installations";

function inst(
  installationId: string,
  driverId: InstallationDto["driverId"],
  state: InstallationDto["state"],
): InstallationDto {
  return {
    installationId,
    driverId,
    state,
    executablePath: null,
    fingerprint: null,
    components: [],
    detail: null,
  };
}

describe("resolveInstallations", () => {
  it("throws NO_TRUSTED_INSTALLATION with exit 3 when nothing trusted matches", () => {
    const response: InstallationsResponse = {
      installations: [
        inst("d1", "cursor-stream-json", "discovering"),
        inst("d2", "cursor-stream-json", "discovered"),
        inst("d3", "cursor-stream-json", "changed"),
        inst("d4", "cursor-stream-json", "not_found"),
        inst("d5", "cursor-stream-json", "invalid"),
        inst("other", "kimi-stream-json", "trusted"),
      ],
    };
    expect(listTrusted(response, "cursor-stream-json")).toEqual([]);
    let caught: unknown;
    try {
      resolveInstallations(response, "cursor-stream-json");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    const err = caught as CliError;
    expect(err.name).toBe("CliError");
    expect(err.exitCode).toBe(EXIT.hostUnavailable);
    expect(err.exitCode).toBe(3);
    expect(err.message).toBe(
      'no trusted installation for driver "cursor-stream-json" (install some software or run the browser once, then retry)',
    );
    expect(err.detail).toEqual({
      code: "NO_TRUSTED_INSTALLATION",
      driverId: "cursor-stream-json",
      trustedCandidates: 0,
    });
  });

  it("throws the same error for an empty installations list", () => {
    const response: InstallationsResponse = { installations: [] };
    let caught: unknown;
    try {
      resolveInstallations(response, "grok-stream-json");
    } catch (error) {
      caught = error;
    }
    const err = caught as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.detail).toEqual({
      code: "NO_TRUSTED_INSTALLATION",
      driverId: "grok-stream-json",
      trustedCandidates: 0,
    });
  });

  it("selects the only trusted installation for the driver", () => {
    const only = inst("only", "codex-app-server", "trusted");
    const response: InstallationsResponse = {
      installations: [inst("nope", "codex-app-server", "changed"), only],
    };
    expect(listTrusted(response, "codex-app-server")).toEqual([only]);
    expect(resolveInstallations(response, "codex-app-server")).toEqual({
      installationId: "only",
      driverId: "codex-app-server",
      trustedCandidateCount: 1,
    });
  });

  it("keeps host order and records every trusted candidate without dropping the rest", () => {
    const first = inst("first", "claude-stream-json", "trusted");
    const second = inst("second", "claude-stream-json", "trusted");
    const third = inst("third", "claude-stream-json", "trusted");
    const response: InstallationsResponse = {
      installations: [
        inst("skip", "claude-stream-json", "discovered"),
        first,
        inst("other-driver", "kimi-stream-json", "trusted"),
        second,
        inst("changed", "claude-stream-json", "changed"),
        third,
      ],
    };
    expect(listTrusted(response, "claude-stream-json")).toEqual([first, second, third]);
    expect(resolveInstallations(response, "claude-stream-json")).toEqual({
      installationId: "first",
      driverId: "claude-stream-json",
      trustedCandidateCount: 3,
    });
    expect(resolveInstallations(response, "kimi-stream-json")).toEqual({
      installationId: "other-driver",
      driverId: "kimi-stream-json",
      trustedCandidateCount: 1,
    });
  });
});
