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
import { type Route, httpError } from "../server";

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
    const output =
      error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    const conflict = output.includes("JURY_CONFLICT");
    throw httpError(
      conflict ? 409 : 400,
      makeError(
        "BAD_REQUEST",
        "discovery",
        conflict
          ? "默认席位已被修改，请重新加载后再保存。"
          : "无法读取或保存默认席位。请检查 CLI 配置；尚未初始化时先运行 councilkit init。",
        { retryable: conflict },
      ),
    );
  }
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
