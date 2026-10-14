import { reviewJuryResponseSchema } from "@shared/runtime/review-jury";
import { readOkData } from "./client";

/** Read-only product-jury surface. Does not save or edit the stored council. */
export async function readProductJury() {
  const response = await fetch("/api/v1/product-jury", {
    method: "GET",
    credentials: "same-origin",
  });
  return readOkData(response, reviewJuryResponseSchema, {
    fallbackMessage: "无法读取 product-jury，请确认 Host 已更新并重启。",
  });
}
