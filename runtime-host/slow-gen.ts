import { createHash } from "node:crypto";
import type { DriverId } from "@shared/runtime/contracts";
import { makeError } from "@shared/runtime/errors";
import {
  type GenerationTimeouts,
  generationRule,
  startGenerationWatchdog,
} from "@shared/runtime/generation-timeouts";
import { REPORT_SECTION_HEADINGS } from "@shared/runtime/report-sections";
import {
  SLOW_GEN_CHUNKS,
  SLOW_GEN_CRASH_AT_MS,
  SLOW_GEN_DEMO_MARKER,
  SLOW_GEN_PATH_PREFIX,
  type SlowGenConfig,
} from "@shared/runtime/slow-gen";
import type {
  Emit,
  ExecuteInput,
  ParticipantDriver,
  PrewarmInput,
  PrewarmResult,
} from "./drivers/types";
import type { DiscoveryOutcome, InstallationName } from "./installations/discovery";
import type { ValidationResult } from "./installations/validation";

/**
 * Host side of the test-only COUNCILKIT_SLOW_GEN switch (see
 * shared/runtime/slow-gen.ts). Only main.ts wires it, and only when the env
 * is set: the synthetic installations go through the normal registry, so trust
 * and the Profile check run the same code path as a real CLI.
 */

const NAMES: ReadonlyArray<[InstallationName, DriverId]> = [
  ["cld", "claude-stream-json"],
  ["codex", "codex-app-server"],
  ["kimi", "kimi-stream-json"],
  ["grok", "grok-stream-json"],
  ["cursor-agent", "cursor-stream-json"],
];

/** Catalogs the model pickers show; any requested model id also handshakes. */
const CATALOGS: Record<DriverId, string[]> = {
  "claude-stream-json": ["claude-sonnet-4-5"],
  "codex-app-server": ["gpt-5-codex"],
  "kimi-stream-json": ["kimi-code/k3"],
  "grok-stream-json": ["grok-4.6", "grok-4.5"],
  "cursor-stream-json": ["auto"],
};

const path = (name: string) => `${SLOW_GEN_PATH_PREFIX}${name}`;

export function slowGenDiscovery(): DiscoveryOutcome {
  return {
    installations: NAMES.map(([name, driverId], index) => ({
      name,
      driverId,
      wrapper: { name, path: path(name), source: "path" as const, pathIndex: index },
      claude:
        name === "cld"
          ? { name: "claude" as const, path: path("claude"), source: "path" as const, pathIndex: 0 }
          : null,
      cfuse: null,
    })),
  };
}

/** Validation for the synthetic paths only; anything else is not_found. */
export function slowGenValidate(candidate: string): ValidationResult {
  if (!candidate.startsWith(SLOW_GEN_PATH_PREFIX)) {
    return { ok: false, reason: "not_found", detail: "slow-gen mode: real CLIs are not used" };
  }
  return {
    ok: true,
    record: {
      realpath: candidate,
      fingerprint: `sha256:${createHash("sha256").update(`slow-gen:${candidate}`).digest("hex")}`,
      mode: 0o755,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    },
  };
}

/** The report turn carries the nine headings verbatim as one block (browser
 * and CLI Reporter instructions both embed it); discussion turns do not. */
export function isReportPrompt(prompt: string): boolean {
  return prompt.includes(REPORT_SECTION_HEADINGS.join("\n"));
}

function demoReport(chunks: number): string {
  const body = REPORT_SECTION_HEADINGS.map(
    (heading) => `${heading}\n\n示例内容：慢生成测试（${chunks} 段输出后完成），非真实模型输出。`,
  ).join("\n\n");
  return `${SLOW_GEN_DEMO_MARKER}\n\n${body}\n`;
}

function discussionReply(prompt: string): string {
  const base = "示例发言：慢生成测试，非真实模型输出。";
  return prompt.includes("收敛建议") ? `${base}\n收敛建议：是` : base;
}

