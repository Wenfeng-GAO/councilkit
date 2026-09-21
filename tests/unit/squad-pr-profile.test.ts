import {
  buildFrozenPrProfile,
  deliveryAuthorityFromProfile,
  headsRef,
  squadPrProfileSchema,
  withCandidateSha,
  withPinnedCandidateSource,
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
    const privateRef = `refs/heads/councilkit/bridge/squad-task-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/${CAND}`;
    const pinned = withPinnedCandidateSource(profile, { ref: privateRef, sha: CAND });
    expect(pinned.source.ref).toBe(privateRef);
    expect(pinned.source.sha).toBe(CAND);
    expect(pinned.integration.base_ref).toBe(headsRef("feat-x"));
    expect(pinned.integration.base_sha).toBe(SHA);
    expect(pinned.target.remote).toBe("origin");
    expect(pinned.target.ref).toBe(headsRef("feat-x"));
    expect(pinned.target.sha).toBe(SHA);
    expect(pinned.authorization.authority_ref).toBe(AUTH);
    expect(pinned.delivery.mode).toBe("source-branch-ready");
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
