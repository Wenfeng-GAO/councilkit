import type { ContextSnapshot, SnapshotItem } from "@shared/runtime/schemas";

/**
 * Deterministic text rendering of a Context Snapshot (or its incremental
 * tail) for a single turn. The renderer is the ONLY place where structured
 * discussion items become CLI prompt text, so full and incremental turns are
 * byte-comparable.
 */

export function renderItem(item: SnapshotItem): string {
  switch (item.role) {
    case "user":
      return `[user]\n${item.content}`;
    case "summary":
      return `[summary]\n${item.content}`;
    case "participant":
      return `[participant ${item.participantId ?? "unknown"}]\n${item.content}`;
  }
}

export function renderItems(items: readonly SnapshotItem[]): string {
  return items.map(renderItem).join("\n\n");
}

/**
 * Renders items[fromIndex:] plus the instruction. Full turns use
 * fromIndex = 0 and include the shared-context header; incremental turns
 * contain only the new items and the instruction (the Session already holds
 * the prefix).
 */
export function renderTurn(
  snapshot: ContextSnapshot,
  fromIndex: number,
): { prompt: string; itemCount: number } {
  const items = snapshot.roomContext.items.slice(fromIndex);
  const parts: string[] = [];
  if (fromIndex === 0) {
    const header = [
      `# Discussion context (revision ${snapshot.roomContext.contextRevision})`,
      snapshot.roomContext.topic ? `Topic: ${snapshot.roomContext.topic}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    parts.push(header);
  }
  if (items.length > 0) {
    parts.push(renderItems(items));
  }
  parts.push(`# Instruction (${snapshot.instruction.kind})\n${snapshot.instruction.text}`);
  return { prompt: parts.join("\n\n"), itemCount: snapshot.roomContext.items.length };
}
