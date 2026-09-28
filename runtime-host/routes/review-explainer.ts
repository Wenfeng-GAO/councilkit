import { readCliRun } from "@shared/runtime/cli-runs-index";
import { makeError } from "@shared/runtime/errors";
import { canExportRepairPackage } from "@shared/runtime/review-case";
import { decisionSchema } from "@shared/runtime/review-explainer/decisions";
import { ExplainerError } from "@shared/runtime/review-explainer/io";
import {
  decisionForFinding,
  loadPrDecisions,
  upsertPrDecision,
} from "@shared/runtime/review-explainer/pr-decisions";
import { buildRepairPackageFromSelection } from "@shared/runtime/review-explainer/repair-selection";
import { z } from "zod";
import { reviewComparison } from "../review-explainer/comparison";
import {
  ExplanationExecutionError,
  createExplanationService,
  explanationAgents,
} from "../review-explainer/explanations";
import { readFrozenFile, readFrozenReview, reviewWorkspace } from "../review-explainer/workspace";
import { type HostServices, type Route, httpError } from "../server";

const base = "/api/v1/cli-runs/:runId/review-explainer";
const expectedAgentSchema = z
  .object({
    modelId: z.string().min(1).max(256),
    driverId: z.string().min(1).max(128),
  })
  .strict();
const explanationRequestSchema = z
  .object({
    agentId: z.string().min(1).max(160).optional(),
    expectedAgent: expectedAgentSchema.optional(),
  })
  .strict();
const explanationQuerySchema = z
  .object({
    agentId: z.string().min(1).max(160).optional(),
    expectedModelId: expectedAgentSchema.shape.modelId.optional(),
    expectedDriverId: expectedAgentSchema.shape.driverId.optional(),
  })
  .strict()
  .refine(
    (query) => (query.expectedModelId === undefined) === (query.expectedDriverId === undefined),
    "Expected model and driver must be supplied together",
  );
function guarded(action: Route["handler"]): Route["handler"] {
  return async (ctx) => {
    try {
      return await action(ctx);
    } catch (error) {
      const status = error instanceof ExplainerError ? error.status : 400;
      const message = error instanceof ExplainerError ? error.message : "评审解读数据无效或不可用";
      throw httpError(
        status,
        makeError(
          error instanceof ExplanationExecutionError
            ? error.code
            : status === 404
              ? "NOT_FOUND"
              : status === 403
                ? "FORBIDDEN"
                : status >= 500
                  ? "INTERNAL"
                  : "BAD_REQUEST",
          "discovery",
          message,
          { retryable: status >= 500 || status === 409 },
        ),
      );
    }
  };
}
export function reviewExplainerRoutes(services: HostServices): Route[] {
  const explanation = createExplanationService(services);
  return [
    {
      method: "GET",
      pattern: base,
      auth: "session",
      handler: guarded((ctx) => reviewWorkspace(ctx.params.runId ?? "")),
    },
    {
      method: "GET",
      pattern: `${base}/comparison`,
      auth: "session",
      handler: guarded((ctx) => {
        const mode = ctx.query.get("mode") ?? "full";
        if (mode !== "full" && mode !== "last-commit")
          throw new ExplainerError("Invalid comparison mode");
        return reviewComparison(ctx.params.runId ?? "", mode);
      }),
    },
    {
      method: "GET",
      pattern: `${base}/files/:fileKey`,
      auth: "session",
      handler: guarded((ctx) => {
        const side = ctx.query.get("side") ?? "new";
        if (side !== "old" && side !== "new") throw new ExplainerError("Invalid source side");
        return readFrozenFile(
          readFrozenReview(ctx.params.runId ?? ""),
          ctx.params.fileKey ?? "",
          side,
        );
      }),
    },
    {
      method: "POST",
      pattern: `${base}/decisions`,
      auth: "mutation",
      bodySchema: z
        .object({
          findingId: z.string().min(1).max(160),
          decision: decisionSchema,
          expectedRevision: z.number().int().nonnegative(),
          reason: z.string().max(2000).optional(),
        })
        .strict(),
      handler: guarded((ctx) => {
        const body = ctx.body as {
          findingId: string;
          decision: z.infer<typeof decisionSchema>;
          expectedRevision: number;
          reason?: string;
        };
        const runId = ctx.params.runId ?? "";
        const frozen = readFrozenReview(runId);
        const finding = frozen.findings.find((row) => row.id === body.findingId);
        if (!finding) throw new ExplainerError("未知评审点", 404);
        return upsertPrDecision({
          prUrl: frozen.identity.prUrl,
          finding,
          decision: body.decision,
          expectedRevision: body.expectedRevision,
          sourceRunId: runId,
          reason: body.reason,
        });
      }),
    },
    {
      method: "GET",
      pattern: `${base}/repair-package`,
      auth: "session",
      handler: guarded((ctx) => {
        const runId = ctx.params.runId ?? "";
        const frozen = readFrozenReview(runId);
        const stored = loadPrDecisions(frozen.identity.prUrl);
        const decisions = Object.fromEntries(
          frozen.findings.map((row) => [
            row.id,
            decisionForFinding(stored, row) ?? ("undecided" as const),
          ]),
        );
        return buildRepairPackageFromSelection({
          runId,
          complete: canExportRepairPackage(readCliRun(runId)),
          prUrl: frozen.identity.prUrl,
          ledger: { runId, sha: frozen.identity.headSha, findings: frozen.findings },
          decisions,
        });
      }),
    },
    {
      method: "GET",
      pattern: `${base}/explanation-agents`,
      auth: "session",
      handler: guarded((ctx) => explanationAgents(ctx.params.runId ?? "", services)),
    },
    {
      method: "GET",
      pattern: `${base}/explanations/:findingId`,
      auth: "session",
      handler: guarded((ctx) => {
        const query = explanationQuerySchema.parse(Object.fromEntries(ctx.query));
        return explanation(
          ctx.params.runId ?? "",
          ctx.params.findingId ?? "",
          false,
          query.agentId,
          query.expectedModelId !== undefined && query.expectedDriverId !== undefined
            ? { modelId: query.expectedModelId, driverId: query.expectedDriverId }
            : undefined,
        );
      }),
    },
    {
      method: "POST",
      pattern: `${base}/explanations/:findingId`,
      auth: "mutation",
      bodySchema: explanationRequestSchema,
      handler: guarded((ctx) => {
        const body = ctx.body as z.infer<typeof explanationRequestSchema>;
        return explanation(
          ctx.params.runId ?? "",
          ctx.params.findingId ?? "",
          true,
          body.agentId,
          body.expectedAgent,
        );
      }),
    },
  ];
}
