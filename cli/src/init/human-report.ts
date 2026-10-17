/**
 * Human layout for `councilkit init`. Symbols carry status (not colour).
 * Long driver notes stay in `--json` `next` and the README.
 */
import type { SkippedSeat } from "../store/schemas";
import { NEXT_REVIEW_HINT } from "./defaults";
import type { DriverStatus, LoginState } from "./driver-status";
import { driverStatusByName } from "./driver-status";
import { NEXT_IDEATE_HINT } from "./ideate-defaults";
import { CODEX_MODEL_COMMAND } from "./skipped-seats";

const SEAT_WIDTH = 22;
const TOOL_WIDTH = 24;

export function loginWords(login: LoginState): "logged in" | "not logged in" | "login not checked" {
  if (login === "logged-in") return "logged in";
  if (login === "logged-out") return "not logged in";
  return "login not checked";
}

export function displayTool(
  seatName: string,
  drivers: readonly DriverStatus[],
): { tool: string; version: string | null; login: LoginState } {
  if (seatName === "review-security") {
    const cld = driverStatusByName(drivers, "cld");
    const cfuse = driverStatusByName(drivers, "cfuse");
    if (!cld.found && cfuse.found) {
      return { tool: "cfuse", version: cfuse.version, login: cfuse.login };
    }
    return { tool: "cld", version: cld.version, login: cld.login };
  }
  const executable = executableForSeat(seatName);
  const row = drivers.find((item) => item.driver === executable);
  return {
    tool: executable,
    version: row?.version ?? null,
    login: row?.login ?? "unknown",
  };
}

function executableForSeat(name: string): string {
  if (name === "review-maintainability" || name === "ideate-engineering") return "kimi";
  if (name === "review-correctness" || name === "review-adversarial" || name === "ideate-product") {
    return "grok";
  }
  if (name === "review-cursor") return "cursor-agent";
  if (name === "ideate-challenger") return "codex";
  return name;
}

function humanCommand(driver: string, reason: "missing" | "logged-out"): string {
  if (reason === "logged-out") return `${driver} login`;
  switch (driver) {
    case "cld":
      return "put cld on PATH, then: cld login";
    case "codex":
      return "npm install -g @openai/codex, then: codex login";
    case "cursor-agent":
      return "curl https://cursor.com/install -fsS | bash, then: cursor-agent login";
    case "kimi":
      return "install kimi so it's on PATH, then: kimi login";
    case "grok":
      return "install grok so it's on PATH, then: grok login";
    case "cfuse":
      return "install cfuse so it's on PATH";
    default:
      return `install ${driver}, then: ${driver} login`;
  }
}

function readyLine(name: string, tool: string, version: string | null, login: LoginState): string {
  const versionText = version ?? "version unknown";
  return `  ✓ ${name.padEnd(SEAT_WIDTH)} ${`${tool} ${versionText}`.padEnd(TOOL_WIDTH)} ${loginWords(login)}`;
}

function skippedLines(seat: SkippedSeat): string[] {
  const reason = seat.reason === "logged-out" ? "logged-out" : "missing";
  const why = reason === "missing" ? "not installed" : "not logged in";
  return [
    `  ✗ ${seat.seat}  skipped: ${seat.driver} ${why}`,
    `      ${humanCommand(seat.driver, reason)}`,
  ];
}

function partialLines(input: {
  codexModel: boolean;
  cldUsesCfuse: boolean;
}): string[] {
  const lines: string[] = [];
  if (input.codexModel) {
    lines.push("  ? codex  logged in, no model configured — seat not created");
    lines.push(`      set a model: ${CODEX_MODEL_COMMAND}`);
  }
  if (input.cldUsesCfuse) {
    lines.push("  ? cld  not installed (review-security is using standalone cfuse instead)");
    lines.push("      for full features, put cld on PATH, then: cld login");
  }
  return lines;
}

export interface HumanInitInput {
  ready: Array<{ name: string; tool: string; version: string | null; login: LoginState }>;
  skipped: SkippedSeat[];
  codexModel: boolean;
  cldUsesCfuse: boolean;
  council: { name: string; reporter: string } | null;
  /** Failure text lists seats only. Success adds the header, next commands, and reports URL. */
  failure?: boolean;
}

export function renderInitHuman(input: HumanInitInput): string {
  const skipped = input.skipped.filter((seat) => seat.reason !== "no-model");
  const body = [
    ...input.ready.map((seat) => readyLine(seat.name, seat.tool, seat.version, seat.login)),
    ...skipped.flatMap((seat) => skippedLines(seat)),
    ...partialLines({ codexModel: input.codexModel, cldUsesCfuse: input.cldUsesCfuse }),
  ];
  if (input.failure) return body.join("\n");
  const readyLabel =
    input.ready.length === 1 ? "1 seat ready" : `${input.ready.length} seats ready`;
  const council =
    input.council === null
      ? "no council"
      : `council ${input.council.name} (reporter ${input.council.reporter})`;
  return [
    `init: ${readyLabel}, ${skipped.length} skipped · ${council}`,
    ...body,
    "",
    "next:",
    `  ${NEXT_REVIEW_HINT}`,
    `  ${NEXT_IDEATE_HINT}`,
    "open reports: http://127.0.0.1:43127/reports",
  ].join("\n");
}

export function initHumanFromOutcome(input: {
  createdAgents: Array<{ name: string }>;
  reusedAgents: Array<{ name: string }>;
  drivers: readonly DriverStatus[];
  skippedSeats: SkippedSeat[];
  createdCouncil: { name: string; reporter: string } | null;
  reusedCouncil: { name: string; reporter: string } | null;
}): string {
  const seen = new Set<string>();
  const ready = [...input.createdAgents, ...input.reusedAgents].flatMap((agent) => {
    if (seen.has(agent.name)) return [];
    seen.add(agent.name);
    return [{ name: agent.name, ...displayTool(agent.name, input.drivers) }];
  });
  const cld = driverStatusByName(input.drivers, "cld");
  const cfuse = driverStatusByName(input.drivers, "cfuse");
  return renderInitHuman({
    ready,
    skipped: input.skippedSeats,
    codexModel: input.skippedSeats.some((seat) => seat.reason === "no-model"),
    cldUsesCfuse: seen.has("review-security") && !cld.found && cfuse.found,
    council: input.createdCouncil ?? input.reusedCouncil,
  });
}
