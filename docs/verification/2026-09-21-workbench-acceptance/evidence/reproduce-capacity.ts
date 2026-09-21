import type { AttemptLiveEvent } from "../../../../shared/runtime/attempt-live-events";
import {
  PROCESS_WINDOW_LINES,
  PROCESS_WINDOW_STEP,
  chunkedWindow,
} from "../../../../src/components/report/workbench/seatDetailModel";
import { foldLiveEvents } from "../../../../src/lib/live-transcript";

const limit = 2 * 1024 * 1024;
const events: AttemptLiveEvent[] = [];
let bytes = 0;
for (let seq = 1; ; seq++) {
  const event: AttemptLiveEvent = {
    seq,
    at: "2026-09-21T00:00:00Z",
    type: seq % 2 ? "text.delta" : "thinking.delta",
    text: "x".repeat(48),
  };
  const size = Buffer.byteLength(`${JSON.stringify(event)}\n`);
  if (bytes + size > limit) break;
  bytes += size;
  events.push(event);
}
const blocks = foldLiveEvents(events);
// 2026-09-21 修复后：「显示更早」分段扩展（每次 +200 行），不再一次性渲染全部。
const initial = chunkedWindow(blocks.length, PROCESS_WINDOW_LINES);
const afterOneExpansion = chunkedWindow(blocks.length, PROCESS_WINDOW_LINES + PROCESS_WINDOW_STEP);
console.log(
  JSON.stringify({
    scope: "Production fold function + window chunk helpers; no browser lag claim",
    fixtureBytes: bytes,
    events: events.length,
    foldedBlocks: blocks.length,
    initialWindow: Math.min(PROCESS_WINDOW_LINES, blocks.length),
    domRowsAfterFirstPaint: blocks.length - initial.hiddenCount,
    domRowsAfterOneExpansion: blocks.length - afterOneExpansion.hiddenCount,
    expansionStep: PROCESS_WINDOW_STEP,
    unboundedFullRender: blocks.length,
    note: "fixed: expansion is chunked; DOM rows stay bounded (200 + k×200)",
  }),
);
