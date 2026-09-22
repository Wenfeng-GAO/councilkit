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
import { createExplanationService } from "../review-explainer/explanations";
import { readFrozenFile, readFrozenReview, reviewWorkspace } from "../review-explainer/workspace";
import { type HostServices, type Route, httpError } from "../server";

const base = "/api/v1/cli-runs/:runId/review-explainer";
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
          status === 404
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
        })
        .strict(),
      handler: guarded((ctx) => {
        const body = ctx.body as {
          findingId: string;
          decision: z.infer<typeof decisionSchema>;
          expectedRevision: number;
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
      pattern: `${base}/explanations/:findingId`,
      auth: "session",
      handler: guarded((ctx) =>
        explanation(
          ctx.params.runId ?? "",
          ctx.params.findingId ?? "",
          false,
          ctx.query.get("agentId") ?? undefined,
        ),
      ),
    },
    {
      method: "POST",
      pattern: `${base}/explanations/:findingId`,
      auth: "mutation",
      bodySchema: z.object({ agentId: z.string().min(1).max(160).optional() }).strict(),
      handler: guarded((ctx) =>
        explanation(
          ctx.params.runId ?? "",
          ctx.params.findingId ?? "",
          true,
          (ctx.body as { agentId?: string }).agentId,
        ),
      ),
    },
  ];
}
