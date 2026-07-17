import { digestOf } from "@/models/discussion/factories";
import type { CREDENTIAL_MODE, DriverId } from "@shared/runtime/contracts";
import { type ExecutionProfileDto, executionProfileSchema } from "@shared/runtime/schemas";

/**
 * Browser-side Execution Profile record: a typed, secret-free reference to a
 * Runtime Installation. It stores only `driverId`, `installationId`, the fixed
 * `installation-managed` credential mode and driver-typed options — never
 * executable paths, argv, shell fragments, raw env or tokens. Persistence
 * (Dexie table) arrives with U4; this module is the in-memory model.
 */
export interface ExecutionProfileRecord {
  id: string;
  name: string;
  driverId: DriverId;
  installationId: string;
  credentialMode: typeof CREDENTIAL_MODE;
  options: ExecutionProfileDto["options"];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ProfileDtoValidation = { ok: true; dto: ExecutionProfileDto } | { ok: false };

/**
 * Strict contract validation from `@shared/runtime/schemas`: unknown fields —
 * including executable, argv, shell, env or token injection attempts — fail.
 */
export function validateProfileDto(input: unknown): ProfileDtoValidation {
  const parsed = executionProfileSchema.safeParse(input);
  return parsed.success ? { ok: true, dto: parsed.data } : { ok: false };
}

/** Project a browser record onto the wire DTO (validated on the way out). */
export function toDto(record: ExecutionProfileRecord): ExecutionProfileDto {
  return executionProfileSchema.parse({
    driverId: record.driverId,
    installationId: record.installationId,
    credentialMode: record.credentialMode,
    options: record.options,
  });
}

/**
 * Deterministic join-time Profile digest (digestVersion 1): a Participant
 * snapshots it at join time so a later Profile edit (revision/options) is
 * detectable from the snapshot. Record metadata (id, name, timestamps) is
 * NOT part of the digest.
 */
export function profileDigestOf(record: ExecutionProfileRecord): string {
  return digestOf({
    digestVersion: 1,
    driverId: record.driverId,
    installationId: record.installationId,
    credentialMode: record.credentialMode,
    options: record.options,
    revision: record.revision,
  });
}
