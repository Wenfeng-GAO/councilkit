import {
  type ExecutionProfileRecord,
  profileDigestOf,
  toDto,
  validateProfileDto,
} from "@/models/execution-profile";
import type { ExecutionProfileDto } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

/**
 * Browser execution-profile record: strict wire projection and the join-time
 * digest. Digests are pinned to sha256 hex of the canonical snapshot.
 */

const CLAUDE_DIGEST = "f6d1aadb3b8cd2c98cd72eb944077fd53851ddf3fe86e28e8ab75454a37419dc";

function claudeRecord(overrides: Partial<ExecutionProfileRecord> = {}): ExecutionProfileRecord {
  return {
    id: "prof-1",
    name: "Claude GLM",
    driverId: "claude-stream-json",
    installationId: "cld-0123456789ab",
    credentialMode: "installation-managed",
    options: { route: "ant-glm5.2" },
    revision: 3,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T01:00:00.000Z",
    ...overrides,
  };
}

function zodError(fn: () => unknown): ZodError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
    if (error instanceof ZodError) return error;
  }
  expect.unreachable("expected ZodError");
}

describe("validateProfileDto and toDto", () => {
  it("projects a claude record onto the four wire fields", () => {
    const dto: ExecutionProfileDto = {
      driverId: "claude-stream-json",
      installationId: "cld-0123456789ab",
      credentialMode: "installation-managed",
      options: { route: "ant-glm5.2" },
    };
    const record = claudeRecord();
    (record as ExecutionProfileRecord & { token: string }).token = "secret";
    expect(toDto(record)).toEqual(dto);
    expect(validateProfileDto(dto)).toEqual({ ok: true, dto });
  });

  it("accepts every claude route and the other driver option shapes", () => {
    const accepted: ExecutionProfileDto[] = [
      {
        driverId: "claude-stream-json",
        installationId: "cld-0123456789ab",
        credentialMode: "installation-managed",
        options: { route: "moonshot" },
      },
      {
        driverId: "claude-stream-json",
        installationId: "cld-0123456789ab",
        credentialMode: "installation-managed",
        options: { route: "deepseek" },
      },
      {
        driverId: "claude-stream-json",
        installationId: "cld-0123456789ab",
        credentialMode: "installation-managed",
        options: { route: "cfuse" },
      },
      {
        driverId: "codex-app-server",
        installationId: "codex-fedcba987654",
        credentialMode: "installation-managed",
        options: { reasoningEffort: "high" },
      },
      {
        driverId: "codex-app-server",
        installationId: "codex-fedcba987654",
        credentialMode: "installation-managed",
        options: {},
      },
      {
        driverId: "kimi-stream-json",
        installationId: "kimi-fedcba987654",
        credentialMode: "installation-managed",
        options: {},
      },
      {
        driverId: "grok-stream-json",
        installationId: "grok-0123456789ab",
        credentialMode: "installation-managed",
        options: {},
      },
      {
        driverId: "cursor-stream-json",
        installationId: "cursor-0123456789ab",
        credentialMode: "installation-managed",
        options: {},
      },
    ];
    for (const dto of accepted) {
      expect(validateProfileDto(dto)).toEqual({ ok: true, dto });
      expect(
        toDto(
          claudeRecord({
            driverId: dto.driverId,
            installationId: dto.installationId,
            options: dto.options,
          }),
        ),
      ).toEqual(dto);
    }
  });

  it("rejects secrets, spawn fields, mismatched options, and non-objects", () => {
    const claude = {
      driverId: "claude-stream-json",
      installationId: "cld-0123456789ab",
      credentialMode: "installation-managed",
      options: { route: "ant-glm5.2" },
    };
    const rejected: unknown[] = [
      null,
      undefined,
      "claude-stream-json",
      [],
      { ...claude, executable: "/tmp/evil" },
      { ...claude, argv: ["--danger"] },
      { ...claude, shell: "bash -c id" },
      { ...claude, env: { ANTHROPIC_AUTH_TOKEN: "x" } },
      { ...claude, token: "secret" },
      { ...claude, credentialMode: "api-key" },
      { ...claude, driverId: "http" },
      { ...claude, installationId: "" },
      { ...claude, options: { route: "ant-glm5.2", executable: "/tmp/evil" } },
      { ...claude, options: { route: "zenmux" } },
      {
        driverId: "codex-app-server",
        installationId: "codex-0123456789ab",
        credentialMode: "installation-managed",
        options: { route: "moonshot" },
      },
      {
        driverId: "kimi-stream-json",
        installationId: "kimi-fedcba987654",
        credentialMode: "installation-managed",
        options: { modelId: "kimi-code/k3" },
      },
    ];
    for (const payload of rejected) {
      expect(validateProfileDto(payload)).toEqual({ ok: false });
    }
  });

  it("toDto throws ZodError when the record options are not a claude route", () => {
    const error = zodError(() => toDto(claudeRecord({ options: { route: "zenmux" } as never })));
    expect(error.issues).toEqual([
      {
        code: "invalid_value",
        values: ["ant-glm5.2", "moonshot", "deepseek", "cfuse"],
        path: ["options", "route"],
        message: 'Invalid option: expected one of "ant-glm5.2"|"moonshot"|"deepseek"|"cfuse"',
      },
    ]);
  });
});

