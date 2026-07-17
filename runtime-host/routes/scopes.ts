import { type ACK_STATES, QUOTAS } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import {
  ackRequestSchema,
  ackResponseSchema,
  closeScopeResponseSchema,
  controllerRequestSchema,
  createScopeRequestSchema,
  createScopeResponseSchema,
  executeRequestSchema,
  executeResponseSchema,
  executionStatusSchema,
  scopeStatusSchema,
  takeoverControllerRequestSchema,
  takeoverControllerResponseSchema,
} from "@shared/runtime/schemas";
import type { ExecutionRegistry } from "../executions/execution-registry";
import type { ScopeManager } from "../scopes/scope-manager";
import { type HostServices, type Route, httpError } from "../server";

/**
 * Scope/execution API routes. Event streams use SSE framing over
 * authenticated fetch (never EventSource) with `afterSeq` resume; replay is
 * strictly greater-than the given seq and never re-dispatches the model.
 */
export function scopeRoutes(services: HostServices): Route[] {
  const scopes = services.scopeManager as ScopeManager;
  const executions = services.executionRegistry as ExecutionRegistry;

  return [
    {
      method: "POST",
      pattern: "/api/v1/scopes",
      auth: "mutation",
      bodySchema: createScopeRequestSchema,
      responseSchema: createScopeResponseSchema,
      handler: async ({ body }) => scopes.createScope(body as never),
    },
    {
      method: "GET",
      pattern: "/api/v1/scopes/:scopeId",
      auth: "session",
      responseSchema: scopeStatusSchema,
      handler: ({ params }) => scopes.getScopeStatus(params.scopeId as string),
    },
    {
      method: "POST",
      pattern: "/api/v1/scopes/:scopeId/activate",
      auth: "mutation",
      bodySchema: controllerRequestSchema,
      responseSchema: scopeStatusSchema,
      handler: ({ params, body }) => {
        const { controllerId, leaseEpoch } = body as { controllerId: string; leaseEpoch: number };
        return scopes.activateScope(params.scopeId as string, controllerId, leaseEpoch);
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/scopes/:scopeId/controller",
      auth: "mutation",
      bodySchema: takeoverControllerRequestSchema,
      responseSchema: takeoverControllerResponseSchema,
      handler: ({ params, body }) => {
        const { controllerId } = body as { controllerId: string };
        return scopes.takeover(params.scopeId as string, controllerId);
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/scopes/:scopeId/executions",
      auth: "mutation",
      bodySchema: executeRequestSchema,
      responseSchema: executeResponseSchema,
      handler: async ({ params, body }) => {
        const outcome = await scopes.execute(params.scopeId as string, body as never);
        return {
          execution: {
            executionId: outcome.executionId,
            participantId: (body as { participantId: string }).participantId,
            state: outcome.state,
            lastSeq: outcome.lastSeq,
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/scopes/:scopeId/executions/:executionId",
      auth: "session",
      responseSchema: executionStatusSchema,
      handler: ({ params }) => {
        const record = executions.get(params.executionId as string);
        if (!record) {
          throw httpError(404, makeError("EXECUTION_NOT_FOUND", "dispatch", "Unknown execution."));
        }
        return {
          executionId: record.executionId,
          participantId: record.participantId,
          state: record.state,
          lastSeq: record.lastSeq,
        };
      },
    },
    {
      method: "GET",
      pattern: "/api/v1/scopes/:scopeId/executions/:executionId/events",
      auth: "session",
      raw: true,
      handler: ({ req, res, params, query }) => {
        if (executions.eventConnectionCount() >= QUOTAS.maxEventConnections) {
          throw httpError(
            429,
            makeError("RESOURCE_LIMIT", "quota", "Event connection quota reached.", {
              retryable: true,
              retryAfterMs: 1000,
            }),
          );
        }
        const executionId = params.executionId as string;
        const afterSeqRaw = query.get("afterSeq");
        const afterSeq = afterSeqRaw ? Number.parseInt(afterSeqRaw, 10) : 0;
        if (!Number.isFinite(afterSeq) || afterSeq < 0) {
          throw httpError(400, makeError("BAD_REQUEST", "stream", "Invalid afterSeq."));
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          Connection: "keep-alive",
        });
        res.write(": councilkit-event-stream\n\n");

        let closed = false;
        const heartbeat = setInterval(() => {
          if (!closed) res.write(": hb\n\n");
        }, 15_000);
        heartbeat.unref?.();

        const unsubscribe = executions.follow(executionId, afterSeq, (event) => {
          if (closed) return;
          res.write(`event: runtime\ndata: ${JSON.stringify(event)}\n\n`);
        });
        if (!unsubscribe) {
          clearInterval(heartbeat);
          res.write(`event: error\ndata: ${JSON.stringify({ code: "EXECUTION_NOT_FOUND" })}\n\n`);
          res.end();
          return;
        }

        req.on("close", () => {
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          res.end();
        });
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/scopes/:scopeId/executions/:executionId/ack",
      auth: "mutation",
      bodySchema: ackRequestSchema,
      responseSchema: ackResponseSchema,
      handler: ({ params, body }) => {
        const ack = body as {
          controllerId: string;
          leaseEpoch: number;
          finalSeq: number;
          disposition: "committed" | "discarded";
        };
        const result = scopes.ack(
          params.scopeId as string,
          params.executionId as string,
          ack.finalSeq,
          ack.disposition,
          { controllerId: ack.controllerId, leaseEpoch: ack.leaseEpoch },
        );
        return {
          executionId: result.executionId,
          ackState: result.ackState as (typeof ACK_STATES)[number],
          disposition: result.disposition,
        };
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/scopes/:scopeId/executions/:executionId/cancel",
      auth: "mutation",
      bodySchema: controllerRequestSchema,
      handler: async ({ params, body }) => {
        const controller = body as { controllerId: string; leaseEpoch: number };
        await scopes.cancel(params.scopeId as string, params.executionId as string, controller);
        return { executionId: params.executionId, state: "cancelling" };
      },
    },
    {
      method: "POST",
      pattern: "/api/v1/scopes/:scopeId/close",
      auth: "mutation",
      bodySchema: controllerRequestSchema,
      responseSchema: closeScopeResponseSchema,
      handler: async ({ params, body }) => {
        const controller = body as { controllerId: string; leaseEpoch: number };
        return scopes.closeScope(params.scopeId as string, controller);
      },
    },
  ];
}
