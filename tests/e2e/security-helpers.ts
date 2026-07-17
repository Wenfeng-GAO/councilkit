/**
 * Security E2E helpers (U6, plan §580-582 + §589): shared room setup, in-page
 * tripwires/recorders (requests, dialogs, injected elements, streaming preview
 * and aria-live mutations), legacy-DB/localStorage probes and keyboard-only
 * navigation utilities. Everything asserts through the real browser-visible
 * rendering path; Host state is scripted exclusively via the committed
 * /api/v1/__test__ control namespace in helpers.ts.
 */
import { type Locator, type Page, expect } from "@playwright/test";
import {
  createAgent,
  createProfile,
  createRoom,
  resetDriverState,
  roomParticipants,
  roundSection,
} from "./helpers";

// ---------------------------------------------------------------------------
// Fixture vocabulary (distinct from runtime-host.spec.ts to keep greps clean)
// ---------------------------------------------------------------------------

export const CLAUDE_PROFILE = "安全 GLM Profile";
export const CODEX_PROFILE = "安全 Codex Profile";
export const CLAUDE_AGENT = "安全蓝方";
export const CODEX_AGENT = "安全红方";
export const CLAUDE_MODEL = "e2e-claude-model";
export const CODEX_MODEL = "e2e-codex-model";
export const CLAUDE_INSTALLATION = "claude-e2e-fake01";
export const CODEX_INSTALLATION = "codex-e2e-fake001";

export interface RoomFixture {
  roomId: string;
  claudePid: string;
  codexPid: string;
}

/** First navigation of a test: settings page + driver-state reset. */
export async function bootSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await resetDriverState(page);
}

/** Settings → 2 Profiles → 2 Agents → Room (claude speaks first, facilitates). */
export async function setupRoom(page: Page, topic: string): Promise<RoomFixture> {
  await createProfile(page, {
    name: CLAUDE_PROFILE,
    driverId: "claude-stream-json",
    installationId: CLAUDE_INSTALLATION,
    route: "ant-glm5.2",
  });
  await createProfile(page, {
    name: CODEX_PROFILE,
    driverId: "codex-app-server",
    installationId: CODEX_INSTALLATION,
  });
  await createAgent(page, {
    name: CLAUDE_AGENT,
    persona: "安全测试蓝方评审。",
    profileName: CLAUDE_PROFILE,
    modelId: CLAUDE_MODEL,
    color: "#4f6ef7",
  });
  await createAgent(page, {
    name: CODEX_AGENT,
    persona: "安全测试红方助手。",
    profileName: CODEX_PROFILE,
    modelId: CODEX_MODEL,
    color: "#f74f6e",
  });
  const roomId = await createRoom(page, {
    topic,
    agentNames: [CLAUDE_AGENT, CODEX_AGENT],
    facilitatorName: CLAUDE_AGENT,
  });
  const participants = await roomParticipants(page, roomId);
  const claude = participants.find((participant) => participant.modelId === CLAUDE_MODEL);
  const codex = participants.find((participant) => participant.modelId === CODEX_MODEL);
  expect(claude, "claude participant should exist").toBeTruthy();
  expect(codex, "codex participant should exist").toBeTruthy();
  return { roomId, claudePid: claude?.id as string, codexPid: codex?.id as string };
}

