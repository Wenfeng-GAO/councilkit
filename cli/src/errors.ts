/**
 * CLI exit-code table (D1 fused verdict). Every fatal path returns one of
 * these codes; `CliError` carries the code so the entrypoint can exit precisely.
 *
 *   0   success
 *   2   usage / schema / reference / validation (reporter required, dangling ref, …)
 *   3   Host unreachable or not ready before a run (incl. 401/403 after one re-auth)
 *   4   run execution failure (turn / Reporter / ACK / SSE / Host restart / cleanup)
 *   5   local store / report IO failure
 *   7   Host quota / resource-limit rejection
 *   130 SIGINT (still runs a bounded cleanup first)
 */
export const EXIT = {
  ok: 0,
  usage: 2,
  hostUnavailable: 3,
  runFailed: 4,
  io: 5,
  quota: 7,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface CliErrorOptions {
  code: ExitCode;
  message: string;
  /** Structured machine-readable detail for `--json` consumers (already redacted). */
  detail?: Record<string, unknown>;
  cause?: unknown;
}

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(options: CliErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "CliError";
    this.exitCode = options.code;
    this.detail = options.detail;
  }
}

/** Convenience constructors. */
export const errors = {
  usage: (message: string, detail?: Record<string, unknown>): CliError =>
    new CliError({ code: EXIT.usage, message, detail }),
  hostUnavailable: (message: string, detail?: Record<string, unknown>): CliError =>
    new CliError({ code: EXIT.hostUnavailable, message, detail }),
  runFailed: (message: string, detail?: Record<string, unknown>): CliError =>
    new CliError({ code: EXIT.runFailed, message, detail }),
  io: (message: string, detail?: Record<string, unknown>): CliError =>
    new CliError({ code: EXIT.io, message, detail }),
  quota: (message: string, detail?: Record<string, unknown>): CliError =>
    new CliError({ code: EXIT.quota, message, detail }),
};

/** Map the Host/shared structured error code onto a CLI exit code. The mapping
 * covers the vocabulary in shared/runtime/errors.ts. Unknown codes default to
 * `runFailed` (4) for in-run faults and `hostUnavailable` (3) for pre-run faults. */
export function exitCodeForHostCode(hostCode: string, phase: "pre-run" | "run"): ExitCode {
  switch (hostCode) {
    case "RESOURCE_LIMIT":
    case "RATE_LIMITED":
      return EXIT.quota;
    case "UNAUTHENTICATED":
    case "FORBIDDEN":
    case "CSRF_MISMATCH":
    case "AUTH_REQUIRED":
    case "STALE_CONTROLLER":
    case "INSTALLATION_NOT_FOUND":
    case "INSTALLATION_INVALID":
    case "INSTALLATION_UNTRUSTED":
    case "INSTALLATION_CHANGED":
    case "INCOMPATIBLE_DRIVER":
    case "PROFILE_INVALID":
      return phase === "pre-run" ? EXIT.hostUnavailable : EXIT.runFailed;
    case "PORT_IN_USE":
    case "UNSUPPORTED_NODE":
      return EXIT.hostUnavailable;
    default:
      return phase === "pre-run" ? EXIT.hostUnavailable : EXIT.runFailed;
  }
}
