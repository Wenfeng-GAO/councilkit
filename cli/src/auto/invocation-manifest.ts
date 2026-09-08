/**
 * Frozen invocation snapshot for resume. No env secrets. Fingerprints bind
 * executables; a drifted binary must not silently mix with old evidence.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errors } from "../errors";
import { atomicWriteJson } from "../store/atomic-write";
import type { AgentRecord } from "../store/schemas";
import { driverSelectionSchema } from "../store/schemas";
import type { ReviewTask } from "./templates/review";

export const INVOCATION_MANIFEST_FILE = "invocation-manifest.v1.json";

const text = z.string().min(1).max(8000);

export const invocationManifestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("councilkit-invocation-manifest"),
    runId: text.max(160),
    task: z
      .object({
        pr: z.string().max(2048).optional(),
        task: z.string().max(8000).optional(),
        focus: z.string().max(8000).optional(),
        against: z.string().max(160).optional(),
      })
      .strict(),
    repoRealpath: z.string().max(4096).nullable(),
    reviewedSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    timeoutMs: z.number().int().positive(),
    concurrency: z.number().int().positive().nullable(),
    agents: z
      .array(
        z
          .object({
            id: text.max(160),
            name: text.max(160),
            driverId: text.max(80),
            modelId: text.max(200),
            options: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(8),
    aggregator: z
      .object({
        id: text.max(160),
        driverId: text.max(80),
        modelId: text.max(200),
      })
      .strict(),
    tools: z
      .array(
        z
          .object({
            name: text.max(80),
            realpath: text.max(4096),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            version: z.string().min(1).max(200).optional(),
            capabilityHash: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .optional(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type InvocationManifest = z.infer<typeof invocationManifestSchema>;
export type ToolFingerprint = InvocationManifest["tools"][number];

export const EXECUTION_REVISION_FILE = "execution-revision.v1.json";

export const executionRevisionSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("councilkit-execution-revision"),
    runId: text.max(160),
    reason: text.max(400),
    recordedAt: text.max(80),
    acceptedTools: z
      .array(
        z
          .object({
            name: text.max(80),
            realpath: text.max(4096),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            version: z.string().min(1).max(200).optional(),
            capabilityHash: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .optional(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type ExecutionRevision = z.infer<typeof executionRevisionSchema>;

export function hashFileBytes(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function capabilityHashFor(name: string, realpath: string, sha256: string): string {
  return createHash("sha256").update(`${name}\0${realpath}\0${sha256}`).digest("hex");
}

export function fingerprintExecutable(name: string, path: string): ToolFingerprint {
  const real = realpathSync(path);
  const sha256 = hashFileBytes(real);
  return {
    name,
    realpath: real,
    sha256,
    capabilityHash: capabilityHashFor(name, real, sha256),
  };
}

export type FingerprintVerdict =
  | { ok: true }
  | { ok: false; code: "DRIVER_DRIFT"; message: string };

export function verifySpawnFingerprint(
  spec: { driverId: string; executable: string },
  frozenTools: readonly ToolFingerprint[],
  acceptedRevision?: ExecutionRevision | null,
  expectedRunId?: string,
): FingerprintVerdict {
  if (acceptedRevision && expectedRunId && acceptedRevision.runId !== expectedRunId) {
    return {
      ok: false,
      code: "DRIVER_DRIFT",
      message: "execution revision does not belong to this run",
    };
  }
  const frozen = frozenTools.find((tool) => tool.name === spec.driverId);
  if (!frozen) return { ok: true };
  let live: ToolFingerprint;
  try {
    live = fingerprintExecutable(spec.driverId, spec.executable);
  } catch (error) {
    return {
      ok: false,
      code: "DRIVER_DRIFT",
      message: `cannot fingerprint ${spec.driverId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const expected = acceptedRevision
    ? acceptedRevision.acceptedTools.find((tool) => tool.name === spec.driverId)
    : frozen;
  if (!expected) {
    return {
      ok: false,
      code: "DRIVER_DRIFT",
      message: `execution revision does not cover ${spec.driverId}`,
    };
  }
  if (live.realpath !== expected.realpath || live.sha256 !== expected.sha256) {
    return {
      ok: false,
      code: "DRIVER_DRIFT",
      message: `executable drift for ${spec.driverId}: frozen realpath/hash does not match live binary`,
    };
  }
  if (expected.capabilityHash && live.capabilityHash !== expected.capabilityHash) {
    return {
      ok: false,
      code: "DRIVER_DRIFT",
      message: `capability hash drift for ${spec.driverId}`,
    };
  }
  if (expected.version && live.version !== expected.version) {
    return {
      ok: false,
      code: "DRIVER_DRIFT",
      message: `version drift for ${spec.driverId}`,
    };
  }
  return { ok: true };
}

export function writeExecutionRevision(runDir: string, revision: ExecutionRevision): void {
  atomicWriteJson(join(runDir, EXECUTION_REVISION_FILE), executionRevisionSchema.parse(revision));
}

export function readExecutionRevision(runDir: string): ExecutionRevision | null {
  const path = join(runDir, EXECUTION_REVISION_FILE);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const parsed = executionRevisionSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeInvocationManifest(runDir: string, manifest: InvocationManifest): void {
  atomicWriteJson(join(runDir, INVOCATION_MANIFEST_FILE), invocationManifestSchema.parse(manifest));
}

export function readInvocationManifest(runDir: string): InvocationManifest | null {
  const path = join(runDir, INVOCATION_MANIFEST_FILE);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw errors.io("invocation manifest is not a regular file");
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw errors.io("invocation manifest is unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw errors.io("invocation manifest is not JSON");
  }
  const result = invocationManifestSchema.safeParse(parsed);
  if (!result.success) {
    const version =
      parsed !== null && typeof parsed === "object" && "version" in parsed
        ? (parsed as { version?: unknown }).version
        : undefined;
    if (version !== 1) {
      throw errors.io("invocation manifest version is unknown");
    }
    throw errors.io("invocation manifest is invalid");
  }
  return result.data;
}

export function requireInvocationManifest(runDir: string): InvocationManifest {
  const manifest = readInvocationManifest(runDir);
  if (manifest === null) {
    throw errors.io("invocation manifest is missing");
  }
  return manifest;
}

export function matchExecutionRevision(
  revision: ExecutionRevision | null,
  runId: string,
): ExecutionRevision | null {
  if (revision === null) return null;
  if (revision.runId !== runId) {
    throw errors.runFailed("execution revision does not belong to this run");
  }
  return revision;
}

export function overlayFrozenAgent(
  agent: AgentRecord,
  frozen: InvocationManifest["agents"][number],
): AgentRecord {
  const selection = driverSelectionSchema.parse({
    driverId: frozen.driverId,
    options: frozen.options,
  });
  return {
    ...agent,
    name: frozen.name,
    modelId: frozen.modelId,
    driverSelection: selection,
  };
}

export function stubAgentFromFrozen(frozen: InvocationManifest["agents"][number]): AgentRecord {
  return overlayFrozenAgent(
    {
      id: frozen.id,
      name: frozen.name,
      personaPrompt: "Frozen reviewer from invocation manifest.",
      modelId: frozen.modelId,
      color: "#808080",
      enabled: true,
      driverSelection: driverSelectionSchema.parse({
        driverId: frozen.driverId,
        options: frozen.options,
      }),
    },
    frozen,
  );
}

export function resumeArgvFromManifest(manifest: InvocationManifest): string[] {
  const argv = ["review"];
  if (manifest.task.pr) argv.push(manifest.task.pr);
  argv.push("--resume", manifest.runId);
  if (manifest.task.task) argv.push("--task", manifest.task.task);
  if (manifest.task.focus) argv.push("--focus", manifest.task.focus);
  if (manifest.task.against) argv.push("--against", manifest.task.against);
  return argv;
}

export function formatResumeCommand(argv: string[]): string {
  if (argv.length === 0) return "councilkit";
  return [
    "councilkit",
    ...argv.map((token) => {
      if (token === "review" || /^--[A-Za-z0-9-]+$/.test(token)) return token;
      return shellSingleQuote(token);
    }),
  ].join(" ");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function fingerprintsFromSpecs(
  specs: readonly { driverId: string; executable: string }[],
): InvocationManifest["tools"] {
  const seen = new Set<string>();
  const tools: InvocationManifest["tools"] = [];
  for (const spec of specs) {
    if (seen.has(spec.executable)) continue;
    seen.add(spec.executable);
    try {
      tools.push(fingerprintExecutable(spec.driverId, spec.executable));
    } catch {
      /* missing fake executables in unit tests leave tools[] empty */
    }
  }
  return tools;
}

export function taskFromManifest(manifest: InvocationManifest): ReviewTask {
  return {
    pr: manifest.task.pr,
    task: manifest.task.task,
    focus: manifest.task.focus,
    against: manifest.task.against,
  };
}
