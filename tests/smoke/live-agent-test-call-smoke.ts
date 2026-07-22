/**
 * Live Agent 真实调用测试 smoke（V1.1 §2 / AC5 / plan-a §1.9）。
 *
 * 用真实 cfuse / kimi / codex 三个 driver 各完成一次 runAgentRealCallTest
 * round-trip（经 tsx 直接 import helper + 真实 Host + 真实 installations），
 * 不经过 React/Dexie。遵守 43127 独占与串行纪律（assertExclusiveMachine）。
 *
 * 复用 live-runtime-smoke 的 assertExclusiveMachine / acquireSession /
 * waitForHealth / createRealRig / selectModel，不复制一套进程监管逻辑。
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.integration.json pnpm exec tsx \
 *     tests/smoke/live-agent-test-call-smoke.ts
 *
 * 预期 stdout 三行 PASS：cfuse / kimi-stream-json / codex-app-server。必须在
 * 全部 Vitest/Playwright 结束后独占运行。
 */
import { runAgentRealCallTest } from "@/lib/agent-real-call";
import { RuntimeClient } from "@/runtime/client";
import { CANONICAL_ORIGIN, CREDENTIAL_MODE, type DriverId } from "@shared/runtime/contracts";
import type { ExecutionProfileDto } from "@shared/runtime/schemas";
import {
  acquireSession,
  assertExclusiveMachine,
  createRealRig,
  selectModel,
  waitForHealth,
} from "./live-runtime-smoke";

interface DriverCase {
  label: string;
  driverId: DriverId;
  route?: "cfuse";
  hint: string;
}

const CASES: DriverCase[] = [
  { label: "cfuse", driverId: "claude-stream-json", route: "cfuse", hint: "GLM-5.2[1m]" },
  { label: "kimi-stream-json", driverId: "kimi-stream-json", hint: "kimi-code/k3" },
  { label: "codex-app-server", driverId: "codex-app-server", hint: "gpt-5.6-sol" },
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runOne(
  baseUrl: string,
  cookie: string,
  csrfToken: string,
  driverCase: DriverCase,
): Promise<{ ok: boolean; detail: string }> {
  const client = new RuntimeClient({
    baseUrl,
    csrfToken,
    headers: { Cookie: cookie, Origin: CANONICAL_ORIGIN },
  });

  // 选一个 trusted installation 匹配该 driverId。
  const { installations } = await client.listInstallations();
  const installation = installations.find(
    (dto) => dto.driverId === driverCase.driverId && dto.state === "trusted",
  );
  if (!installation) {
    return { ok: false, detail: `no trusted ${driverCase.driverId} installation` };
  }

  const profile: ExecutionProfileDto =
    driverCase.driverId === "claude-stream-json"
      ? {
          driverId: "claude-stream-json",
          installationId: installation.installationId,
          credentialMode: CREDENTIAL_MODE,
          options: { route: driverCase.route ?? "ant-glm5.2" },
        }
      : {
          driverId: driverCase.driverId,
          installationId: installation.installationId,
          credentialMode: CREDENTIAL_MODE,
          options: {},
        };

  // 实时 catalog + readiness 选一个 ready 的 modelId（不使用 fake/静态 fallback）。
  const findings: string[] = [];
  const modelId = await selectModel(client, profile, driverCase.hint, findings);

  const result = await runAgentRealCallTest({
    client,
    profile,
    modelId,
    persona: "You are a live smoke participant. Answer the probe exactly.",
    timeoutMs: 60_000,
  });

  const ok = result.verdict === "completed" && result.outputPreview.trim().length > 0;
  const usage =
    result.usage && (result.usage.inputTokens !== null || result.usage.outputTokens !== null)
      ? `in ${result.usage.inputTokens ?? "?"}/out ${result.usage.outputTokens ?? "?"}`
      : "usage n/a";
  const detailParts: string[] = [
    `verdict=${result.verdict}`,
    `canonical=${result.canonical ?? "?"}`,
    `effective=${result.effective ?? "?"}`,
    `totalMs=${result.totalMs}`,
    `ttftMs=${result.ttftMs ?? "n/a"}`,
    usage,
    `previewLen=${result.outputPreview.length}`,
  ];
  if (result.error) {
    detailParts.push(`err=${result.error.category}:${result.error.code}`);
  }
  if (findings.length) {
    detailParts.push(`findings=${findings.join("; ")}`);
  }
  return { ok, detail: detailParts.join(" ") };
}

async function main(): Promise<void> {
  await assertExclusiveMachine();

  const logLines: string[] = [];
  const rig = await createRealRig(logLines);
  let overallOk = true;
  try {
    const session = await acquireSession(rig.host.baseUrl);
    const client = new RuntimeClient({
      baseUrl: rig.host.baseUrl,
      csrfToken: session.csrfToken,
      headers: { Cookie: session.cookie, Origin: CANONICAL_ORIGIN },
    });
    await waitForHealth(client, 10_000);

    for (const driverCase of CASES) {
      try {
        const outcome = await runOne(
          rig.host.baseUrl,
          session.cookie,
          session.csrfToken,
          driverCase,
        );
        const line = outcome.ok
          ? `PASS ${driverCase.label} — ${outcome.detail}`
          : `FAIL ${driverCase.label} — ${outcome.detail}`;
        process.stdout.write(`${line}\n`);
        if (!outcome.ok) overallOk = false;
      } catch (error) {
        process.stdout.write(`FAIL ${driverCase.label} — ${messageOf(error)}\n`);
        overallOk = false;
      }
    }

    // 最终：rig 的 live driver count 应归零（真实 driver 全关闭）。
    const liveDrivers = rig.liveDriverCount();
    if (liveDrivers !== 0) {
      process.stdout.write(`FAIL leak — ${liveDrivers} live driver process(es) after the run\n`);
      overallOk = false;
    }
  } finally {
    await rig.close();
  }

  if (!overallOk) process.exit(1);
}

main().catch((error) => {
  console.error(`SMOKE ERROR: ${messageOf(error)}`);
  process.exit(1);
});
