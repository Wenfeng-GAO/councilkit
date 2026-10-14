/**
 * Read-only check that the verification Runtime Host is the one this run
 * started and that it can serve the app shell. Writes doctor.json.
 * Exit 0 ready, 10 not ready yet, 1 hard failure. Never signals a process.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { descendants, isVerificationProcess, listenerPids, readProc } from "./proc.mjs";

const statePath = process.env.VERIFY_STATE;
const evidenceDir = process.env.VERIFY_EVIDENCE;
const expectedSha = process.env.VERIFY_SHA ?? "";
if (!statePath || !evidenceDir) {
  process.stderr.write("doctor-check requires VERIFY_STATE and VERIFY_EVIDENCE\n");
  process.exit(1);
}

function fail(reason, extra = {}, code = 1) {
  const payload = { ok: false, ready: false, reason, ...extra, checkedAt: new Date().toISOString() };
  writeFileSync(`${evidenceDir}/doctor.json`, `${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(`${reason}\n`);
  process.exit(code);
}

let state;
try {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  fail("no verification host state; run launch.sh", {}, 1);
}

if (state.status === "stopped") {
  fail("verification host is stopped; run launch.sh", { origin: state.origin ?? null }, 1);
}
if (state.port === 43127) {
  fail("refusing canonical port 43127", { port: state.port }, 1);
}
if (expectedSha && state.sha !== expectedSha) {
  fail(
    `host was started for ${state.sha} but HEAD is ${expectedSha}; cleanup.sh and launch.sh again`,
    { sha: state.sha },
    1,
  );
}

const supervisor = readProc(state.supervisorPid);
if (!supervisor || !isVerificationProcess(supervisor, state.cwd)) {
  fail("supervisor pid is not the verification host we started", {
    supervisorPid: state.supervisorPid,
  }, 10);
}

let logText = "";
try {
  logText = readFileSync(state.log, "utf8");
} catch {
  logText = "";
}
const loggedStart = logText.includes('"event":"host.started"');
const nodeRefused = logText.includes("UNSUPPORTED_NODE");
const portInUse = logText.includes("PORT_IN_USE");
if (nodeRefused) fail("Runtime Host refused this Node. Node.js 22.x is required.", {}, 1);
if (portInUse) fail(`port ${state.port} is already in use`, { port: state.port }, 1);

const tree = new Set(descendants(state.supervisorPid));
const listeners = listenerPids(state.port);
const foreign = listeners.filter((pid) => !tree.has(pid));
if (foreign.length > 0) {
  fail(`port ${state.port} is held by a process this run did not start`, {
    port: state.port,
    foreignPids: foreign,
  }, 1);
}

if (!loggedStart || listeners.length === 0) {
  fail("host process is up but not listening yet", {
    port: state.port,
    loggedStart,
    listeners,
  }, 10);
}

const origin = state.origin;
let healthResponse;
let documentResponse;
try {
  healthResponse = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(15_000) });
  documentResponse = await fetch(`${origin}/`, { signal: AbortSignal.timeout(20_000) });
} catch (error) {
  fail(`origin not accepting HTTP yet: ${error instanceof Error ? error.name : "error"}`, {
    origin,
  }, 10);
}

if (!healthResponse.ok) {
  fail(`health HTTP ${healthResponse.status}`, { origin }, 10);
}
const healthEnvelope = await healthResponse.json();
const health = healthEnvelope?.data;
if (!healthEnvelope?.ok || health?.apiVersion !== "v1" || health?.node?.major !== 22) {
  fail("health payload is not a Node 22 v1 Runtime Host", { origin }, 1);
}

const html = await documentResponse.text();
const cookies =
  typeof documentResponse.headers.getSetCookie === "function"
    ? documentResponse.headers.getSetCookie()
    : [];
const hasSessionCookie = cookies.some((cookie) => cookie.startsWith("councilkit_session="));
const hasCsrfMeta = html.includes('name="councilkit-csrf"');
const hasRoot = html.includes('id="root"');
const hasTitle = html.includes("<title>CouncilKit</title>");
if (documentResponse.status !== 200 || !hasSessionCookie || !hasCsrfMeta || !hasRoot || !hasTitle) {
  fail("document shell is not usable yet", {
    origin,
    status: documentResponse.status,
    hasSessionCookie,
    hasCsrfMeta,
    hasRoot,
    hasTitle,
  }, 10);
}

const payload = {
  ok: true,
  ready: true,
  origin,
  port: state.port,
  mode: state.mode,
  sha: state.sha,
  supervisorPid: state.supervisorPid,
  listenerPids: listeners,
  health: {
    apiVersion: health.apiVersion,
    hostInstanceId: health.hostInstanceId,
    node: health.node.version,
  },
  document: {
    status: documentResponse.status,
    hasRoot: true,
    hasTitle: true,
    hasSessionCookie: true,
    hasCsrfMeta: true,
  },
  logEvent: "host.started",
  checkedAt: new Date().toISOString(),
};
writeFileSync(`${evidenceDir}/doctor.json`, `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(
  `ready ${origin} sha=${state.sha} node=${health.node.version} host=${health.hostInstanceId}\n`,
);
