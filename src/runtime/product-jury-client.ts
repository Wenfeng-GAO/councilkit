import { reviewJuryResponseSchema } from "@shared/runtime/review-jury";
import { RuntimeClientError } from "./client";

/** Read-only product-jury surface. Does not save or edit the stored council. */
export async function readProductJury() {
  const response = await fetch("/api/v1/product-jury", {
    method: "GET",
    credentials: "same-origin",
  });
  const envelope = await response.json();
  if (!response.ok || !envelope.ok)
    throw new RuntimeClientError(
      response.status,
      envelope.error?.code ?? "UNKNOWN",
      envelope.error?.message ?? "无法读取 product-jury，请确认 Host 已更新并重启。",
    );
  return reviewJuryResponseSchema.parse(envelope.data);
}
