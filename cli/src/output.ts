/**
 * Human/JSON dual output (`--json` discipline, D1 §4). In JSON mode, progress
 * and diagnostics go to stderr and stdout carries exactly one final JSON
 * document at the end. In human mode (default), progress goes to stdout and the
 * final JSON document is instead rendered as readable text.
 *
 * Errors are always redacted before reaching either stream.
 */
import { redact, summarizeZodIssue } from "./redact";

export interface OutputSink {
  readonly json: boolean;
  /** Progress / diagnostic line. stderr in JSON mode, stdout in human mode. */
  progress(message: string): void;
  /** Diagnostic line, always stderr (even in human mode it is a side-channel). */
  diag(message: string): void;
  /** Emit the final result document. JSON mode → stdout (single JSON object);
   * human mode → stdout as readable text. */
  finish(data: unknown, humanRender?: (data: unknown) => string): void;
}

export function createOutput(json: boolean): OutputSink {
  return {
    json,
    progress(message) {
      const stream = json ? process.stderr : process.stdout;
      stream.write(`${redact(message)}\n`);
    },
    diag(message) {
      process.stderr.write(`${redact(message)}\n`);
    },
    finish(data, humanRender) {
      if (json) {
        // Single JSON document on stdout (cleared of secrets).
        process.stdout.write(`${JSON.stringify(redact(data))}\n`);
      } else {
        const text = humanRender ? humanRender(data) : JSON.stringify(data, null, 2);
        process.stdout.write(`${redact(text)}\n`);
      }
    },
  };
}

/** Render a structured CLI error for the terminal. In JSON mode the caller emits
 * the structured object on stdout; in human mode this returns a readable line. */
export function renderErrorHuman(err: {
  name: string;
  exitCode?: number;
  message: string;
  detail?: Record<string, unknown> | undefined;
}): string {
  const code = err.exitCode ?? 1;
  let line = `error[${code}]: ${err.message}`;
  if (err.detail && Object.keys(err.detail).length > 0) {
    const detailStr = JSON.stringify(redact(err.detail));
    line += `\n  detail: ${detailStr}`;
  }
  // Redact the whole rendered line so a cookie/CSRF in the message or detail can
  // never reach the terminal.
  return redact(line) as string;
}

/** Summarize a zod failure into a short, secret-free message. */
export function zodFailureMessage(
  issues: Array<{ path?: PropertyKey[]; code?: string; message?: string }>,
  context: string,
): string {
  const summarized = issues.slice(0, 5).map((issue) => summarizeZodIssue(issue));
  return `${context}: ${JSON.stringify(summarized)}${
    issues.length > 5 ? ` (…${issues.length - 5} more)` : ""
  }`;
}
