import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeError } from "@shared/runtime/errors";
import { type ReviewJuryResponse, reviewJuryResponseSchema } from "@shared/runtime/review-jury";
import { resolveCouncilkitSpawn } from "../cli-launcher";
import { type HttpError, type Route, httpError } from "../server";

const exec = promisify(execFile);

export async function runProductJuryCli(): Promise<ReviewJuryResponse> {
  const spec = resolveCouncilkitSpawn();
  if (!spec) throw httpError(500, makeError("INTERNAL", "discovery", "找不到本地 CLI，请先构建。"));
  try {
    const { stdout } = await exec(
      spec.execPath,
      [...spec.argvPrefix, "jury", "show", "--council", "product-jury", "--json"],
      {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        cwd: process.cwd(),
        env: process.env,
      },
    );
    return reviewJuryResponseSchema.parse(JSON.parse(stdout));
  } catch (error) {
    throw productJuryFailure(error);
  }
}

const MISSING_PRODUCT_JURY = "default product-jury is missing; run `councilkit init`";

function productJuryFailure(error: unknown): HttpError {
  const cliMessage = cliFailureMessage(error);
  if (cliMessage !== null && /no council matches/i.test(cliMessage)) {
    return httpError(
      400,
      makeError("BAD_REQUEST", "discovery", MISSING_PRODUCT_JURY, { retryable: false }),
    );
  }
  const message = cliMessage ?? "cannot read product-jury";
  return httpError(
    400,
    makeError("BAD_REQUEST", "discovery", clipMessage(message), { retryable: false }),
  );
}

function cliFailureMessage(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("stdout" in error)) return null;
  const stdout = String(error.stdout).trim();
  if (stdout.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const message = (parsed as { error?: { message?: unknown } }).error?.message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clipMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length <= 512 ? oneLine : `${oneLine.slice(0, 511)}…`;
}

export function productJuryRoutes(run: typeof runProductJuryCli = runProductJuryCli): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/v1/product-jury",
      auth: "session",
      responseSchema: reviewJuryResponseSchema,
      handler: () => run(),
    },
  ];
}