export function createSlowGenDriverFactory(
  driverId: DriverId,
  config: SlowGenConfig,
  timeouts: GenerationTimeouts,
): (participantId: string) => ParticipantDriver {
  return (participantId: string): ParticipantDriver => {
    let cancelActive: (() => void) | null = null;

    function complete(input: ExecuteInput, emit: Emit, output: string) {
      emit({
        type: "completed",
        output,
        requestedModel: input.modelId,
        effectiveModel: input.modelId,
        modelVerdict: "match",
        toolState: "none",
        dispatchState: "accepted",
        usage: null,
        finalSeq: 1, // the registry stamps the authoritative finalSeq
      });
    }

    function slowReport(input: ExecuteInput, emit: Emit): Promise<void> {
      return new Promise<void>((resolve) => {
        let chunks = 0;
        let ticker: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const settle = (finish: () => void) => {
          if (settled) return;
          settled = true;
          if (ticker) clearTimeout(ticker);
          watchdog.clear();
          cancelActive = null;
          finish();
          resolve();
        };
        const fail = (error: ReturnType<typeof makeError>) =>
          settle(() =>
            emit({
              type: "failed",
              error,
              dispatchState: "accepted",
              toolState: "none",
              retryable: false,
            }),
          );
        // Same rule (and watchdog) the real driver for this seat uses.
        const rule = generationRule(driverId, timeouts);
        const watchdog = startGenerationWatchdog(rule, () =>
          fail(
            makeError(rule.code, "stream", rule.message, {
              driverId,
              executionId: input.executionId,
              participantId,
              limitMs: rule.limitMs,
            }),
          ),
        );
        cancelActive = () =>
          settle(() =>
            emit({
              type: "interrupted",
              reason: "user_cancelled",
              dispatchState: "accepted",
              toolState: "none",
            }),
          );
        if (config.mode === "silent") return;
        if (config.mode === "crash") {
          ticker = setTimeout(
            () =>
              fail(
                makeError("DRIVER_CRASH", "stream", "slow-gen: model process exited mid-report.", {
                  driverId,
                  executionId: input.executionId,
                  participantId,
                }),
              ),
            SLOW_GEN_CRASH_AT_MS,
          );
          return;
        }
        if (config.mode === "buffered") {
          ticker = setTimeout(() => {
            const report = demoReport(1);
            emit({ type: "output.delta", text: report });
            settle(() => complete(input, emit, report));
          }, config.intervalMs);
          return;
        }
        const tick = () => {
          chunks += 1;
          emit({ type: "output.delta", text: `慢生成片段 ${chunks}/${SLOW_GEN_CHUNKS}\n` });
          watchdog.output();
          if (chunks >= SLOW_GEN_CHUNKS) {
            settle(() => complete(input, emit, demoReport(chunks)));
            return;
          }
          ticker = setTimeout(tick, config.intervalMs);
        };
        ticker = setTimeout(tick, config.intervalMs);
      });
    }

    return {
      participantId,
      driverId,
      sessionEpoch: 0,
      prewarm(input: PrewarmInput): Promise<PrewarmResult> {
        const catalog = [...CATALOGS[driverId]];
        const requested = input.spec.modelId;
        if (requested !== "__catalog__" && !catalog.includes(requested)) catalog.push(requested);
        return Promise.resolve({
          canonicalModelId: requested === "__catalog__" ? (catalog[0] as string) : requested,
          modelAliases: [],
          capability: { protocol: "slow-gen", mode: config.mode },
          catalog,
        });
      },
      execute(input: ExecuteInput, emit: Emit): Promise<void> {
        emit({ type: "started", requestedModel: input.modelId });
        if (isReportPrompt(input.prompt)) return slowReport(input, emit);
        const reply = discussionReply(input.prompt);
        emit({ type: "output.delta", text: reply });
        complete(input, emit, reply);
        return Promise.resolve();
      },
      cancel(): Promise<void> {
        cancelActive?.();
        return Promise.resolve();
      },
      close(): Promise<void> {
        cancelActive?.();
        return Promise.resolve();
      },
      capabilityState: () => "ready",
      contextWindowTokens: () => null,
    };
  };
}
