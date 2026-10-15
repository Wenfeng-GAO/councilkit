/**
 * Fake seat CLI for tests that need `grok`/`cld`/`codex`/`kimi`/`cursor-agent`
 * on PATH. Since #307/#322 a bare `exit 0` stub is (correctly) NOT ready, so
 * stubs answer their self-check command with the real output shape (shell
 * builtins only: some tests run with PATH=<stub dir>). Other
 * invocations still exit 0 silently.
 */
export const SEAT_CLI_NAMES = ["grok", "cld", "codex", "kimi", "cursor-agent"] as const;

export const SEAT_CLI_STUB = `#!/bin/sh
case "\${0##*/} $*" in
  "cld --version") echo "2.1.0 (Claude Code)" ;;
  "codex --version") echo "codex-cli 0.162.1" ;;
  "kimi provider list") echo "Default model: kimi-code/k3" ;;
  "grok models") printf 'Available models:\\n  * grok-4.7 (default)\\n' ;;
  "cursor-agent models") echo "auto - Auto  (default)" ;;
esac
exit 0
`;

/** Stub body for `name`: real-shaped self-check for seat CLIs, bare exit 0 otherwise. */
export function stubCliBody(name: string): string {
  return (SEAT_CLI_NAMES as readonly string[]).includes(name)
    ? SEAT_CLI_STUB
    : "#!/bin/sh\nexit 0\n";
}
