import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { DriverId, InstallationState } from "@shared/runtime/contracts";
import { type RuntimeError, makeError } from "@shared/runtime/errors";
import type { InstallationComponent, InstallationDto } from "@shared/runtime/schemas";
import type { Logger } from "../logging";
import { sanitizeString } from "../logging";
import type { DiscoveredInstallation, DiscoveryOutcome, InstallationName } from "./discovery";
import { discoverInstallations } from "./discovery";
import type { ValidationFailureReason, ValidationRecord, ValidationResult } from "./validation";
import { validateExecutable } from "./validation";

/**
 * In-memory Runtime Installation registry (no persistence in V1).
 *
 * Candidates are pinned to validated absolute realpaths with a sha256 content
 * fingerprint; `cld` is a composite installation whose binding covers both the
 * wrapper and the underlying `claude` executable. Trust is assigned only by
 * the V1 auto-promotion rule at discovery refresh — never by any protocol
 * handshake — and drift checks always re-validate the pinned paths instead of
 * re-guessing via PATH. No secrets, environment or file contents beyond the
 * fingerprint ever leave this module (or reach the logs).
 */

/** Structured failure thrown by registry operations; routes map it to HTTP. */
export class InstallationError extends Error {
  constructor(readonly runtimeError: RuntimeError) {
    super(runtimeError.message);
    this.name = "InstallationError";
  }
}

/** Trusted, spawn-ready installation view returned by `assertExecutable`. */
export interface InstallationRecord {
  installationId: string;
  driverId: DriverId;
  name: InstallationName;
  discoveredPath: string;
  realpath: string;
  fingerprint: string;
  state: InstallationState;
  components: InstallationComponent[];
  detail: string | null;
}

export interface InstallationRegistry {
  /** Re-run discovery + validation; applies the V1 auto-promotion rules. */
  refresh(): InstallationDto[];
  list(): InstallationDto[];
  get(installationId: string): InstallationDto | undefined;
  /** Re-check the pinned paths only (never re-guesses via PATH). */
  revalidate(installationId: string): InstallationDto;
  /**
   * Gate for spawning: resolves only when the installation is trusted AND a
   * fresh drift check passes. Throws InstallationError with code
   * INSTALLATION_NOT_FOUND / INSTALLATION_CHANGED / INSTALLATION_UNTRUSTED.
   */
  assertExecutable(installationId: string): InstallationRecord;
}

export interface InstallationRegistryOptions {
  logger: Logger;
  discover?: () => DiscoveryOutcome;
  validate?: (path: string) => ValidationResult;
}

interface PinnedFile {
  discoveredPath: string;
  realpath: string;
  fingerprint: string;
  mode: number;
  uid: number;
  gid: number;
}

interface InternalInstallation {
  installationId: string;
  driverId: DriverId;
  name: InstallationName;
  discoveredPath: string;
  source: "path" | "well-known";
  state: InstallationState;
  /** Present exactly while a full validation has passed at least once. */
  wrapper: PinnedFile | null;
  claude: PinnedFile | null;
  /** Last discovered `claude` candidate path, even when never pinned. */
  claudePath: string | null;
  /** Best-effort realpath for DTOs when nothing is pinned. */
  knownRealpath: string | null;
  detail: string | null;
}

function error(code: RuntimeError["code"], message: string): InstallationError {
  return new InstallationError(makeError(code, "discovery", message, { retryable: false }));
}

