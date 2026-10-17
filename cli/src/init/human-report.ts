/**
 * Human layout for `councilkit init`. Symbols carry status (not colour).
 * A summary line counts every council, then each council is its own group.
 * Skips that share a driver and reason merge only inside that group; a single
 * skip stays one line. Global notes (standalone cfuse filling cld) come after
 * both groups. Long driver notes stay in `--json` `next` and the README.
 */
import { isDefaultModelAlias } from "@shared/runtime/default-model-alias";
import type { SkippedSeat } from "../store/schemas";
import { NEXT_REVIEW_HINT } from "./defaults";
import type { DriverStatus, LoginState } from "./driver-status";
import { driverStatusByName } from "./driver-status";
import { NEXT_IDEATE_HINT } from "./ideate-defaults";

const SEAT_WIDTH = 22;
const TOOL_WIDTH = 15;
const VERSION_TOKEN = /\d+\.\d+\.\d+/;

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
  if (name === "review-codex" || name === "ideate-challenger") return "codex";
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

/** cursor-agent builds often print a date, which the column may leave off. */
function shownVersion(tool: string, version: string | null): string | null {
  if (tool === "cursor-agent" || version === null) return null;
  return version.match(VERSION_TOKEN)?.[0] ?? version;
}

function readyLine(
  name: string,
  tool: string,
  version: string | null,
  login: LoginState,
  defaultModel: boolean,
): string {
  const versionText = shownVersion(tool, version);
  const toolText = versionText === null ? tool : `${tool} ${versionText}`;
  const status = defaultModel ? `${loginWords(login)} · default model` : loginWords(login);
  const column = toolText.length >= TOOL_WIDTH ? `${toolText} ` : toolText.padEnd(TOOL_WIDTH);
  return `  ✓ ${name.padEnd(SEAT_WIDTH)} ${column}${status}`;
}

function mergedSkipLines(seats: readonly SkippedSeat[]): string[] {
  const order: string[] = [];
  const groups = new Map<
    string,
    { driver: string; reason: "missing" | "logged-out"; names: string[] }
  >();
  for (const seat of seats) {
    if (seat.reason === "no-model") continue;
    const reason = seat.reason === "logged-out" ? "logged-out" : "missing";
    const key = `${reason}\0${seat.driver}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.names.push(seat.seat);
      continue;
    }
    order.push(key);
    groups.set(key, { driver: seat.driver, reason, names: [seat.seat] });
  }
  return order.flatMap((key) => {
    const group = groups.get(key);
    if (group === undefined) return [];
    const why = group.reason === "missing" ? "not installed" : "not logged in";
    const command = `      ${humanCommand(group.driver, group.reason)}`;
    if (group.names.length === 1) {
      return [`  ✗ ${group.names[0]}  skipped: ${group.driver} ${why}`, command];
    }
    return [
      `  ✗ ${group.names.length} seats skipped: ${group.driver} ${why}`,
      `      ${group.names.join(", ")}`,
      command,
    ];
  });
}

export interface HumanCouncil {
  name: string;
  reporter: string | null;
  ready: Array<{
    name: string;
    tool: string;
    version: string | null;
    login: LoginState;
    defaultModel: boolean;
  }>;
  skipped: SkippedSeat[];
  /** Standalone cfuse is filling review-security because cld is absent. */
  cldSubstitute: boolean;
}

function countable(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function councilSection(council: HumanCouncil): string {
  const skipped = council.skipped.filter((seat) => seat.reason !== "no-model");
  const reporter = council.reporter === null ? "" : ` (reporter ${council.reporter})`;
  const header = `${council.name}${reporter} · ${council.ready.length} ready, ${skipped.length} skipped`;
  return [
    header,
    ...council.ready.map((seat) =>
      readyLine(seat.name, seat.tool, seat.version, seat.login, seat.defaultModel),
    ),
    ...mergedSkipLines(skipped),
  ].join("\n");
}

function summaryLine(councils: readonly HumanCouncil[]): string {
  let ready = 0;
  let skipped = 0;
  for (const council of councils) {
    ready += council.ready.length;
    skipped += council.skipped.filter((seat) => seat.reason !== "no-model").length;
  }
  return `init: ${countable(councils.length, "council", "councils")} · ${countable(ready, "seat", "seats")} ready, ${skipped} skipped`;
}

function globalNotes(councils: readonly HumanCouncil[]): string[] {
  if (!councils.some((council) => council.cldSubstitute)) return [];
  return [
    "  ? cld  not installed (review-security is using standalone cfuse instead)",
    "      for full features, put cld on PATH, then: cld login",
  ];
}

export function renderInitHuman(input: { councils: HumanCouncil[]; failure?: boolean }): string {
  const sections = input.councils.map((council) => councilSection(council)).join("\n\n");
  const notes = globalNotes(input.councils);
  const body = notes.length === 0 ? sections : `${sections}\n\n${notes.join("\n")}`;
  if (input.failure) return body;
  return [
    summaryLine(input.councils),
    "",
    body,
    "",
    "next:",
    `  ${NEXT_REVIEW_HINT}`,
    `  ${NEXT_IDEATE_HINT}`,
    "open reports: http://127.0.0.1:43127/reports",
  ].join("\n");
}

export interface InitCouncilBrief {
  name: string;
  reporter: string | null;
  ready: Array<{ name: string; modelId: string }>;
  skippedSeats: SkippedSeat[];
}

function usesCodexDefault(name: string, modelId: string): boolean {
  return (name === "review-codex" || name === "ideate-challenger") && isDefaultModelAlias(modelId);
}

export function initHumanFromOutcome(input: {
  drivers: readonly DriverStatus[];
  councils: readonly InitCouncilBrief[];
}): string {
  const cld = driverStatusByName(input.drivers, "cld");
  const cfuse = driverStatusByName(input.drivers, "cfuse");
  return renderInitHuman({
    councils: input.councils.map((council) => {
      const readyNames = new Set(council.ready.map((seat) => seat.name));
      return {
        name: council.name,
        reporter: council.reporter,
        ready: council.ready.map((seat) => ({
          name: seat.name,
          defaultModel: usesCodexDefault(seat.name, seat.modelId),
          ...displayTool(seat.name, input.drivers),
        })),
        skipped: council.skippedSeats,
        cldSubstitute:
          council.name === "pr-jury" &&
          readyNames.has("review-security") &&
          !cld.found &&
          cfuse.found,
      };
    }),
  });
}
