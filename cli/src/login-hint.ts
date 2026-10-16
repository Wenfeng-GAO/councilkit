/** Driver id → local CLI executable the operator logs into. */
const CLI_BY_DRIVER: Record<string, string> = {
  "claude-stream-json": "cld",
  "kimi-stream-json": "kimi",
  "codex-app-server": "codex",
  "grok-stream-json": "grok",
  "cursor-stream-json": "cursor-agent",
};

export function cliNameForDriver(driverId: string): string | undefined {
  return CLI_BY_DRIVER[driverId];
}

/** UI-matching login hint: 「先运行 `kimi login`」. */
export function loginHintForCli(cli: string): string {
  return `先运行 \`${cli} login\``;
}

export function loginHintForDriver(driverId: string): string | null {
  const cli = cliNameForDriver(driverId);
  return cli === undefined ? null : loginHintForCli(cli);
}

export function isAuthRequiredError(error: unknown): boolean {
  if (error !== null && typeof error === "object") {
    const row = error as { code?: unknown; runtimeCode?: unknown };
    if (row.code === "AUTH_REQUIRED" || row.runtimeCode === "AUTH_REQUIRED") return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\bAUTH_REQUIRED\b/.test(message);
}

export function withLoginHint(message: string, driverId: string): string {
  const hint = loginHintForDriver(driverId);
  if (hint === null) return message;
  const cli = cliNameForDriver(driverId);
  if (message.includes(hint) || (cli !== undefined && message.includes(`${cli} login`))) {
    return message;
  }
  return `${message}（${hint}）`;
}
