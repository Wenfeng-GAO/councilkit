import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/runtime/digest";
import { makeError } from "@shared/runtime/errors";
import type {
  ExecutionProfileDto,
  InstallationDto,
  ParticipantSpec,
  ProfileReadiness,
  ResolvedBinding,
} from "@shared/runtime/schemas";
import type { PrewarmResult } from "../drivers/types";
import type { InstallationRecord, InstallationRegistry } from "../installations/registry";

/**
 * Profile resolver: combines the Browser's typed Profile DTO with the
 * currently trusted Installation and the live Driver handshake into the
 * canonical resolved binding a Participant persists. The Browser DTO is
 * never itself a trusted execution configuration.
 */

export interface ResolveResult {
  readiness: ProfileReadiness;
  binding: ResolvedBinding | null;
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Static part: schema-valid DTO + trusted installation, no handshake yet. */
export function resolveStatic(
  profile: ExecutionProfileDto,
  modelId: string,
  registry: InstallationRegistry,
): { readiness: ProfileReadiness; installation: InstallationDto | null } {
  let installation: InstallationDto | null = null;
  try {
    installation = registry.get(profile.installationId) ?? null;
  } catch {
    installation = null;
  }
  if (!installation) {
    return {
      readiness: { state: "invalid_binding", detail: "unknown installationId" },
      installation: null,
    };
  }
  if (installation.driverId !== profile.driverId) {
    return {
      readiness: { state: "invalid_binding", detail: "profile driver does not match installation" },
      installation: null,
    };
  }
  if (installation.state !== "trusted") {
    return {
      readiness: {
        state: "runtime_unavailable",
        detail: `installation is ${installation.state}; revalidation required`,
      },
      installation,
    };
  }
  if (profile.driverId === "claude-stream-json") {
    const route = profile.options.route;
    if (!["ant-glm5.2", "moonshot", "deepseek"].includes(route)) {
      return {
        readiness: { state: "invalid_binding", detail: `unsupported route ${route}` },
        installation,
      };
    }
  }
  void modelId;
  return {
    readiness: { state: "ready", detail: "static binding ok; driver handshake still required" },
    installation,
  };
}

/**
 * Dynamic part: called with the live prewarm result. Only an exact canonical
 * match or a driver-declared alias satisfies the requested model; anything
 * else is model_unavailable (a real reroute at execution time pauses instead).
 */
export function buildBinding(
  spec: ParticipantSpec,
  installation: InstallationRecord,
  prewarm: PrewarmResult,
): ResolveResult {
  const requested = spec.modelId;
  const canonical = prewarm.canonicalModelId;
  const aliases = prewarm.modelAliases;
  if (requested !== canonical && !aliases.includes(requested)) {
    return {
      readiness: {
        state: "model_unavailable",
        detail: "requested model is not the handshaken canonical model",
      },
      binding: null,
    };
  }
  const capabilityDigest = digestOf({
    capability: prewarm.capability,
    catalog: prewarm.catalog,
  });
  const installationFingerprint = digestOf({
    realpath: installation.realpath,
    fingerprint: installation.fingerprint,
    components: installation.components,
  });
  const binding: ResolvedBinding = {
    bindingDigest: digestOf({
      driverId: spec.profile.driverId,
      installationId: installation.installationId,
      installationFingerprint,
      capabilityDigest,
      canonicalModelId: canonical,
      route:
        spec.profile.driverId === "claude-stream-json" ? spec.profile.options.route : undefined,
      reasoningEffort:
        spec.profile.driverId === "codex-app-server"
          ? spec.profile.options.reasoningEffort
          : undefined,
    }),
    driverId: spec.profile.driverId,
    installationId: installation.installationId,
    installationFingerprint,
    capabilityDigest,
    requestedModel: requested,
    canonicalModelId: canonical,
    modelAliases: aliases,
    ...(spec.profile.driverId === "claude-stream-json"
      ? { route: spec.profile.options.route }
      : {}),
    ...(spec.profile.driverId === "codex-app-server" && spec.profile.options.reasoningEffort
      ? { reasoningEffort: spec.profile.options.reasoningEffort }
      : {}),
  };
  return { readiness: { state: "ready", detail: null }, binding };
}

export function resolutionError(code: string, message: string): ReturnType<typeof makeError> {
  return makeError(code as never, "prewarm", message);
}
