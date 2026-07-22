/**
 * Live Agent 真实调用测试 smoke（V1.1 §2 / AC5 / plan-a §1.9）。
 *
 * 用真实 cfuse / kimi / codex 三个 driver 各完成一次 runAgentRealCallTest
 * round-trip（经 tsx 直接 import helper + 真实 Host + 真实 installations），
 * 不经过 React/Dexie。遵守 43127 独占与串行纪律（assertExclusiveMachine）。
 *
 * 复用 live-runtime-smoke 的 assertExclusiveMachine / acquireSession /
 * waitForHealth / createRealRig，不复制一套进程监管逻辑。
 *
 * F4 严格门（reviewer-0）：本 smoke 不复用允许 catalog 失败回退 hint 的
 * selectModel，而是用 strictSelectStrictModel：catalog 必须成功、modelId 必须
 * 来自实时 catalog、profileReadiness 用 refresh:true 且 binding.canonicalModelId
 * === candidate，禁止任何 hint/静态 fallback。每个 driver 完成后断言 Host
 * diagnostics 四项（activeScopes / liveDriverProcesses / runningExecutions /
 * eventConnections）全为 0，避免 closeScope 归零掩盖 execution/scope/SSE 泄漏时
 * 仍然假通过。
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
  waitForHealth,
} from "./live-runtime-smoke";

interface DriverCase {
  label: string;
  driverId: DriverId;
  route?: "cfuse";
}

const CASES: DriverCase[] = [
  { label: "cfuse", driverId: "claude-stream-json", route: "cfuse" },
  { label: "kimi-stream-json", driverId: "kimi-stream-json" },
  { label: "codex-app-server", driverId: "codex-app-server" },
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * F4 严格模型选择：catalog 必须成功、modelId 必须来自实时 catalog、readiness
 * 用 refresh:true 且 canonicalModelId 严格相等。禁止任何 hint / 静态 fallback ——
 * 任一环节失败即抛错，让 smoke 真实失败上报外部阻塞，而非假通过。
 */
async function selectStrictModel(
  client: RuntimeClient,
  profile: ExecutionProfileDto,
): Promise<string> {
  // 1. catalog 必须成功（失败即抛错，绝不回退 hint）。
  const route = profile.driverId === "claude-stream-json" ? profile.options.route : undefined;
  const catalogResp = await client.modelCatalog(profile.driverId, profile.installationId, {
    route,
    refresh: true,
  });
  const catalog = catalogResp.catalog;
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error(`model catalog empty for ${profile.driverId} (catalog must succeed)`);
  }
  // 2. modelId 必须来自实时 catalog，逐候选用 refresh:true readiness 验证，只接受
  //    ready + binding.canonicalModelId === candidate。
  for (const candidate of catalog) {
    try {
      const response = await client.profileReadiness(profile, candidate, { refresh: true });
      const ready =
        response.readiness.state === "ready" &&
        response.binding !== null &&
        response.binding.canonicalModelId === candidate;
      if (ready) return candidate;
    } catch {
      // 该候选不可用，继续下一个 catalog 成员（不回退 hint）。
    }
  }
  throw new Error(
    `no canonical model verifiable from the live catalog for ${profile.driverId} ` +
      `(catalog=${catalog.join(", ")}; readiness must be ready with canonicalModelId===candidate)`,
  );
}

/** 读 Host diagnostics 四项计数（经鉴权 client）。 */
async function readDiagnostics(client: RuntimeClient): Promise<{
  activeScopes: number;
  liveDriverProcesses: number;
  runningExecutions: number;
  eventConnections: number;
}> {
  const diag = await client.diagnostics();
  return diag.scopes;
}

/** F4：每个 driver 完成后断言 diagnostics 四项全为 0（scope/process/execution/SSE）。 */
function assertDiagnosticsZero(
  label: string,
  diag: {
    activeScopes: number;
    liveDriverProcesses: number;
    runningExecutions: number;
    eventConnections: number;
  },
): void {
  const leaks = Object.entries(diag)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => `${key}=${value}`);
  if (leaks.length > 0) {
    throw new Error(`diagnostics leak after ${label}: ${leaks.join(", ")}`);
  }
}

async function runOne(
  client: RuntimeClient,
  driverCase: DriverCase,
): Promise<{ ok: boolean; detail: string }> {
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

  // F4：严格选择 modelId（catalog 必须成功、来自 catalog、readiness refresh+canonical 相等）。
  const modelId = await selectStrictModel(client, profile);

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

  // F4：每个 driver 完成后断言 diagnostics 四项归零（scope/process/execution/SSE）。
  // helper 的 closeScope 把 activeScopes 归零，但这会掩盖未关闭的 execution 或残留
  // 的 SSE 连接——逐项断言确保任何泄漏都被发现而非假通过。
  const diag = await readDiagnostics(client);
  try {
    assertDiagnosticsZero(driverCase.label, diag);
  } catch (error) {
    return { ok: false, detail: `${detailParts.join(" ")} | ${messageOf(error)}` };
  }
  detailParts.push("diagZero=ok");
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
        const outcome = await runOne(client, driverCase);
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
    // F4：最终再断言一次 diagnostics 四项归零（全链路收尾无残留）。
    try {
      const finalDiag = await readDiagnostics(client);
      assertDiagnosticsZero("final", finalDiag);
    } catch (error) {
      process.stdout.write(`FAIL leak — final diagnostics: ${messageOf(error)}\n`);
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