export async function waitRoundPhase(page: Page, roundNumber: number, phaseLabel: string) {
  await expect(
    roundSection(page, roundNumber).locator("summary").getByText(phaseLabel, { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// Untrusted-output payloads (§580). Rendered-shape verified against the real
// SafeMarkdown via react-dom/server before writing these constants.
// ---------------------------------------------------------------------------

/** window markers the payload tries (and must fail) to set. */
export const XSS_MARKERS = ["__xss1", "__xss2", "__xss3", "__xss4"] as const;

/**
 * One combined injection payload covering: raw <script>, <img onerror>, a
 * javascript: link, a data: link, <svg onload>, ANSI CSI escapes, one safe
 * https link and malformed markdown. Blank-line separated so the markdown
 * link segments parse as links while the raw-HTML segments become CommonMark
 * HTML blocks (rendered by SafeMarkdown as inert escaped text either way).
 */
export const UNTRUSTED_PAYLOAD = [
  "<script>window.__xss1=1</script>",
  "",
  '<img src=x onerror="window.__xss2=1">',
  "",
  "[click](javascript:window.__xss3=1) and [d](data:text/html,<script>1</script>)",
  "",
  '<svg onload="window.__xss4=1">',
  "",
  "\u001b[31mRED\u001b[0m **unclosed `tick`ok` and [safe](https://example.com)",
].join("\n");

/**
 * Streaming-preview payload: the fake driver emits reply halves as deltas, so
 * the FIRST delta is exactly this prefix — one complete raw <script> plus an
 * ANSI-wrapped marker word (PRED) that must survive as plain text.
 */
export const PREVIEW_FIRST_DELTA = "<script>window.__xssP=1</script>\u001b[31mPRED\u001b[0m";
export const PREVIEW_MARKER = "__xssP";
export const PREVIEW_PAYLOAD = PREVIEW_FIRST_DELTA + "P".repeat(PREVIEW_FIRST_DELTA.length);

/** Failure-detail payload (< 256 chars): plain-text injection attempt. */
export const FAILURE_PAYLOAD =
  'boom <img src=x onerror="window.__xssF=1"> 与 [x](javascript:window.__xssF2=1) 失败详情';
export const FAILURE_MARKERS = ["__xssF", "__xssF2"] as const;

/** Elements that must never appear from untrusted content (app renders none). */
export const DANGEROUS_SELECTOR = "script,svg,img,iframe,object,embed";
/** Anchors that must never survive URL sanitization. */
export const BAD_ANCHOR_SELECTOR = 'a[href^="javascript:"],a[href^="data:"],a[href^="vbscript:"]';

// ---------------------------------------------------------------------------
// Browser tripwires: requests, websockets, dialogs (§580/§582)
// ---------------------------------------------------------------------------

export interface SecurityTripwires {
  requests: string[];
  websockets: string[];
  dialogs: string[];
}

const CANONICAL_ORIGIN = "http://127.0.0.1:43127";

export function attachSecurityTripwires(page: Page): SecurityTripwires {
  const tripwires: SecurityTripwires = { requests: [], websockets: [], dialogs: [] };
  page.on("request", (request) => tripwires.requests.push(request.url()));
  page.on("websocket", (ws) => tripwires.websockets.push(ws.url()));
  page.on("dialog", (dialog) => {
    tripwires.dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return tripwires;
}

export function requestAuditOffenders(urls: string[]): string[] {
  return urls.filter(
    (url) =>
      !url.startsWith(`${CANONICAL_ORIGIN}/`) &&
      !url.startsWith("data:") &&
      !url.startsWith("blob:"),
  );
}

/**
 * §582: every browser request stays on the canonical origin (or data:/blob:);
 * no provider hosts, no legacy /api/claude, no external websockets; and §580:
 * no dialog (alert/confirm/prompt fired by injected content) ever appeared.
 */
export function expectTripwiresClean(tripwires: SecurityTripwires): void {
  const offenders = requestAuditOffenders(tripwires.requests);
  expect(offenders, `requests left ${CANONICAL_ORIGIN}: ${offenders.join(", ")}`).toEqual([]);
  const providerHits = tripwires.requests.filter((url) =>
    /api\.anthropic\.com|api\.openai\.com|openai\.com|anthropic\.com|moonshot|deepseek|\/api\/claude/i.test(
      url,
    ),
  );
  expect(providerHits, `provider/legacy endpoints hit: ${providerHits.join(", ")}`).toEqual([]);
  const externalWs = tripwires.websockets.filter((url) => !url.startsWith("ws://127.0.0.1:43127"));
  expect(externalWs, `external websockets: ${externalWs.join(", ")}`).toEqual([]);
  expect(tripwires.dialogs, `dialogs fired: ${tripwires.dialogs.join(", ")}`).toEqual([]);
}

/** Read the given window marker names (undefined = injection never ran). */
export async function windowMarkers(page: Page, names: readonly string[]): Promise<unknown[]> {
  return page.evaluate(
    (markerNames) =>
      markerNames.map((name) => (window as unknown as Record<string, unknown>)[name]),
    [...names],
  );
}

// ---------------------------------------------------------------------------
// Streaming recorder (§580 preview): an in-page MutationObserver installed
// BEFORE the round starts, so mid-stream assertions do not race the fake
// driver's 300ms pause fallback. Records injected dangerous elements anywhere
// under <body> and a snapshot of every distinct streaming-preview state.
// ---------------------------------------------------------------------------

export interface PreviewSnapshot {
  text: string;
  dangerousCount: number;
  hasEscapeChar: boolean;
  xssMarker: unknown;
}

export interface StreamingRecord {
  injections: string[];
  previewTexts: string[];
  previewSnapshots: PreviewSnapshot[];
}

interface RecorderWindow {
  __secStreaming?: StreamingRecord;
}

export async function installStreamingRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const DANGEROUS = "script,svg,img,iframe,object,embed";
    const record: StreamingRecord = {
      injections: [],
      previewTexts: [],
      previewSnapshots: [],
    };
    (window as unknown as RecorderWindow).__secStreaming = record;
    let lastText: string | null = null;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(DANGEROUS)) {
            record.injections.push(node.outerHTML.slice(0, 160));
          }
          for (const el of node.querySelectorAll(DANGEROUS)) {
            record.injections.push(el.outerHTML.slice(0, 160));
          }
        }
      }
      const preview = document.querySelector('[data-testid="active-preview"]');
      if (!preview) return;
      const text = (preview.textContent ?? "").slice(0, 2000);
      if (text === lastText) return;
      lastText = text;
      record.previewTexts.push(text);
      record.previewSnapshots.push({
        text,
        dangerousCount: preview.querySelectorAll(DANGEROUS).length,
        hasEscapeChar: text.includes("\u001b"),
        xssMarker: (window as unknown as Record<string, unknown>).__xssP ?? null,
      });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

export async function streamingRecord(page: Page): Promise<StreamingRecord> {
  const record = await page.evaluate(
    () => (window as unknown as RecorderWindow).__secStreaming ?? null,
  );
  expect(record, "streaming recorder was not installed").toBeTruthy();
  return record as StreamingRecord;
}

// ---------------------------------------------------------------------------
// aria-live recorder (§589): log every text mutation of the live region
// during a streamed round. The announcer must speak semantic transitions
// only — never one announcement per streaming delta.
// ---------------------------------------------------------------------------

interface LiveWindow {
  __secLiveLog?: string[];
}

export async function installLiveRegionRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const region = document.querySelector("output[aria-live]");
    if (!region) throw new Error("aria-live region should exist on the room page");
    (window as unknown as LiveWindow).__secLiveLog = [];
    new MutationObserver(() => {
      (window as unknown as LiveWindow).__secLiveLog?.push(region.textContent ?? "");
    }).observe(region, { childList: true, characterData: true, subtree: true });
  });
}

