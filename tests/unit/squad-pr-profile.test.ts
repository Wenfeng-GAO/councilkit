import {
  buildFrozenPrProfile,
  deliveryAuthorityFromProfile,
  headsRef,
  squadPrProfileSchema,
  withCandidateSha,
} from "@shared/runtime/squad-pr-profile";
import { describe, expect, it } from "vitest";

const SHA = "a".repeat(40);
const CAND = "b".repeat(40);
const AUTH = "c".repeat(64);

describe("frozen pr-profile", () => {
  it("emits refs/heads, complete supported_modes, and grant authority_ref", () => {
    const profile = buildFrozenPrProfile({
      sourceBranch: "feat-x",
      sourceSha: SHA,
      expectedOldSha: SHA,
      remote: "origin",
      authorityRef: AUTH,
    });
    expect(profile.source.ref).toBe("refs/heads/feat-x");
    expect(profile.target.ref).toBe("refs/heads/feat-x");
    expect(profile.delivery.supported_modes).toEqual([
      "local-candidate",
      "source-branch-ready",
      "pr-ready",
    ]);
    expect(profile.authorization.authority_ref).toBe(AUTH);
    expect(deliveryAuthorityFromProfile(profile)).toEqual({
      push: true,
      pr_mutation: false,
      remote: "origin",
      target_ref: "refs/heads/feat-x",
      authority_ref: AUTH,
    });
    const published = withCandidateSha(profile, CAND);
    expect(published.source.sha).toBe(CAND);
    expect(published.authorization.authority_ref).toBe(AUTH);
    expect(published.target.sha).toBe(SHA);
    expect(squadPrProfileSchema.parse(published).source.ref).toBe(headsRef("feat-x"));
  });

  it("rejects a profile that omits a supported mode", () => {
    const profile = buildFrozenPrProfile({
      sourceBranch: "feat-x",
      sourceSha: SHA,
      expectedOldSha: SHA,
      remote: "origin",
      authorityRef: AUTH,
    });
    expect(() =>
      squadPrProfileSchema.parse({
        ...profile,
        delivery: { mode: "source-branch-ready", supported_modes: ["source-branch-ready"] },
      }),
    ).toThrow();
  });
});
