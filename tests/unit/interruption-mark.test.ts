import { readFileSync } from "node:fs";
import { ExecutionInterruptedCard } from "@/components/report/ExecutionInterruptedCard";
import { ContextBar } from "@/components/report/workbench/ContextBar";
import { SeatColumn } from "@/components/report/workbench/SeatColumn";
import { StatusPill } from "@/components/shared/StatusPill";
import { cliRunDetailResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

const TOKEN = 'data-interrupt-token="--ck-interrupt"';
const ICON = 'data-interrupt-icon="circle-pause"';

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [0, 2, 4].map((offset) => {
      const value = Number.parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function tokenHex(css: string, name: string): string {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`missing ${name}`);
  return match[1].toLowerCase();
}

describe("interruption mark", () => {
  it("uses one amber token with AA contrast on the dark surfaces", () => {
    const css = readFileSync("src/styles/globals.css", "utf8");
    expect(css).toMatch(/--color-warn:\s*var\(--ck-interrupt\)/);
    const amber = tokenHex(css, "--ck-interrupt");
    for (const surface of ["--color-bg", "--ck-content", "--ck-seats", "--color-surface"]) {
      expect(contrast(amber, tokenHex(css, surface))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("puts the same token and circle-pause icon on the list, top bar, card, and summary seat", () => {
    const run = cliRunDetailResponseSchema.parse({
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4",
      kind: "review",
      status: "interrupted",
      title: "acme/payments #348",
      startedAt: "2026-10-16T11:00:00.000Z",
      endedAt: null,
      hasReport: false,
      reportUrl: "/reports/ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4",
      markdown: "",
      truncated: false,
      progress: {
        phase: "aggregating",
        updatedAt: "2026-10-16T11:00:00.000Z",
        attempts: [
          {
            attemptId: "attempt-security",
            agentName: "review-security",
            driverId: "grok-stream-json",
            modelId: "grok-4.6",
            role: "attempt",
            status: "success",
            durationMs: 1000,
            lastActivity: null,
          },
          {
            attemptId: "aggregator",
            agentName: "review-adversarial",
            driverId: "grok-stream-json",
            modelId: "grok-4.6",
            role: "aggregator",
            status: "cancelled",
            durationMs: 1000,
            lastActivity: null,
          },
        ],
      },
    });
    const surfaces = [
      renderToStaticMarkup(createElement(StatusPill, { tone: "warn", text: "中断" })),
      renderToStaticMarkup(
        createElement(MemoryRouter, null, createElement(ContextBar, { run, hostStatus: "online" })),
      ),
      renderToStaticMarkup(
        createElement(
          MemoryRouter,
          null,
          createElement(ExecutionInterruptedCard, {
            heading: "h1",
            busy: false,
            onReReview: () => {},
          }),
        ),
      ),
      renderToStaticMarkup(
        createElement(SeatColumn, {
          attempts: run.progress?.attempts ?? [],
          hasRepair: true,
          lostExecution: true,
        }),
      ),
    ];
    for (const html of surfaces) {
      expect(html).toContain(TOKEN);
      expect(html).toContain(ICON);
    }
    const sidebar = surfaces[3] ?? "";
    expect(sidebar).toContain("结果汇总");
    expect(sidebar).toContain("中断");
    expect(sidebar).not.toContain("已取消");
    expect(sidebar).toContain("执行完成");
  });
});
