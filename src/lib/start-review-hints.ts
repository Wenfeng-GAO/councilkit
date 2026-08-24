import { RuntimeClientError } from "@/runtime/client";

export interface StartReviewHint {
  text: string;
  copyCommand: string | null;
}

/** Map a create-review failure to in-page copy. Never the fix-pipeline 409 string. */
export function mapStartReviewError(error: unknown, pr: string): StartReviewHint {
  const text =
    error instanceof RuntimeClientError
      ? error.message
      : error instanceof Error
        ? error.message
        : "启动审查失败";
  if (/pr-jury/i.test(text) || text.includes("councilkit init")) {
    return { text, copyCommand: "councilkit init" };
  }
  if (/no local clone/i.test(text) || text.includes("--repo")) {
    const url = pr.trim().length > 0 ? pr.trim() : "<pr-url>";
    return { text, copyCommand: `councilkit review ${url} --repo <path>` };
  }
  return { text, copyCommand: null };
}
