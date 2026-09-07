import { z } from "zod";
import { reviewModelSchema } from "./schemas";

export const reviewJurySeatSchema = reviewModelSchema
  .extend({ agentId: z.string().min(1).max(128) })
  .strict();
export const reviewJuryUpdateSchema = z
  .object({
    revision: z.string().min(1).max(128),
    seats: z.array(reviewJurySeatSchema).min(1).max(8),
    reporterAgentId: z.string().min(1).max(128),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.seats.map((seat) => seat.agentId)).size !== value.seats.length)
      ctx.addIssue({ code: "custom", message: "席位不可重复" });
    if (!value.seats.some((seat) => seat.agentId === value.reporterAgentId))
      ctx.addIssue({ code: "custom", message: "汇总席位必须参与审查" });
  });
export type ReviewJuryUpdate = z.infer<typeof reviewJuryUpdateSchema>;
export type ReviewJurySeat = z.infer<typeof reviewJurySeatSchema>;
export const reviewJuryResponseSchema = z
  .object({
    revision: z.string().min(1),
    councilId: z.string().min(1),
    seats: z.array(reviewJurySeatSchema),
    reporterAgentId: z.string().min(1),
    agents: z.array(
      reviewJurySeatSchema
        .extend({ name: z.string(), enabled: z.boolean(), color: z.string() })
        .strict(),
    ),
    codexModels: z.array(z.string()),
  })
  .strict();
export type ReviewJuryResponse = z.infer<typeof reviewJuryResponseSchema>;
