import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeError } from "@shared/runtime/errors";
import { type ReviewJuryResponse, reviewJuryResponseSchema } from "@shared/runtime/review-jury";
import { resolveCouncilkitSpawn } from "../cli-launcher";
import { type Route, httpError } from "../server";

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
  } catch {
    throw httpError(
      400,
      makeError(
        "BAD_REQUEST",
        "discovery",
        "default product-jury is missing; run `councilkit init`",
        { retryable: false },
      ),
    );
  }
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
