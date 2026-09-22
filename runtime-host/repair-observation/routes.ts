/**
 * Repair observation HTTP routes (read-only).
 * stop/resume stay on existing cli-runs routes — do not re-authorize here.
 */
import { isCliRunId } from "@shared/runtime/cli-runs-index";
import {
  REPAIR_OBS_MAX_RESPONSE_BYTES,
  repairEvidenceSchema,
  repairEventDetailSchema,
  repairObservationSchema,
} from "@shared/runtime/repair-observation";
import { makeError } from "@shared/runtime/errors";
import { type Route, httpError } from "../server";
import { createRepairObservationService } from "./service";

export function repairObservationRoutes(options?: { now?: () => Date }): Route[] {
  const service = createRepairObservationService({ now: options?.now });

  return [
    {
      method: "GET",
      pattern: "/api/v1/cli-runs/:runId/repair/observation",
      auth: "session",
      responseSchema: repairObservationSchema,
      handler: (ctx) => {
        const runId = ctx.params.runId ?? "";
        assertRepairRunId(runId);
        const data = service.getObservation({
          runId,
          roundRaw: ctx.query.get("round"),
          cursorRaw: ctx.query.get("cursor"),
          limitRaw: ctx.query.get("limit"),
        });
        assertResponseSize(data);
        return data;
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/cli-runs/:runId/repair/events/:eventId",
      auth: "session",
      responseSchema: repairEventDetailSchema,
      handler: (ctx) => {
        const runId = ctx.params.runId ?? "";
        assertRepairRunId(runId);
        const eventId = ctx.params.eventId ?? "";
        if (
          eventId.length === 0 ||
          eventId.length > 200 ||
          eventId.includes("..") ||
          eventId.includes("/") ||
          eventId.includes("\\") ||
          eventId.includes("%") ||
          !/^evt_[0-9a-f]+$/i.test(eventId)
        ) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "Invalid event id.", { retryable: false }),
          );
        }
        const data = service.getEventDetail({
          runId,
          eventId,
          cursorRaw: ctx.query.get("cursor"),
        });
        assertResponseSize(data);
        return data;
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/cli-runs/:runId/repair/evidence",
      auth: "session",
      responseSchema: repairEvidenceSchema,
      handler: (ctx) => {
        const runId = ctx.params.runId ?? "";
        assertRepairRunId(runId);
        const data = service.getEvidence({
          runId,
          roundRaw: ctx.query.get("round"),
        });
        assertResponseSize(data);
        return data;
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/cli-runs/:runId/repair/evidence/export",
      auth: "session",
      raw: true,
      handler: (ctx) => {
        const runId = ctx.params.runId ?? "";
        assertRepairRunId(runId);
        const formatRaw = ctx.query.get("format") ?? "json";
        if (formatRaw !== "json" && formatRaw !== "md") {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "format must be json or md.", {
              retryable: false,
            }),
          );
        }
        const exported = service.exportEvidence({
          runId,
          roundRaw: ctx.query.get("round"),
          format: formatRaw,
        });
        if (Buffer.byteLength(exported.body, "utf8") > REPAIR_OBS_MAX_RESPONSE_BYTES) {
          throw httpError(
            400,
            makeError("BAD_REQUEST", "discovery", "export exceeds size limit.", {
              retryable: false,
            }),
          );
        }
        ctx.res.writeHead(200, {
          "Content-Type": exported.contentType,
          "Content-Disposition": `attachment; filename="${exported.filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Length": Buffer.byteLength(exported.body, "utf8"),
        });
        ctx.res.end(exported.body);
      },
    },
  ];
}

function assertRepairRunId(runId: string): void {
  if (!isCliRunId(runId) || !runId.startsWith("ck-repair-")) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "Invalid CLI repair run id.", { retryable: false }),
    );
  }
}

function assertResponseSize(data: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes > REPAIR_OBS_MAX_RESPONSE_BYTES) {
    throw httpError(
      400,
      makeError("BAD_REQUEST", "discovery", "observation response exceeds size limit.", {
        retryable: false,
      }),
    );
  }
}
