/**
 * Normalize raw source records into RepairOperation upserts.
 */
import {
  type RawSourceRecord,
  type RepairOperation,
  foldPublicText,
  markUnfinishedTools,
  normalizeToolRecords,
  upsertOperations,
} from "@shared/runtime/repair-observation";

export function normalizeRecords(
  records: RawSourceRecord[],
  generation: string,
  nowMs: number,
): RepairOperation[] {
  const stamped = records.map((row) => ({ ...row, sourceGeneration: generation }));
  const textOps = foldPublicText(stamped);
  const toolOps = normalizeToolRecords(stamped);
  return markUnfinishedTools(upsertOperations(textOps, toolOps), nowMs);
}
