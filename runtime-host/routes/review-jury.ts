import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeError } from "@shared/runtime/errors";
import {
  type ReviewJuryResponse,
  type ReviewJuryUpdate,
  reviewJuryResponseSchema,
  reviewJuryUpdateSchema,
} from "@shared/runtime/review-jury";
import { resolveCouncilkitSpawn } from "../cli-launcher";
import { type HttpError, type Route, httpError } from "../server";

const exec = promisify(execFile);
export async function runJuryCli(config?: ReviewJuryUpdate): Promise<ReviewJuryResponse> {
  const spec = resolveCouncilkitSpawn();
  if (!spec) throw httpError(500, makeError("INTERNAL", "discovery", "找不到本地 CLI，请先构建。"));
  try {
    const args = config
      ? ["jury", "save", "--config", JSON.stringify(config), "--json"]
      : ["jury", "show", "--json"];
    const { stdout } = await exec(spec.execPath, [...spec.argvPrefix, ...args], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      cwd: process.cwd(),
      env: process.env,
    });
    return reviewJuryResponseSchema.parse(JSON.parse(stdout));
  } catch (error) {
    throw reviewJuryFailure(error);
  }
}

const MISSING_REVIEW_JURY =
  "无法读取或保存默认席位。请检查 CLI 配置；尚未初始化时先运行 councilkit init。";
const REVIEW_JURY_CONFLICT = "默认席位已被修改，请重新加载后再保存。";

function reviewJuryFailure(error: unknown): HttpError {
  const cliMessage = cliFailureMessage(error);
  if (cliMessage?.includes("JURY_CONFLICT")) {
    return httpError(
      409,
      makeError("BAD_REQUEST", "discovery", REVIEW_JURY_CONFLICT, { retryable: true }),
    );
  }
  if (cliMessage !== null && /no council matches/i.test(cliMessage)) {
    return httpError(
      400,
      makeError("BAD_REQUEST", "discovery", MISSING_REVIEW_JURY, { retryable: false }),
    );
  }
  const message = cliMessage ?? "无法读取或保存默认席位。";
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

/** The Host delegates persistence to the CLI. Serialize saves from browser tabs. */
export function reviewJuryRoutes(run: typeof runJuryCli = runJuryCli): Route[] {
  let tail: Promise<unknown> = Promise.resolve();
  return [
    {
      method: "GET",
      pattern: "/api/v1/review-jury",
      auth: "session",
      responseSchema: reviewJuryResponseSchema,
      handler: () => run(),
    },
    {
      method: "POST",
      pattern: "/api/v1/review-jury",
      auth: "mutation",
      bodySchema: reviewJuryUpdateSchema,
      responseSchema: reviewJuryResponseSchema,
      handler: (ctx) => {
        const next = tail.then(() => run(ctx.body as ReviewJuryUpdate));
        tail = next.catch(() => undefined);
        return next;
      },
    },
  ];
}
