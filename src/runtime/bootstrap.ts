import { type CouncilKitRuntimeDB, runtimeDb } from "@/lib/runtime-db";
import {
  type DiscussionOrchestrator,
  type LockHandle,
  type LockProvider,
  createDiscussionOrchestrator,
} from "@/orchestrator/discussion-orchestrator";
import { RuntimeClient } from "@/runtime/client";
import { createDisplayBridge } from "@/stores/runtime-discussion";
import { runtimeKeys } from "@/stores/runtime-queries";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Browser-side Runtime bootstrap (U6): wires the app-wide RuntimeClient +
 * Discussion Orchestrator pair as a lazy singleton. Nothing runs at module
 * import time — browser globals (document meta, navigator.locks) are only
 * touched inside the factory so unit tests can import this under Node.
 */

export interface AppRuntime {
  client: RuntimeClient;
  orchestrator: DiscussionOrchestrator;
}

export interface AppRuntimeDeps {
  db: CouncilKitRuntimeDB;
  /** When present, every Orchestrator change notification invalidates all
   * runtime react-queries (the Dexie tick remains the primary signal). */
  queryClient?: QueryClient;
}

/** Read the Host-injected CSRF capability from the document head. */
export function readCsrfToken(doc?: Pick<Document, "querySelector">): string {
  const target = doc ?? (typeof document === "undefined" ? undefined : document);
  const content = target?.querySelector('meta[name="councilkit-csrf"]')?.getAttribute("content");
  if (!content) {
    throw new Error(
      'runtime bootstrap: missing <meta name="councilkit-csrf"> content — ' +
        "the page must be served by the Runtime Host",
    );
  }
  return content;
}

/** Web-Lock provider over navigator.locks: one Scope Controller page per
 * Room. Undefined when the API is unavailable (Orchestrator then uses its
 * no-lock fallback). */
function createWebLockProvider(): LockProvider | undefined {
  if (typeof navigator === "undefined" || !navigator.locks) return undefined;
  const locks = navigator.locks;
  const request = (
    name: string,
    options: LockOptions,
    nullOnAbort: boolean,
  ): Promise<LockHandle | null> =>
    new Promise<LockHandle | null>((resolve, reject) => {
      locks
        .request(name, options, (lock) => {
          if (!lock) {
            // ifAvailable and the lock is held elsewhere.
            resolve(null);
            return undefined;
          }
          // Hold the lock until the handle's release() resolves the callback
          // promise returned to the LockManager.
          return new Promise<void>((release) => {
            resolve({ release });
          });
        })
        .catch((error: unknown) => {
          if (nullOnAbort && error instanceof DOMException && error.name === "AbortError") {
            resolve(null);
          } else {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
    });
  return {
    tryAcquire: (name) => request(name, { ifAvailable: true }, false),
    acquire: (name, signal) => request(name, { signal }, true),
  };
}

let appRuntime: AppRuntime | null = null;

/** Create the app-wide Runtime pair exactly once; later calls return the same
 * instance and ignore their deps. */
export function createAppRuntime(deps: AppRuntimeDeps): AppRuntime {
  if (appRuntime) return appRuntime;
  const client = new RuntimeClient({ baseUrl: "", csrfToken: readCsrfToken() });
  const orchestrator = createDiscussionOrchestrator({
    db: deps.db,
    client,
    locks: createWebLockProvider(),
    display: createDisplayBridge(() => {
      void deps.queryClient?.invalidateQueries({ queryKey: runtimeKeys.all });
    }),
  });
  appRuntime = { client, orchestrator };
  return appRuntime;
}

/** Lazy accessor for the entry point and hooks: the first call may carry
 * deps (default db is the module-level runtimeDb). */
export function getAppRuntime(deps?: Partial<AppRuntimeDeps>): AppRuntime {
  return createAppRuntime({ db: deps?.db ?? runtimeDb, queryClient: deps?.queryClient });
}

let auditStarted = false;

/** Fire-and-forget startup audit (converge crash leftovers; never resume,
 * never re-invoke). Runs at most once per page load. */
export function startRuntimeAudit(): void {
  if (auditStarted) return;
  auditStarted = true;
  void getAppRuntime()
    .orchestrator.startupAudit()
    .catch((error: unknown) => {
      console.warn("runtime startup audit failed", error);
    });
}
