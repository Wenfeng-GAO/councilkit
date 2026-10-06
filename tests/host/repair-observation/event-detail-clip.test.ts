import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairObservationRoutes } from "@host/repair-observation/routes";
import type { HostServices, RouteContext } from "@host/server";
import {
  REPAIR_OBS_DETAIL_CHUNK,
  type RepairEventDetail,
  type RepairObservation,
} from "@shared/runtime/repair-observation";
import { afterEach, beforeEach, expect, it } from "vitest";

const RUN_ID = "ck-repair-00000000-0000-4000-8000-000000000164";

let home: string;
let oldHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-repair-detail-clip-"));
  oldHome = process.env.COUNCILKIT_HOME;
  process.env.COUNCILKIT_HOME = home;
});

afterEach(() => {
  if (oldHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

function ctx(query: Record<string, string>, params: Record<string, string>): RouteContext {
  return {
    body: undefined,
    params,
    query: new URLSearchParams(query),
    req: {} as IncomingMessage,
    res: {
      writeHead() {
        return this;
      },
      end() {
        return this;
      },
    } as unknown as ServerResponse,
    services: {} as HostServices,
  };
}

it("keeps a 64KB event detail body on a code-point boundary when redaction shifts an emoji", async () => {
  const taskDir = join(home, "squad-tasks", "task-1");
  const runDir = join(home, "runs", RUN_ID);
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "repair.json"),
    JSON.stringify({
      version: 1,
      casVersion: 0,
      sourceRunId: "ck-review-00000000-0000-4000-8000-000000000001",
      profileName: "default",
      outerUsed: 1,
      outerMax: 3,
      timeoutMs: null,
      businessResult: null,
      reasonCode: null,
      goalSummary: "clip",
      frozenBaseSha: "b".repeat(40),
      candidateSha: null,
      resumeEligible: false,
      protocolVersion: "v2",
      cycles: [
        {
          n: 1,
          phase: "active",
          childReviewId: null,
          squadTaskId: "task-1",
          squadTaskDir: taskDir,
        },
      ],
    }),
  );

  const emoji = "😀";
  const prefix =
    '{"type":"tool.completed","callId":"c1","name":"bash","summary":"emoji-cut","role":"coder","at":"2026-09-22T06:00:01Z","output":"authorization: x ';
  const emojiAt = 65526;
  const filler = "a".repeat(emojiAt - Buffer.byteLength(prefix));
  const line = `${prefix}${filler}${emoji}zzzzzz"}`;
  writeFileSync(join(taskDir, "orchestrator.log"), `${line}\n`);

  const routes = repairObservationRoutes({ now: () => new Date("2026-09-22T06:00:05Z") });
  const list = routes.find((route) => route.pattern.endsWith("/repair/observation"));
  const detail = routes.find((route) => route.pattern.endsWith("/repair/events/:eventId"));
  if (!list || !detail) throw new Error("missing observation routes");

  const page = (await list.handler(
    ctx({ round: "current" }, { runId: RUN_ID }),
  )) as RepairObservation;
  const event = page.upserts.find((row) => row.summary.startsWith("emoji-cut"));
  expect(event?.eventId).toMatch(/^evt_/);
  if (!event) throw new Error("missing emoji-cut event");

  const body = (await detail.handler(
    ctx({}, { runId: RUN_ID, eventId: event.eventId }),
  )) as RepairEventDetail;

  expect(body.availability).toBe("available");
  expect(body.body).toContain("[REDACTED]");
  expect(body.body).not.toContain("authorization: x");
  expect(body.body).toHaveLength(REPAIR_OBS_DETAIL_CHUNK - 1);
  expect(body.body.endsWith("a")).toBe(true);
  expect(body.body.includes(emoji)).toBe(false);
  expect(Buffer.from(body.body, "utf8").toString("utf8")).toBe(body.body);
});