describe("profileDigestOf", () => {
  it("hashes the snapshot and ignores id, name, and timestamps", () => {
    expect(profileDigestOf(claudeRecord())).toBe(CLAUDE_DIGEST);
    expect(
      profileDigestOf(
        claudeRecord({
          id: "prof-other",
          name: "另一个名字",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        }),
      ),
    ).toBe(CLAUDE_DIGEST);
  });

  it("changes when revision, route, installation, or driver binding changes", () => {
    expect(profileDigestOf(claudeRecord({ revision: 4 }))).toBe(
      "ff03b4ea0f1f7397422a9d2ba09eda64c29826ffab0ab5698f12f39341658083",
    );
    expect(profileDigestOf(claudeRecord({ options: { route: "moonshot" } }))).toBe(
      "272a0bd5b186b4a9a4ec8fbf7ef2ce666bf88eee84d75614a41e9d3ec1c6a3d5",
    );
    expect(profileDigestOf(claudeRecord({ installationId: "cld-fedcba987654" }))).toBe(
      "c67e358b2e4f561c32b736d32708565edf8623cdd255501b6256f1463b2c32f3",
    );
    expect(
      profileDigestOf(
        claudeRecord({
          driverId: "codex-app-server",
          installationId: "codex-fedcba987654",
          options: { reasoningEffort: "high" },
          revision: 1,
        }),
      ),
    ).toBe("30ac0b5931155ab3626d7522f9974e90c3ebe9e554d0bf655ca056ae0b4d92ea");
    expect(
      profileDigestOf(
        claudeRecord({
          driverId: "codex-app-server",
          installationId: "codex-fedcba987654",
          options: {},
          revision: 1,
        }),
      ),
    ).toBe("b543ae718b8cf842ffa1c8afc6a4f3e252068414c0049357e5cc6d0a6976c08d");
    expect(
      profileDigestOf(
        claudeRecord({
          driverId: "kimi-stream-json",
          installationId: "kimi-fedcba987654",
          options: {},
          revision: 2,
        }),
      ),
    ).toBe("bd62167da7d4090e7bbf3fbbf3961729ad5a32f3f7fd424611cb54a4dbff365f");
    expect(
      profileDigestOf(
        claudeRecord({
          driverId: "grok-stream-json",
          installationId: "grok-0123456789ab",
          options: {},
          revision: 1,
        }),
      ),
    ).toBe("589a5da3c9e404f872b576f0295fd451e4849b9be55cb1bc6d461d33c0cbc282");
    expect(
      profileDigestOf(
        claudeRecord({
          driverId: "cursor-stream-json",
          installationId: "cursor-0123456789ab",
          options: {},
          revision: 1,
        }),
      ),
    ).toBe("968834fc4be74c91f2663e14bf5e3621bfb6db9c07b65b83066de04f271910b8");
  });
});
