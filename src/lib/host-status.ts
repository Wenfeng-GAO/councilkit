import { RuntimeClientError } from "@/runtime/client";

export const HOST_DOWN_TITLE = "Host 未在 127.0.0.1:43127";
export const HOST_DOWN_HINT =
  "观察 squad / review 过程需要 Runtime Host 读 sidecar。请先 `pnpm start`，或用 launchd 托管（`node scripts/install-service.mjs`）。";

export function isHostUnreachableError(error: unknown): boolean {
  if (error instanceof RuntimeClientError) {
    return error.status === 502 || error.status === 503 || error.status === 504;
  }
  if (error instanceof TypeError || error instanceof SyntaxError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|networkerror|load failed|econnrefused/i.test(message);
}
