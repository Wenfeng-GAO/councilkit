import type { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type { DiscussionAgent } from "@/models/discussion/entities";
import { createDiscussionAgent } from "@/models/discussion/factories";
import { type ExecutionProfileRecord, toDto } from "@/models/execution-profile";
import { executionProfileSchema } from "@shared/runtime/schemas";
import { z } from "zod";

/**
 * Agent import/export (S7): JSON file format `councilkit-agents` v1.
 *
 * - secret-free by construction: ExecutionProfileRecord itself never carries
 *   executable paths, argv, shell fragments, raw env or tokens (see
 *   execution-profile.ts), and the exported profileSnapshot passes the strict
 *   `toDto()` zod contract on the way out — a secret cannot be serialized.
 * - `executionProfileId` is the ONLY binding basis. `profileSnapshot` exists
 *   so an unbound card can display "需要 Profile：名/driver"; it is NEVER used
 *   to auto-bind by content (matching by snapshot = guessing execution
 *   semantics — rejected; ruling #5).
 * - Import is atomic per file: bad JSON / bad schema / missing fields reject
 *   the WHOLE file with zero writes. An unknown profileId imports fine but
 *   lands 「待绑定」 via the existing dangling-executionProfileId semantics
 *   (AgentConfigCard "未知 Profile", NewRoom disabled checkbox) and is listed
 *   in the returned `unbound` roster.
 */

export const AGENT_EXPORT_FORMAT = "councilkit-agents";
export const AGENT_EXPORT_VERSION = 1;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const agentExportEntrySchema = z
  .object({
    name: z.string().min(1),
    personaPrompt: z.string().min(1),
    modelId: z.string().min(1),
    color: z.string().regex(HEX_COLOR),
    /** Absent on pre-S7 files: defaults to true on import. */
    enabled: z.boolean().optional(),
    executionProfileId: z.string().min(1),
    /** Display-only snapshot for unbound cards; never a binding basis. Null
     * when the source Agent's Profile was already dangling at export time. */
    profileSnapshot: executionProfileSchema.nullable(),
  })
  .strict();

export const agentExportFileSchema = z
  .object({
    format: z.literal(AGENT_EXPORT_FORMAT),
    version: z.literal(AGENT_EXPORT_VERSION),
    exportedAt: z.string().min(1),
    agents: z.array(agentExportEntrySchema),
  })
  .strict();

export type AgentExportFile = z.infer<typeof agentExportFileSchema>;

export function exportAgents(
  agents: readonly DiscussionAgent[],
  profiles: readonly ExecutionProfileRecord[],
): string {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const file: AgentExportFile = {
    format: AGENT_EXPORT_FORMAT,
    version: AGENT_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    agents: agents.map((agent) => {
      const profile = profilesById.get(agent.executionProfileId);
      return {
        name: agent.name,
        personaPrompt: agent.personaPrompt,
        modelId: agent.modelId,
        color: agent.color,
        enabled: agent.enabled,
        executionProfileId: agent.executionProfileId,
        // toDto() re-validates against the strict shared schema on the way out.
        profileSnapshot: profile ? toDto(profile) : null,
      };
    }),
  };
  return JSON.stringify(file, null, 2);
}

export type ImportAgentsResult =
  | { ok: true; imported: DiscussionAgent[]; unbound: DiscussionAgent[] }
  | { ok: false; error: string };

export async function importAgents(
  db: CouncilKitRuntimeDB,
  json: string,
): Promise<ImportAgentsResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "文件不是合法 JSON。" };
  }
  const validated = agentExportFileSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, error: "文件格式不符合 councilkit-agents v1 导出格式。" };
  }
  // Build every record in memory first (fresh ids, revision=1 via the factory,
  // whose validation re-runs here): any single failure rejects the whole file
  // before ANY write — the atomic-reject contract.
  const candidates: DiscussionAgent[] = [];
  try {
    for (const entry of validated.data.agents) {
      const created = createDiscussionAgent({
        name: entry.name.trim(),
        personaPrompt: entry.personaPrompt,
        executionProfileId: entry.executionProfileId,
        modelId: entry.modelId,
        color: entry.color,
      });
      candidates.push({ ...created, enabled: entry.enabled ?? true });
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Agent 校验失败。" };
  }
  return db.transaction("rw", [db.agents, db.executionProfiles], async () => {
    const unbound: DiscussionAgent[] = [];
    for (const candidate of candidates) {
      const profile = await db.executionProfiles.get(candidate.executionProfileId);
      // Unknown profileId: import succeeds, the dangling reference IS the
      // existing 「待绑定」 semantics. profileSnapshot is never consulted here.
      if (!profile) unbound.push(candidate);
    }
    await db.agents.bulkAdd(candidates);
    return { ok: true as const, imported: candidates, unbound };
  });
}
