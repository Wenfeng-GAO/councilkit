import { z } from "zod";
import { FULL_COMMIT_SHA } from "./cli-ledger";

const HEX64 = /^[a-f0-9]{64}$/;
const HEADS = /^refs\/heads\/(?!\/)[A-Za-z0-9._/\-]{1,200}$/;
const MODES = ["local-candidate", "source-branch-ready", "pr-ready"] as const;

export const squadPrProfileSchema = z
  .object({
    schema_version: z.literal(1),
    title: z.literal("pr-profile"),
    source: z
      .object({
        ref: z.string().regex(HEADS),
        sha: z.string().regex(FULL_COMMIT_SHA),
      })
      .strict(),
    integration: z
      .object({
        base_ref: z.string().regex(HEADS),
        base_sha: z.string().regex(FULL_COMMIT_SHA),
        cas: z.literal("expected-old-ref"),
        ff_only: z.literal(true),
      })
      .strict(),
    target: z
      .object({
        remote: z.string().min(1).max(128),
        ref: z.string().regex(HEADS),
        sha: z.string().regex(FULL_COMMIT_SHA),
        conflict: z.literal("none"),
      })
      .strict(),
    authorization: z
      .object({
        push: z.literal(true),
        pr_mutation: z.literal(false),
        authority_ref: z.string().regex(HEX64),
      })
      .strict(),
    delivery: z
      .object({
        mode: z.literal("source-branch-ready"),
        supported_modes: z.tuple([
          z.literal("local-candidate"),
          z.literal("source-branch-ready"),
          z.literal("pr-ready"),
        ]),
      })
      .strict(),
    gate_independence: z
      .object({
        reviewer_writable: z.literal(false),
        verifier_writable: z.literal(true),
        shared_workspace: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type SquadPrProfile = z.infer<typeof squadPrProfileSchema>;

export const deliveryAuthoritySchema = z
  .object({
    push: z.literal(true),
    pr_mutation: z.literal(false),
    remote: z.string().min(1).max(128),
    target_ref: z.string().regex(HEADS),
    authority_ref: z.string().regex(HEX64),
  })
  .strict();

export type FrozenDeliveryAuthority = z.infer<typeof deliveryAuthoritySchema>;

export function headsRef(branch: string): string {
  const trimmed = branch.trim();
  if (trimmed.startsWith("refs/heads/")) return trimmed;
  return `refs/heads/${trimmed}`;
}

export function buildFrozenPrProfile(input: {
  sourceBranch: string;
  sourceSha: string;
  expectedOldSha: string;
  remote: string;
  authorityRef: string;
}): SquadPrProfile {
  const sourceRef = headsRef(input.sourceBranch);
  const profile = {
    schema_version: 1 as const,
    title: "pr-profile" as const,
    source: { ref: sourceRef, sha: input.sourceSha.toLowerCase() },
    integration: {
      base_ref: sourceRef,
      base_sha: input.expectedOldSha.toLowerCase(),
      cas: "expected-old-ref" as const,
      ff_only: true as const,
    },
    target: {
      remote: input.remote,
      ref: sourceRef,
      sha: input.expectedOldSha.toLowerCase(),
      conflict: "none" as const,
    },
    authorization: {
      push: true as const,
      pr_mutation: false as const,
      authority_ref: input.authorityRef.toLowerCase(),
    },
    delivery: {
      mode: "source-branch-ready" as const,
      supported_modes: [...MODES] as ["local-candidate", "source-branch-ready", "pr-ready"],
    },
    gate_independence: {
      reviewer_writable: false as const,
      verifier_writable: true as const,
      shared_workspace: false as const,
    },
  };
  return squadPrProfileSchema.parse(profile);
}

export function withCandidateSha(profile: SquadPrProfile, candidateSha: string): SquadPrProfile {
  return squadPrProfileSchema.parse({
    ...profile,
    source: { ...profile.source, sha: candidateSha.toLowerCase() },
  });
}

/** Bind source.ref and source.sha together; leave target/integration/grant/mode untouched. */
export function withPinnedCandidateSource(
  profile: SquadPrProfile,
  input: { ref: string; sha: string },
): SquadPrProfile {
  return squadPrProfileSchema.parse({
    ...profile,
    source: { ref: input.ref, sha: input.sha.toLowerCase() },
  });
}

export function deliveryAuthorityFromProfile(profile: SquadPrProfile): FrozenDeliveryAuthority {
  return deliveryAuthoritySchema.parse({
    push: profile.authorization.push,
    pr_mutation: profile.authorization.pr_mutation,
    remote: profile.target.remote,
    target_ref: profile.target.ref,
    authority_ref: profile.authorization.authority_ref,
  });
}
