import {
  type RepairEvidence,
  type RepairEventDetail,
  type RepairObservation,
  repairEvidenceSchema,
  repairEventDetailSchema,
  repairObservationSchema,
} from "@shared/runtime/repair-observation";
import { RuntimeClientError } from "./client";

async function sessionGetJson<T>(
  path: string,
  schema: { parse(data: unknown): T },
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    signal: signal ?? null,
  });
  const envelope = (await response.json()) as {
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  };
  if (!response.ok || !envelope.ok) {
    throw new RuntimeClientError(
      response.status,
      envelope.error?.code ?? "UNKNOWN",
      envelope.error?.message ?? `HTTP ${response.status}`,
    );
  }
  return schema.parse(envelope.data);
}

export function fetchRepairObservation(input: {
  runId: string;
  round?: string | number;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}): Promise<RepairObservation> {
  const query = new URLSearchParams();
  query.set("round", String(input.round ?? "current"));
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.limit) query.set("limit", String(input.limit));
  return sessionGetJson(
    `/api/v1/cli-runs/${encodeURIComponent(input.runId)}/repair/observation?${query}`,
    repairObservationSchema,
    input.signal,
  );
}

export function fetchRepairEventDetail(input: {
  runId: string;
  eventId: string;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<RepairEventDetail> {
  const query = new URLSearchParams();
  if (input.cursor) query.set("cursor", input.cursor);
  const qs = query.toString();
  return sessionGetJson(
    `/api/v1/cli-runs/${encodeURIComponent(input.runId)}/repair/events/${encodeURIComponent(input.eventId)}${qs ? `?${qs}` : ""}`,
    repairEventDetailSchema,
    input.signal,
  );
}

export function fetchRepairEvidence(input: {
  runId: string;
  round?: string | number;
  signal?: AbortSignal;
}): Promise<RepairEvidence> {
  const query = new URLSearchParams();
  if (input.round !== undefined) query.set("round", String(input.round));
  const qs = query.toString();
  return sessionGetJson(
    `/api/v1/cli-runs/${encodeURIComponent(input.runId)}/repair/evidence${qs ? `?${qs}` : ""}`,
    repairEvidenceSchema,
    input.signal,
  );
}

export async function exportRepairEvidence(input: {
  runId: string;
  round?: string | number;
  format: "json" | "md";
  signal?: AbortSignal;
}): Promise<{ blob: Blob; filename: string }> {
  const query = new URLSearchParams();
  query.set("format", input.format);
  if (input.round !== undefined) query.set("round", String(input.round));
  const response = await fetch(
    `/api/v1/cli-runs/${encodeURIComponent(input.runId)}/repair/evidence/export?${query}`,
    {
      method: "GET",
      credentials: "same-origin",
      signal: input.signal ?? null,
    },
  );
  if (!response.ok) {
    throw new RuntimeClientError(response.status, "UNKNOWN", `HTTP ${response.status}`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? `${input.runId}-evidence.${input.format}`;
  return { blob: await response.blob(), filename };
}
