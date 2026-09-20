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

const REVIEW_RUN_ID = /^ck-review-[0-9a-fA-F-]+$/;

/** Read optional PR / against overrides from the reports page query string. */
export function parseStartReviewQuery(search: string): { pr?: string; against?: string } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const pr = params.get("pr")?.trim() ?? "";
  const against = params.get("against")?.trim() ?? "";
  return {
    ...(pr.length > 0 ? { pr } : {}),
    ...(REVIEW_RUN_ID.test(against) ? { against } : {}),
  };
}

export function mapStartIdeateError(error: unknown): StartReviewHint {
  const text =
    error instanceof RuntimeClientError
      ? error.message
      : error instanceof Error
        ? error.message
        : "启动创意讨论失败";
  if (/product-jury/i.test(text) || text.includes("councilkit init")) {
    return { text, copyCommand: "councilkit init" };
  }
  return { text, copyCommand: null };
}