export async function liveRegionLog(page: Page): Promise<string[]> {
  const log = await page.evaluate(() => (window as unknown as LiveWindow).__secLiveLog ?? null);
  expect(log, "live-region recorder was not installed").toBeTruthy();
  return log as string[];
}

// ---------------------------------------------------------------------------
// Legacy data probes (§581): record every IndexedDB open name and every
// localStorage read key from the very first script evaluation, across
// navigations. The target app must never open the legacy `councilkit` DB and
// never read `councilkit.key*` / `councilkit.gateways*` keys.
// ---------------------------------------------------------------------------

export const LEGACY_DB_NAME = "councilkit";
export const RUNTIME_DB_NAME = "councilkit-runtime-v1";
export const LEGACY_SENTINEL = { id: "sentinel", value: "legacy-bytes-☃-0001-不可变" } as const;

interface ProbeWindow {
  __dbOpens?: string[];
  __lsReads?: string[];
}

export async function installLegacyProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const opens: string[] = [];
    const reads: string[] = [];
    Object.defineProperty(window, "__dbOpens", { value: opens });
    Object.defineProperty(window, "__lsReads", { value: reads });
    const originalOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = ((name: string | number, version?: number) => {
      opens.push(String(name));
      return originalOpen(String(name), version);
    }) as typeof indexedDB.open;
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function getItem(this: Storage, key: string) {
      reads.push(String(key));
      return originalGetItem.call(this, key);
    };
  });
}

export async function dbOpenLog(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as unknown as ProbeWindow).__dbOpens ?? [])]);
}

export async function localStorageReadLog(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as unknown as ProbeWindow).__lsReads ?? [])]);
}

/** Pre-seed a legacy `councilkit` DB (three stores + sentinel) and the legacy
 * localStorage key slots — as a pre-cutover user's browser would hold. */
