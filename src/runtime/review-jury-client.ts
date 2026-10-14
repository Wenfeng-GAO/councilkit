import { CSRF_HEADER_NAME } from "@shared/runtime/contracts";
import {
  type ReviewJuryUpdate,
  reviewJuryResponseSchema,
  reviewJuryUpdateSchema,
} from "@shared/runtime/review-jury";
import { readCsrfToken } from "./bootstrap";
import { readOkData } from "./host-envelope";

/** Separate CLI configuration surface; leaves the discussion RuntimeClient unchanged. */
export async function readOrSaveReviewJury(config?: ReviewJuryUpdate) {
  const response = await fetch("/api/v1/review-jury", {
    method: config ? "POST" : "GET",
    credentials: "same-origin",
    headers: config
      ? { "Content-Type": "application/json", [CSRF_HEADER_NAME]: readCsrfToken() }
      : {},
    body: config ? JSON.stringify(reviewJuryUpdateSchema.parse(config)) : undefined,
  });
  return readOkData(response, reviewJuryResponseSchema, {
    fallbackMessage: "无法读取默认席位，请确认 Host 已更新并重启。",
  });
}
