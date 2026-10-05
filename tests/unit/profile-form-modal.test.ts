import { ProfileFormModal } from "@/components/settings/ProfileFormModal";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
import { CREDENTIAL_MODE, type DriverId } from "@shared/runtime/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const KIMI_NOTE =
  "Kimi 的模型在 Agent 中从闭集目录（kimi-code/k3）选择；Profile 不保存模型、argv 或凭据，无可编辑选项。";
const GROK_NOTE =
  "Grok 的模型在 Agent 中从闭集目录（grok-4.6 / grok-4.5）选择；Profile 不保存模型、argv 或凭据，无可编辑选项。";
const CURSOR_NOTE =
  "Cursor 的模型在 Agent 中从 cursor-agent 实时目录选择（auto 使用账号默认）；Profile 不保存模型、argv 或凭据，无可编辑选项。";

function optionsFor(driverId: DriverId): ExecutionProfileRecord["options"] {
  switch (driverId) {
    case "claude-stream-json":
      return { route: "cfuse" };
    case "codex-app-server":
      return { reasoningEffort: "medium" };
    case "kimi-stream-json":
    case "grok-stream-json":
    case "cursor-stream-json":
      return {};
    default: {
      const unreachable: never = driverId;
      throw new Error(unreachable);
    }
  }
}

function profile(driverId: DriverId): ExecutionProfileRecord {
  return {
    id: "profile-1",
    name: "probe",
    driverId,
    installationId: "inst-1",
    credentialMode: CREDENTIAL_MODE,
    options: optionsFor(driverId),
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderOpen(driverId: DriverId): string {
  return renderToStaticMarkup(
    createElement(ProfileFormModal, {
      open: true,
      mode: "edit",
      initial: profile(driverId),
      installations: [],
      onClose: () => {},
      onSubmit: async () => null,
    }),
  );
}

describe("ProfileFormModal empty-options note", () => {
  it("keeps the Kimi and Grok notes on those drivers", () => {
    expect(renderOpen("kimi-stream-json")).toContain(KIMI_NOTE);
    expect(renderOpen("grok-stream-json")).toContain(GROK_NOTE);
  });

  it("names the live cursor-agent catalog for a Cursor profile", () => {
    const html = renderOpen("cursor-stream-json");
    expect(html).toContain(CURSOR_NOTE);
    expect(html).not.toContain("kimi-code/k3");
  });

  it("keeps editable Claude and Codex fields", () => {
    expect(renderOpen("claude-stream-json")).toContain("Route（claude-stream-json 选项）");
    expect(renderOpen("codex-app-server")).toContain(
      "Reasoning effort（codex-app-server 选项，可留空）",
    );
  });
});