export async function seedLegacyState(page: Page): Promise<void> {
  await page.evaluate((sentinel) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("councilkit", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("rooms", { keyPath: "id" });
        db.createObjectStore("gateways", { keyPath: "id" });
        db.createObjectStore("meta", { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["rooms", "gateways", "meta"], "readwrite");
        tx.objectStore("meta").put(sentinel);
        tx.objectStore("rooms").put({ id: "legacy-room-1", status: "archived" });
        tx.objectStore("gateways").put({ id: "g1", type: "anthropic" });
        tx.oncomplete = () => {
          db.close();
          localStorage.setItem("councilkit.key.enc", "x");
          localStorage.setItem("councilkit.gateways.g1.enc", "y");
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, LEGACY_SENTINEL);
}

/** Read back the legacy sentinel (assertion-only; byte-identical expected). */
export async function readLegacySentinel(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("councilkit");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction("meta", "readonly");
        const get = tx.objectStore("meta").get("sentinel");
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror = () => reject(get.error);
      });
    } finally {
      db.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Keyboard-only navigation (§589): Tab-driven focus movement with an
// activeElement assertion at every step, keyboard select operation and text
// entry. No mouse, no Playwright .fill()/.click() shortcuts in these helpers.
// ---------------------------------------------------------------------------

/** Tab forward until `locator` is document.activeElement (bounded). */
export async function tabToFocus(page: Page, locator: Locator, maxTabs = 120): Promise<void> {
  const target = locator.first();
  await target.waitFor({ state: "visible" });
  for (let i = 0; i < maxTabs; i += 1) {
    const focused = await target.evaluate((el) => el === document.activeElement).catch(() => false);
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  await expect(target, `could not Tab-focus ${target} within ${maxTabs} tabs`).toBeFocused();
}

/** Type text via the keyboard into `locator` (Tab-focus first, then verify). */
export async function keyboardTypeInto(
  page: Page,
  locator: Locator,
  text: string,
  options?: { expectEmptyFirst?: boolean },
): Promise<void> {
  if (options?.expectEmptyFirst) {
    // Form dialogs reset their fields in an effect on open; under full-suite
    // load the reset can land after the first keystroke — wait for it
    // deterministically instead of typing into the stale value.
    await expect(locator).toHaveValue("");
  }
  await tabToFocus(page, locator);
  // insertText drives the input pipeline (IME-style) so CJK copy works; it is
  // still a keyboard-level action — no mouse, no DOM value assignment.
  await page.keyboard.insertText(text);
  await expect(locator).toHaveValue(text);
}

/**
 * Operate a native <select> strictly with the keyboard. Closed native selects
 * ignore Arrow/Home/End keys in headless Chromium (verified by probe), but
 * prefix TYPE-AHEAD works and repeated presses of the same letter cycle
 * through same-letter matches — so this derives the type-ahead key from the
 * wanted option's label and presses until the selection lands (bounded).
 * Requires the wanted option's label to start with an ASCII letter/digit.
 */
export async function keyboardSelect(
  page: Page,
  select: Locator,
  target: string,
  by: "value" | "label" = "value",
): Promise<void> {
  await tabToFocus(page, select);
  const readState = () =>
    select.evaluate((el) => {
      const s = el as HTMLSelectElement;
      return {
        value: s.value,
        label: s.selectedOptions[0]?.textContent ?? "",
        options: [...s.options].map((option) => ({
          value: option.value,
          label: option.textContent ?? "",
        })),
      };
    });
  const initial = await readState();
  const wanted = initial.options.findIndex((option) =>
    by === "value" ? option.value === target : option.label === target,
  );
  expect(wanted, `option "${target}" should exist`).toBeGreaterThanOrEqual(0);
  const wantedLabel = initial.options[wanted]?.label ?? "";
  const key = wantedLabel.trim().charAt(0).toLowerCase();
  expect(
    /^[a-z0-9]$/.test(key),
    `type-ahead needs an ASCII-leading option label, got "${wantedLabel}"`,
  ).toBe(true);
  const matches = (state: { value: string; label: string }) =>
    by === "value" ? state.value === target : state.label === target;
  for (let i = 0; i <= initial.options.length; i += 1) {
    if (matches(await readState())) return;
    await page.keyboard.press(key);
  }
  const actual = await readState();
  expect(
    matches(actual),
    `select should now hold "${target}" (got ${JSON.stringify(actual)})`,
  ).toBe(true);
}
