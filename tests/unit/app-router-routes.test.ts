import "./app-dom-install";

import { CompareReportsPage } from "@/app/pages/CompareReportsPage";
import { HomePage } from "@/app/pages/HomePage";
import { IdeatePage } from "@/app/pages/IdeatePage";
import { ReportDetailPage } from "@/app/pages/ReportDetailPage";
import { ReportsPage } from "@/app/pages/ReportsPage";
import { RoomPage } from "@/app/pages/RoomPage";
import { SettingsPage } from "@/app/pages/SettingsPage";
import { router } from "@/app/router";
import { AppShell } from "@/components/layout/AppShell";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

describe("app router", () => {
  it("registers every shell route and leaves report detail unwrapped", () => {
    expect(router.routes.map((route) => route.path)).toEqual([
      "/",
      "/rooms/new",
      "/rooms/:roomId",
      "/templates",
      "/settings",
      "/ideate",
      "/reports",
      "/reports/compare/:leftId/:rightId",
      "/reports/:runId",
    ]);

    const shell = (path: string) => {
      const route = router.routes.find((item) => item.path === path) as
        | { element?: ReactElement<{ children: ReactElement }> }
        | undefined;
      return route?.element as ReactElement<{ children: ReactElement }>;
    };

    expect(shell("/").type).toBe(AppShell);
    expect(shell("/").props.children.type).toBe(HomePage);
    expect(shell("/rooms/:roomId").props.children.type).toBe(RoomPage);
    expect(shell("/settings").props.children.type).toBe(SettingsPage);
    expect(shell("/ideate").props.children.type).toBe(IdeatePage);
    expect(shell("/reports").props.children.type).toBe(ReportsPage);
    expect(shell("/reports/compare/:leftId/:rightId").props.children.type).toBe(CompareReportsPage);
    expect(shell("/templates").props.children.props).toEqual({
      title: "模板 (P1)",
      hint: "Agent 模板管理将在后续版本提供。",
    });

    const detail = router.routes.find((route) => route.path === "/reports/:runId") as
      | { element?: ReactElement }
      | undefined;
    expect(detail?.element?.type).toBe(ReportDetailPage);
  });
});
