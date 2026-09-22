/** Cursor-style stream-json lines for orchestrator.log (preserves call_id). */

export type CursorLine = Record<string, unknown>;

export function textProgress(
  text: string,
  opts: { sessionId?: string; model?: string; at?: string; roleHint?: string } = {},
): CursorLine {
  return {
    type: "assistant",
    timestamp: opts.at,
    session_id: opts.sessionId,
    model: opts.model,
    role_hint: opts.roleHint,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

export function thinkingBlock(text: string, opts: { sessionId?: string; at?: string } = {}): CursorLine {
  return {
    type: "assistant",
    timestamp: opts.at,
    session_id: opts.sessionId,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: text }],
    },
  };
}

export function toolStarted(
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: { sessionId?: string; at?: string; model?: string } = {},
): CursorLine {
  return {
    type: "tool_call",
    subtype: "started",
    call_id: callId,
    toolCallId: callId,
    timestamp: opts.at,
    session_id: opts.sessionId,
    model: opts.model,
    tool_call: {
      [toolName]: { args },
    },
  };
}

export function toolCompleted(
  callId: string,
  toolName: string,
  result: Record<string, unknown>,
  opts: { sessionId?: string; at?: string; model?: string; failed?: boolean } = {},
): CursorLine {
  return {
    type: "tool_call",
    subtype: "completed",
    call_id: callId,
    toolCallId: callId,
    timestamp: opts.at,
    session_id: opts.sessionId,
    model: opts.model,
    status: opts.failed ? "failed" : "completed",
    tool_call: {
      [toolName]: { result },
    },
  };
}

export function shellStarted(
  callId: string,
  command: string,
  opts: { sessionId?: string; at?: string; cwd?: string } = {},
): CursorLine {
  return toolStarted(
    callId,
    "shellToolCall",
    { command, cwd: opts.cwd ?? "/tmp/example.test-workspace" },
    opts,
  );
}

export function shellCompleted(
  callId: string,
  command: string,
  output: string,
  exitCode: number,
  opts: { sessionId?: string; at?: string } = {},
): CursorLine {
  return toolCompleted(
    callId,
    "shellToolCall",
    {
      success: exitCode === 0,
      exitCode,
      command,
      stdout: output,
      stderr: exitCode === 0 ? "" : output,
    },
    { ...opts, failed: exitCode !== 0 },
  );
}

export function readStarted(
  callId: string,
  path: string,
  opts: { sessionId?: string; at?: string } = {},
): CursorLine {
  return toolStarted(callId, "readToolCall", { path }, opts);
}

export function readCompleted(
  callId: string,
  path: string,
  content: string,
  opts: { sessionId?: string; at?: string } = {},
): CursorLine {
  return toolCompleted(callId, "readToolCall", { success: { path, content } }, opts);
}

export function editStarted(
  callId: string,
  path: string,
  opts: { sessionId?: string; at?: string } = {},
): CursorLine {
  return toolStarted(callId, "editToolCall", { path }, opts);
}

export function editCompleted(
  callId: string,
  path: string,
  diff: string | null,
  opts: { sessionId?: string; at?: string } = {},
): CursorLine {
  return toolCompleted(
    callId,
    "editToolCall",
    diff === null
      ? { success: { path, diffRecorded: false } }
      : { success: { path, diffRecorded: true, diff } },
    opts,
  );
}

export function lineJson(line: CursorLine): string {
  return `${JSON.stringify(line)}\n`;
}

export function linesJson(lines: CursorLine[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length > 0 ? "\n" : "");
}
