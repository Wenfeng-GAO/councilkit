#!/usr/bin/env node
/** Fake independent Orchestrator. Emits a native session_id then stays alive. */
const resumeAt = process.argv.indexOf("--resume");
const resumeId = resumeAt >= 0 ? process.argv[resumeAt + 1] : null;
const expected = process.env.FAKE_GROK_SESSION ?? process.env.GROK_SESSION_ID ?? "fake-native-session";
if (resumeId && resumeId !== expected) {
  process.stderr.write(`resume session mismatch: ${resumeId}\n`);
  process.exit(2);
}
const session = resumeId ?? expected;
process.stdout.write(
  `${JSON.stringify({ type: "system", subtype: "init", session_id: session })}\n`,
);
const timer = setInterval(() => {
  process.stdout.write(`${JSON.stringify({ type: "heartbeat", session_id: session })}\n`);
}, 1000);
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.exit(0);
});
process.on("SIGINT", () => {
  clearInterval(timer);
  process.exit(0);
});
