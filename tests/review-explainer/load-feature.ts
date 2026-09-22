import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FEATURE_MISSING = "FEATURE_MISSING";
export const INFRA_FAILURE = "INFRA_FAILURE";

const HERE = fileURLToPath(new URL(".", import.meta.url));

export class FeatureMissingError extends Error {
  readonly code = FEATURE_MISSING;
  readonly specifier: string;
  constructor(specifier: string, detail?: string, cause?: unknown) {
    super(`${FEATURE_MISSING} ${specifier}${detail ? `: ${detail}` : ""}`);
    this.specifier = specifier;
    void cause;
  }
}

export class InfraFailureError extends Error {
  readonly code = INFRA_FAILURE;
  constructor(message: string, cause?: unknown) {
    super(`${INFRA_FAILURE}: ${message}`);
    void cause;
  }
}

export async function importFeature<T = Record<string, unknown>>(specifier: string): Promise<T> {
  const target = specifier.startsWith("@shared/")
    ? resolve(HERE, "../../shared", specifier.slice("@shared/".length))
    : specifier.startsWith("@host/")
      ? resolve(HERE, "../../runtime-host", specifier.slice("@host/".length))
      : resolve(HERE, specifier);
  const file = extname(target) ? target : `${target}.ts`;
  if (!existsSync(file)) throw new FeatureMissingError(specifier, `module absent: ${file}`);
  try {
    return (await import(pathToFileURL(file).href)) as T;
  } catch (error) {
    // A present feature with invalid TypeScript/dependencies is infrastructure,
    // not another expected missing-feature RED.
    throw new InfraFailureError(
      `cannot load ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

export function requireExport<T>(mod: Record<string, unknown>, name: string, specifier: string): T {
  const value = mod[name];
  if (typeof value !== "function" && (value === undefined || value === null)) {
    throw new FeatureMissingError(specifier, `missing export ${name}`);
  }
  return value as T;
}

export function missing(specifier: string, detail?: string): never {
  throw new FeatureMissingError(specifier, detail);
}

export function infra(message: string): never {
  throw new InfraFailureError(message);
}

/** 404/405 on a contracted explainer route is a missing feature, not auth drift. */
export function classifyExplainerStatus(status: number, route: string): void {
  if (status === 404 || status === 405) {
    missing(route, `HTTP ${status}`);
  }
  if (status === 401 || status === 403) {
    infra(`${route} rejected as HTTP ${status} (session/CSRF/Origin)`);
  }
}

export function required<T>(value: T | null | undefined, label = "required test evidence"): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}
