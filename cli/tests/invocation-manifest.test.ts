/**
 * Frozen tool fingerprints must reject spawn-time drift unless an explicit
 * execution revision records the new bytes.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fingerprintExecutable,
  matchExecutionRevision,
  overlayFrozenAgent,
  readExecutionRevision,
  readInvocationManifest,
  verifySpawnFingerprint,
  writeExecutionRevision,
  writeInvocationManifest,
} from "../src/auto/invocation-manifest";
import type { AgentRecord } from "../src/store/schemas";

describe("invocation fingerprint drift", () => {
  it("rejects a changed executable hash and allows a recorded revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-fp-"));
    const bin = join(dir, "cld");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    try {
      const frozen = fingerprintExecutable("claude-stream-json", bin);
      expect(frozen.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(frozen.capabilityHash).toMatch(/^[0-9a-f]{64}$/);
      expect(
        verifySpawnFingerprint({ driverId: "claude-stream-json", executable: bin }, [frozen]).ok,
      ).toBe(true);

      writeFileSync(bin, "#!/bin/sh\nexit 1\n");
      const drifted = verifySpawnFingerprint({ driverId: "claude-stream-json", executable: bin }, [
        frozen,
      ]);
      expect(drifted.ok).toBe(false);
      if (!drifted.ok) {
        expect(drifted.code).toBe("DRIVER_DRIFT");
      }

      const live = fingerprintExecutable("claude-stream-json", bin);
      writeExecutionRevision(dir, {
        version: 1,
        kind: "councilkit-execution-revision",
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        reason: "operator accepted replacement binary",
        recordedAt: "2026-09-08T00:00:00.000Z",
        acceptedTools: [live],
      });
      const revision = readExecutionRevision(dir);
      const allowed = verifySpawnFingerprint(
        { driverId: "claude-stream-json", executable: bin },
        [frozen],
        revision,
      );
      expect(allowed.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mix frozen and live hashes when no revision is recorded", () => {
    const skip = verifySpawnFingerprint({ driverId: "claude-stream-json", executable: "fake" }, []);
    expect(skip.ok).toBe(true);
  });

  it("refuses a truncated or unknown-version manifest instead of treating it as missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-manifest-"));
    try {
      writeFileSync(join(dir, "invocation-manifest.v1.json"), "{");
      expect(() => readInvocationManifest(dir)).toThrow(/not JSON/);
      writeFileSync(
        join(dir, "invocation-manifest.v1.json"),
        JSON.stringify({ version: 99, kind: "councilkit-invocation-manifest" }),
      );
      expect(() => readInvocationManifest(dir)).toThrow(/unknown/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an execution revision copied from another run", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-rev-"));
    try {
      writeExecutionRevision(dir, {
        version: 1,
        kind: "councilkit-execution-revision",
        runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        reason: "copied",
        recordedAt: "2026-09-08T00:00:00.000Z",
        acceptedTools: [],
      });
      const revision = readExecutionRevision(dir);
      expect(() =>
        matchExecutionRevision(revision, "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2"),
      ).toThrow(/does not belong to this run/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a valid manifest whose runId is not this run", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-manifest-run-"));
    const runId = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
    try {
      writeInvocationManifest(dir, {
        version: 1,
        kind: "councilkit-invocation-manifest",
        runId: "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        task: { task: "same task" },
        repoRealpath: null,
        reviewedSha: "a".repeat(40),
        timeoutMs: 1000,
        concurrency: 1,
        agents: [
          {
            id: "agent-a",
            name: "A",
            driverId: "grok-stream-json",
            modelId: "grok-4.6",
            options: {},
            personaPrompt: "frozen persona",
          },
        ],
        aggregator: { id: "agent-a", driverId: "grok-stream-json", modelId: "grok-4.6" },
        tools: [],
      });
      expect(() => readInvocationManifest(dir, runId)).toThrow(/does not belong to this run/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overlays the frozen personaPrompt instead of the live Store identity", () => {
    const frozen = {
      id: "agent-a",
      name: "A",
      driverId: "grok-stream-json" as const,
      modelId: "grok-4.6",
      options: {},
      personaPrompt: "frozen persona",
    };
    const live: AgentRecord = {
      id: "agent-a",
      name: "A",
      personaPrompt: "mutated persona",
      modelId: "mutated-model",
      color: "#123456",
      enabled: true,
      driverSelection: { driverId: "grok-stream-json", options: {} },
    };
    const overlaid = overlayFrozenAgent(live, frozen);
    expect(overlaid.personaPrompt).toBe("frozen persona");
    expect(overlaid.modelId).toBe("grok-4.6");
  });
});