export function createInstallationRegistry(
  options: InstallationRegistryOptions,
): InstallationRegistry {
  const { logger } = options;
  const discover = options.discover ?? (() => discoverInstallations());
  const validate = options.validate ?? validateExecutable;
  const records = new Map<string, InternalInstallation>();

  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const detail = (text: string) => sanitizeString(text, 1024);
  const shortId = (value: string) => sanitizeString(value, 128);

  function bestEffortRealpath(path: string): string | null {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  }

  function pin(discoveredPath: string, record: ValidationRecord): PinnedFile {
    return {
      discoveredPath,
      realpath: record.realpath,
      fingerprint: record.fingerprint,
      mode: record.mode,
      uid: record.uid,
      gid: record.gid,
    };
  }

  /** Null when identical; otherwise a short drift description. */
  function pinDrift(pinned: PinnedFile, record: ValidationRecord): string | null {
    if (pinned.realpath !== record.realpath) return "realpath changed";
    if (pinned.fingerprint !== record.fingerprint) return "fingerprint changed";
    if (pinned.mode !== record.mode || pinned.uid !== record.uid || pinned.gid !== record.gid) {
      return "permissions or ownership changed";
    }
    return null;
  }

  /**
   * V1 auto-promotion (discovered → trusted) applies only to candidates found
   * via the inherited PATH or the built-in well-known directories, with a name
   * matching a known driver; the owner and path-chain rules are enforced by
   * validation. A protocol handshake can never establish trust here.
   */
  function promotable(candidate: DiscoveredInstallation): boolean {
    return candidate.wrapper.source === "path" || candidate.wrapper.source === "well-known";
  }

  function failureState(reason: ValidationFailureReason): InstallationState {
    switch (reason) {
      case "not_found":
        return "not_found";
      case "not_executable":
      case "unreadable":
        return "invalid";
      case "bad_owner":
      case "writable_path":
        // Valid program, but the trust policy is not met: stays discovered
        // and can never become executable.
        return "discovered";
    }
  }

  /** Fresh classification with promotion (used for new/unpinned records). */
  function classify(
    candidate: DiscoveredInstallation,
    installationId: string,
    wrapperResult: ValidationResult,
    claudeResult: ValidationResult | null,
  ): InternalInstallation {
    const base = {
      installationId,
      driverId: candidate.driverId,
      name: candidate.name,
      discoveredPath: candidate.wrapper.path,
      source: candidate.wrapper.source,
      claudePath: candidate.claude?.path ?? null,
    };
    const knownRealpath = wrapperResult.ok
      ? wrapperResult.record.realpath
      : bestEffortRealpath(candidate.wrapper.path);
    const unpinned = (state: InstallationState, text: string): InternalInstallation => ({
      ...base,
      state,
      wrapper: null,
      claude: null,
      knownRealpath,
      detail: detail(text),
    });

    if (!wrapperResult.ok) {
      return unpinned(
        failureState(wrapperResult.reason),
        `Wrapper validation failed (${wrapperResult.reason}): ${wrapperResult.detail}`,
      );
    }
    if (candidate.name === "cld") {
      if (!candidate.claude) {
        return unpinned(
          "invalid",
          "Composite installation is incomplete: no `claude` executable found on PATH or the well-known directories.",
        );
      }
      if (!claudeResult || !claudeResult.ok) {
        const reason = claudeResult && !claudeResult.ok ? claudeResult.reason : "not_found";
        const why = claudeResult && !claudeResult.ok ? claudeResult.detail : "missing";
        const state =
          reason === "bad_owner" || reason === "writable_path" ? "discovered" : "invalid";
        return unpinned(state, `claude binary validation failed (${reason}): ${why}`);
      }
      if (!promotable(candidate)) {
        return unpinned("discovered", "Candidate source is not eligible for V1 auto-promotion.");
      }
      return {
        ...base,
        state: "trusted",
        wrapper: pin(candidate.wrapper.path, wrapperResult.record),
        claude: pin(candidate.claude.path, claudeResult.record),
        knownRealpath,
        detail: null,
      };
    }
    if (!promotable(candidate)) {
      return unpinned("discovered", "Candidate source is not eligible for V1 auto-promotion.");
    }
    return {
      ...base,
      state: "trusted",
      wrapper: pin(candidate.wrapper.path, wrapperResult.record),
      claude: null,
      knownRealpath,
      detail: null,
    };
  }

  /** Drift check for pinned records: re-validates the pinned paths only. */
  function driftRevalidate(existing: InternalInstallation): InternalInstallation {
    const wrapperPin = existing.wrapper;
    if (!wrapperPin) return unpinnedRevalidate(existing);
    const wrapperResult = validate(wrapperPin.discoveredPath);
    if (!wrapperResult.ok) {
      if (wrapperResult.reason === "not_found") {
        return {
          ...existing,
          state: "not_found",
          detail: detail(`Pinned executable "${wrapperPin.realpath}" is missing.`),
        };
      }
      return {
        ...existing,
        state: "changed",
        detail: detail(
          `Pinned wrapper no longer validates (${wrapperResult.reason}): ${wrapperResult.detail}`,
        ),
      };
    }
    const wrapperDrift = pinDrift(wrapperPin, wrapperResult.record);
    if (wrapperDrift) {
      return {
        ...existing,
        state: "changed",
        detail: detail(`Pinned wrapper drifted: ${wrapperDrift}.`),
      };
    }
    if (existing.name === "cld") {
      const claudePin = existing.claude;
      if (!claudePin) {
        return {
          ...existing,
          state: "changed",
          detail: "Composite installation lost its pinned claude binary.",
        };
      }
      const claudeResult = validate(claudePin.discoveredPath);
      if (!claudeResult.ok) {
        return {
          ...existing,
          state: "changed",
          detail: detail(
            `Pinned claude binary no longer validates (${claudeResult.reason}): ${claudeResult.detail}`,
          ),
        };
      }
      const claudeDrift = pinDrift(claudePin, claudeResult.record);
      if (claudeDrift) {
        return {
          ...existing,
          state: "changed",
          detail: detail(`Pinned claude binary drifted: ${claudeDrift}.`),
        };
      }
    }
    return { ...existing, state: "trusted", detail: null };
  }

  /** Unpinned re-check: refreshes state but never promotes to trusted. */
  function unpinnedRevalidate(existing: InternalInstallation): InternalInstallation {
    const candidate: DiscoveredInstallation = {
      name: existing.name,
      driverId: existing.driverId,
      wrapper: {
        name: existing.name,
        path: existing.discoveredPath,
        source: existing.source,
        pathIndex: 0,
      },
      claude: existing.claudePath
        ? { name: "claude", path: existing.claudePath, source: existing.source, pathIndex: 0 }
        : null,
    };
    const wrapperResult = validate(existing.discoveredPath);
    const claudeResult = candidate.claude ? validate(candidate.claude.path) : null;
    const fresh = classify(candidate, existing.installationId, wrapperResult, claudeResult);
    if (fresh.state !== "trusted") return fresh;
    return {
      ...fresh,
      state: "discovered",
      detail: "Validation passes, but trust is (re)assigned only at discovery refresh.",
    };
  }

  function toDto(record: InternalInstallation): InstallationDto {
    const components: InstallationComponent[] = [];
    if (record.wrapper) {
      components.push({
        role: "wrapper",
        path: record.wrapper.realpath,
        fingerprint: record.wrapper.fingerprint,
      });
    }
    if (record.claude) {
      components.push({
        role: "claude-binary",
        path: record.claude.realpath,
        fingerprint: record.claude.fingerprint,
      });
    }
    return {
      installationId: record.installationId,
      driverId: record.driverId,
      state: record.state,
      executablePath: record.wrapper?.realpath ?? record.knownRealpath,
      fingerprint: record.wrapper?.fingerprint ?? null,
      components,
      detail: record.detail,
    };
  }

  function sorted(): InternalInstallation[] {
    return [...records.values()].sort((a, b) =>
      a.name === b.name
        ? a.installationId.localeCompare(b.installationId)
        : a.name.localeCompare(b.name),
    );
  }

  function countState(state: InstallationState): number {
    return [...records.values()].filter((record) => record.state === state).length;
  }

  function list(): InstallationDto[] {
    return sorted().map(toDto);
  }

  function refresh(): InstallationDto[] {
    const outcome = discover();
    const seen = new Set<string>();
    for (const candidate of outcome.installations) {
      const wrapperResult = validate(candidate.wrapper.path);
      const claudeResult =
        candidate.name === "cld" && candidate.claude ? validate(candidate.claude.path) : null;
      const realpath = wrapperResult.ok
        ? wrapperResult.record.realpath
        : bestEffortRealpath(candidate.wrapper.path);
      const installationId = `${candidate.name}-${sha256(realpath ?? candidate.wrapper.path).slice(0, 12)}`;
      seen.add(installationId);
      const existing = records.get(installationId);
      if (existing?.wrapper) {
        // Same pinned realpath: drift semantics, never a silent PATH switch.
        records.set(installationId, driftRevalidate(existing));
      } else {
        records.set(
          installationId,
          classify(candidate, installationId, wrapperResult, claudeResult),
        );
      }
    }
    // Candidates no longer discovered (PATH reorder/removal) are re-checked at
    // their pinned paths instead of being dropped or switched.
    for (const [installationId, existing] of records) {
      if (seen.has(installationId)) continue;
      records.set(
        installationId,
        existing.wrapper ? driftRevalidate(existing) : unpinnedRevalidate(existing),
      );
    }
    logger.info("installations.refresh", {
      total: records.size,
      trusted: countState("trusted"),
      discovered: countState("discovered"),
      changed: countState("changed"),
      invalid: countState("invalid"),
      notFound: countState("not_found"),
    });
    return list();
  }

  function get(installationId: string): InstallationDto | undefined {
    const record = records.get(installationId);
    return record ? toDto(record) : undefined;
  }

  function revalidate(installationId: string): InstallationDto {
    const existing = records.get(installationId);
    if (!existing) {
      throw error("INSTALLATION_NOT_FOUND", `Unknown installation "${shortId(installationId)}".`);
    }
    const next = existing.wrapper ? driftRevalidate(existing) : unpinnedRevalidate(existing);
    records.set(installationId, next);
    logger.info("installations.revalidated", {
      installationId: next.installationId,
      state: next.state,
    });
    return toDto(next);
  }

  function assertExecutable(installationId: string): InstallationRecord {
    const existing = records.get(installationId);
    if (!existing) {
      throw error("INSTALLATION_NOT_FOUND", `Unknown installation "${shortId(installationId)}".`);
    }
    if (existing.state === "not_found") {
      throw error(
        "INSTALLATION_NOT_FOUND",
        `Installation "${existing.installationId}" is missing.`,
      );
    }
    if (existing.state === "changed") {
      throw error(
        "INSTALLATION_CHANGED",
        `Installation "${existing.installationId}" changed since validation.`,
      );
    }
    if (existing.state !== "trusted") {
      throw error(
        "INSTALLATION_UNTRUSTED",
        `Installation "${existing.installationId}" is ${existing.state}, not trusted.`,
      );
    }
    const next = driftRevalidate(existing);
    records.set(installationId, next);
    if (next.state === "not_found") {
      throw error(
        "INSTALLATION_NOT_FOUND",
        `Installation "${existing.installationId}" vanished since validation.`,
      );
    }
    if (next.state !== "trusted" || !next.wrapper) {
      throw error(
        "INSTALLATION_CHANGED",
        `Installation "${existing.installationId}" no longer matches its pinned fingerprint.`,
      );
    }
    return {
      installationId: next.installationId,
      driverId: next.driverId,
      name: next.name,
      discoveredPath: next.discoveredPath,
      realpath: next.wrapper.realpath,
      fingerprint: next.wrapper.fingerprint,
      state: next.state,
      components: toDto(next).components,
      detail: next.detail,
    };
  }

  // Synchronous, non-throwing initial discovery: the registry is usable as
  // soon as it is constructed; refresh() can re-run discovery at any time.
  refresh();

  return { refresh, list, get, revalidate, assertExecutable };
}
