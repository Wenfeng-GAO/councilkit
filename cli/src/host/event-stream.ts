/**
 * SSE execution event stream (brief §2c, D1 §1). Imported, not reimplemented,
 * from the browser's verified `src/runtime/event-stream.ts` so the CLI cannot
 * drift from the Host's framing. The CLI-specific reconnect/afterSeq policy and
 * auth handling live in `execute-turn.ts`, which composes this reader.
 */
export {
  followExecutionEvents,
  type FollowEventsOptions,
  type EventStreamFetchInput,
  type FollowOutcome,
} from "@/runtime/event-stream";
