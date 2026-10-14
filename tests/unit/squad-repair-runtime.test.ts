import {
  CURSOR_REPAIR_MODEL,
  GROK_REPAIR_MODEL,
  type RepairSeat,
  applyRepairRoleUpdates,
  buildRepairContract,
  cursorRepairModelPin,
  cursorRepairModelReceiptMatches,
  cursorRepairRoles,
  repairModelReceiptMatches,
  resolveRepairRoles,
} from "@shared/runtime/squad-repair-runtime";
import { describe, expect, it } from "vitest";

describe("cursor repair model pin", () => {
  it("defaults to the 500k id and keeps other explicit models as themselves", () => {
    expect(cursorRepairModelPin(undefined)).toEqual({ ok: true, model: CURSOR_REPAIR_MODEL });
    expect(cursorRepairModelPin(CURSOR_REPAIR_MODEL).ok).toBe(true);
    expect(cursorRepairModelPin("Grok 4.7 500K Extra High")).toEqual({
      ok: true,
      model: CURSOR_REPAIR_MODEL,
    });
    expect(cursorRepairModelPin("auto").ok).toBe(false);
    expect(cursorRepairModelPin("grok-4.7-xhigh")).toEqual({
      ok: true,
      model: "grok-4.7-xhigh",
    });
    expect(cursorRepairModelPin("grok-4.7[context=500k,reasoning_effort=xhigh,fast=true]").ok).toBe(
      false,
    );
  });

  it("matches a receipt only to the requested model", () => {
    expect(cursorRepairModelReceiptMatches(CURSOR_REPAIR_MODEL)).toBe(true);
    expect(cursorRepairModelReceiptMatches("Grok 4.7 500K Extra High")).toBe(true);
    expect(cursorRepairModelReceiptMatches("  grok 4.7 500k extra high ")).toBe(true);
    expect(
      cursorRepairModelReceiptMatches("grok-4.7-context-500k-reasoning-effort-xhigh-fast-false"),
    ).toBe(true);
    expect(cursorRepairModelReceiptMatches("grok-4.7-xhigh")).toBe(false);
    expect(cursorRepairModelReceiptMatches("Grok 4.7 Extra High")).toBe(false);
    expect(cursorRepairModelReceiptMatches("Grok 4.7 500K Extra High Fast")).toBe(false);
    expect(cursorRepairModelReceiptMatches("auto")).toBe(false);
    expect(repairModelReceiptMatches("grok-4.7-xhigh", "Grok 4.7 Extra High")).toBe(true);
    expect(repairModelReceiptMatches("grok-4.7-xhigh", "Grok 4.7 256K Extra High")).toBe(true);
    expect(repairModelReceiptMatches("grok-4.7-xhigh", "Grok 4.7  Extra High")).toBe(true);
    expect(repairModelReceiptMatches("grok-4.7-xhigh", "Grok 4.7 256K High")).toBe(false);
    expect(repairModelReceiptMatches("grok-4.7-xhigh", "Grok 4.7 256K Extra High Fast")).toBe(
      false,
    );
    expect(repairModelReceiptMatches(CURSOR_REPAIR_MODEL, "Grok 4.7 256K Extra High")).toBe(false);
    expect(repairModelReceiptMatches("grok-4.7-xhigh", "Grok 4.7 500K Extra High")).toBe(false);
    expect(repairModelReceiptMatches("composer-2.5", "Composer 2.5")).toBe(true);
    expect(repairModelReceiptMatches("composer-2.5", "Grok 4.7 500K Extra High")).toBe(false);
    expect(repairModelReceiptMatches("gpt-5.6-sol", "gpt-5.6-sol")).toBe(true);
    expect(repairModelReceiptMatches("gpt-5.6-sol", "composer-2.5")).toBe(false);
  });

  it("binds every squad role to cursor and keeps review and verify off the builder session", () => {
    const roles = cursorRepairRoles();
    const seats: RepairSeat[] = [
      "orchestrator",
      "planner_a",
      "planner_b",
      "coder",
      "reviewer",
      "verifier",
    ];
    for (const role of seats) {
      expect(roles[role].runtime).toBe("cursor");
      expect(roles[role].model).toBe(CURSOR_REPAIR_MODEL);
    }
    expect(roles.planner_a?.mode).toBe("main-session");
    expect(roles.coder?.mode).toBe("main-session");
    expect(roles.coder?.permission_mode).toBe("unrestricted-local");
    expect(roles.planner_a?.sandbox).toBe("read-only");
    expect(roles.planner_b?.mode).toBeUndefined();
    expect(roles.reviewer?.mode).toBeUndefined();
    expect(roles.reviewer?.sandbox).toBe("read-only");
    expect(roles.verifier?.mode).toBeUndefined();
    expect(roles.verifier?.sandbox).toBe("workspace-write");
  });

  it("lets reviewer and verifier change model without splitting the continuous builder", () => {
    const resolved = resolveRepairRoles({
      orchestratorRuntime: "cursor",
      roles: {
        reviewer: { runtime: "codex", model: "gpt-5.6-sol" },
        verifier: { runtime: "cursor", model: "composer-2.5" },
      },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.roles.orchestrator.model).toBe(CURSOR_REPAIR_MODEL);
    expect(resolved.roles.planner_a.model).toBe(CURSOR_REPAIR_MODEL);
    expect(resolved.roles.coder.model).toBe(CURSOR_REPAIR_MODEL);
    expect(resolved.roles.reviewer).toMatchObject({ runtime: "codex", model: "gpt-5.6-sol" });
    expect(resolved.roles.reviewer.mode).toBeUndefined();
    expect(resolved.roles.verifier).toMatchObject({
      runtime: "cursor",
      model: "composer-2.5",
      sandbox: "workspace-write",
    });
    const split = resolveRepairRoles({
      roles: { coder: { runtime: "cursor", model: "composer-2.5" } },
    });
    expect(split.ok).toBe(false);
    const applied = applyRepairRoleUpdates(
      { executable: "/tmp/squadctl" },
      { orchestrator: { runtime: "cursor", model: "composer-2.5" } },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.file.executable).toBe("/tmp/squadctl");
    expect(applied.resolved.roles.coder.model).toBe("composer-2.5");
    expect(applied.resolved.roles.reviewer.model).toBe(CURSOR_REPAIR_MODEL);
  });

  it.each(["planner_b", "reviewer", "verifier"] as const)(
    "allows an independent grokb %s with its existing sandbox policy",
    (seat) => {
      const resolved = resolveRepairRoles({
        orchestratorRuntime: "grokb",
        roles: { [seat]: { runtime: "grokb" } },
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.emitContract).toBe(true);
      const contract = buildRepairContract({
        contractId: "grok-independent-test",
        createdAt: "2026-10-09T00:00:00.000Z",
        roles: resolved.roles,
      });
      expect(contract.roles[seat]).toEqual({
        runtime: "grokb",
        model: GROK_REPAIR_MODEL,
        sandbox: seat === "verifier" ? "workspace-write" : "read-only",
      });
      for (const builder of ["orchestrator", "planner_a", "coder"] as const) {
        expect(contract.roles[builder]).toMatchObject({
          runtime: "grokb",
          model: GROK_REPAIR_MODEL,
          mode: "main-session",
        });
      }
      for (const other of ["planner_b", "reviewer", "verifier"] as const) {
        if (other !== seat) expect(contract.roles[other].runtime).toBe("cursor");
      }
    },
  );

  it.each(["planner_b", "reviewer", "verifier"] as const)(
    "rejects unsupported runtimes and unpinned Grok models for %s",
    (seat) => {
      for (const runtime of ["grok", "grok_local", "unknown"]) {
        const resolved = resolveRepairRoles({
          roles: { [seat]: { runtime, model: GROK_REPAIR_MODEL } },
        });
        expect(resolved.ok).toBe(false);
      }
      for (const model of ["auto", "default", "configured", "current"]) {
        const resolved = resolveRepairRoles({ roles: { [seat]: { runtime: "grokb", model } } });
        expect(resolved.ok).toBe(false);
      }
    },
  );
});
