import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { API_BASE, LIMITS } from "@shared/runtime/contracts";
import { type RuntimeError, makeError } from "@shared/runtime/errors";
import type { z } from "zod";
import type { HostConfig } from "./config";
import type { Logger } from "./logging";
import { sanitizeString } from "./logging";
import { type AuthLevel, guardRequest, isPreflight } from "./security/request-guard";
import type { SessionCapability } from "./security/session-capability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HostServices {
  config: HostConfig;
  logger: Logger;
  session: SessionCapability;
  hostInstanceId: string;
  startedAt: string;
  /** Filled by U2/U3 modules; routes close over the same object. */
  [module: string]: unknown;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed + schema-validated JSON body (mutation routes with bodySchema). */
  body: unknown;
  services: HostServices;
}

export interface Route {
  method: "GET" | "POST" | "DELETE";
  /** e.g. "/api/v1/scopes/:scopeId/executions/:executionId/ack" */
  pattern: string;
  auth: AuthLevel;
  bodySchema?: z.ZodType<unknown>;
  responseSchema?: z.ZodType<unknown>;
  /** Raw routes own the response stream (e.g. event streams). */
  raw?: boolean;
  handler(ctx: RouteContext): Promise<unknown> | unknown;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly runtimeError: RuntimeError,
  ) {
    super(runtimeError.message);
  }
}

export function httpError(status: number, error: RuntimeError): HttpError {
  return new HttpError(status, error);
}

// ---------------------------------------------------------------------------
// Security headers / CSP
// ---------------------------------------------------------------------------

function apiSecurityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

function documentCsp(nonce: string, mode: "development" | "production"): string {
  const connectSrc =
    mode === "development" ? "connect-src 'self' ws://127.0.0.1:43127" : "connect-src 'self'";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    connectSrc,
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function documentHeaders(
  nonce: string,
  mode: "development" | "production",
): Record<string, string> {
  return {
    "Content-Security-Policy": documentCsp(nonce, mode),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

// ---------------------------------------------------------------------------
// Body reading with hard limits
// ---------------------------------------------------------------------------

export function assertJsonDepth(value: unknown, maxDepth = LIMITS.jsonMaxDepth): void {
  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth) {
      throw httpError(
        400,
        makeError("BAD_REQUEST", "security", `JSON nesting exceeds ${maxDepth} levels.`),
      );
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    } else if (node !== null && typeof node === "object") {
      for (const item of Object.values(node as Record<string, unknown>)) walk(item, depth + 1);
    }
  };
  walk(value, 0);
}

async function readJsonBody(req: IncomingMessage, limit = LIMITS.httpBodyBytes): Promise<unknown> {
  const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > limit) {
    throw httpError(
      413,
      makeError("PAYLOAD_TOO_LARGE", "security", "Request body exceeds the 4 MiB limit."),
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > limit) {
      throw httpError(
        413,
        makeError("PAYLOAD_TOO_LARGE", "security", "Request body exceeds the 4 MiB limit."),
      );
    }
    chunks.push(buf);
  }
  if (total === 0) {
    throw httpError(400, makeError("BAD_REQUEST", "security", "Missing JSON request body."));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw httpError(400, makeError("BAD_REQUEST", "security", "Request body is not valid JSON."));
  }
  assertJsonDepth(parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

interface CompiledRoute extends Route {
  segments: string[];
}

function compilePattern(pattern: string): string[] {
  return pattern.split("/").filter((segment) => segment.length > 0);
}

function matchRoute(
  route: CompiledRoute,
  method: string,
  pathSegments: string[],
): Record<string, string> | null {
  if (route.method !== method) return null;
  if (route.segments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i += 1) {
    const want = route.segments[i] as string;
    const got = pathSegments[i] as string;
    if (want.startsWith(":")) {
      try {
        params[want.slice(1)] = decodeURIComponent(got);
      } catch {
        return null;
      }
    } else if (want !== got) {
      return null;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface RuntimeServerOptions {
  services: HostServices;
  routes: Route[];
  /** Dev-only Vite middleware server; production serves config.distDir. */
  viteMiddlewares?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  transformIndexHtml?: (url: string, html: string) => Promise<string>;
  indexHtmlPath?: string;
}

export interface RuntimeServer {
  server: Server;
  listen(port?: number, hostname?: string): Promise<void>;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...apiSecurityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendRuntimeError(res: ServerResponse, status: number, error: RuntimeError): void {
  sendJson(res, status, { ok: false, error });
}

function injectIntoDocument(html: string, nonce: string, csrfToken: string): string {
  let out = html.replace(/<script(?![^>]*\bsrc=)/g, `<script nonce="${nonce}"`);
  out = out.replace(/<script(?=[^>]*\bsrc=)/g, `<script nonce="${nonce}"`);
  const meta = `<meta name="councilkit-csrf" content="${csrfToken}">`;
  if (out.includes("<head>")) {
    out = out.replace("<head>", `<head>\n    ${meta}`);
  } else {
    out = meta + out;
  }
  return out;
}

export function createRuntimeServer(options: RuntimeServerOptions): RuntimeServer {
  const { services } = options;
  const { config, logger, session } = services;
  const routes: CompiledRoute[] = options.routes.map((route) => ({
    ...route,
    segments: compilePattern(route.pattern),
  }));

  async function serveDocument(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const nonce = randomBytes(16).toString("base64");
    let html: string;
    const url = req.url ?? "/";
    if (options.transformIndexHtml) {
      const indexPath = options.indexHtmlPath ?? resolve("index.html");
      html = await options.transformIndexHtml(url, await readFile(indexPath, "utf8"));
    } else {
      html = await readFile(join(config.distDir, "index.html"), "utf8");
    }
    const body = injectIntoDocument(html, nonce, session.csrfToken);
    res.writeHead(200, {
      ...documentHeaders(nonce, config.mode),
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": session.sessionCookieValue(),
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  function serveStatic(pathname: string, res: ServerResponse): boolean {
    if (config.mode !== "production") return false;
    const distRoot = resolve(config.distDir);
    const candidate = normalize(resolve(join(distRoot, pathname)));
    if (candidate !== distRoot && !candidate.startsWith(distRoot + sep)) {
      return false;
    }
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      return false;
    }
    const type = STATIC_CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream";
    const immutable = pathname.startsWith("/assets/");
    res.writeHead(200, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-store",
      "Content-Length": statSync(candidate).size,
      ETag: `W/"${createHash("sha256").update(candidate).digest("hex").slice(0, 16)}-${statSync(candidate).size}"`,
    });
    createReadStream(candidate).pipe(res);
    return true;
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const pathSegments = compilePattern(pathname);

    if (isPreflight(req)) {
      sendRuntimeError(
        res,
        405,
        makeError("METHOD_NOT_ALLOWED", "security", "CORS preflight is not supported."),
      );
      return;
    }

    // Determine the auth level of the matched route shape before reading any
    // body: the guard must run before side effects or large allocations.
    let matched: CompiledRoute | null = null;
    let params: Record<string, string> | null = null;
    let pathKnown = false;
    for (const route of routes) {
      if (route.segments.length !== pathSegments.length) continue;
      const attempt = matchRoute(route, method, pathSegments);
      if (attempt) {
        matched = route;
        params = attempt;
        break;
      }
      // Track whether the path exists for another method (405 vs 404).
      const shapeMatch = route.segments.every((seg, i) =>
        seg.startsWith(":") ? true : seg === pathSegments[i],
      );
      if (shapeMatch) pathKnown = true;
    }

    const auth: AuthLevel = matched?.auth ?? "session";
    const guard = guardRequest(req, { auth, session });
    if (!guard.ok) {
      sendRuntimeError(res, guard.status, guard.error);
      return;
    }

    if (!matched || !params) {
      const status = pathKnown ? 405 : 404;
      sendRuntimeError(
        res,
        status,
        makeError(
          pathKnown ? "METHOD_NOT_ALLOWED" : "NOT_FOUND",
          "security",
          pathKnown ? "Method not allowed for this route." : "Unknown API route.",
        ),
      );
      return;
    }

    try {
      let body: unknown;
      if (matched.bodySchema) {
        const raw = await readJsonBody(req);
        const parsed = matched.bodySchema.safeParse(raw);
        if (!parsed.success) {
          sendRuntimeError(
            res,
            400,
            makeError("BAD_REQUEST", "security", "Request body failed schema validation.", {
              retryable: false,
            }),
          );
          return;
        }
        body = parsed.data;
      }

      const ctx: RouteContext = {
        req,
        res,
        params,
        query: new URL(req.url ?? "/", "http://127.0.0.1").searchParams,
        body,
        services,
      };
      const data = await matched.handler(ctx);
      if (matched.raw) return; // raw handlers own the stream
      if (matched.responseSchema) {
        const check = matched.responseSchema.safeParse(data);
        if (!check.success) {
          logger.error("response.schema_violation", { pattern: matched.pattern });
          sendRuntimeError(
            res,
            500,
            makeError("INTERNAL", "security", "Response failed contract validation."),
          );
          return;
        }
      }
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      if (error instanceof HttpError) {
        sendRuntimeError(res, error.status, error.runtimeError);
        return;
      }
      logger.error("route.unhandled_error", {
        pattern: matched.pattern,
        error: sanitizeString(error instanceof Error ? error.message : String(error)),
      });
      sendRuntimeError(res, 500, makeError("INTERNAL", "security", "Unhandled internal error."));
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;

      if (pathname.startsWith(`${API_BASE}/`) || pathname === API_BASE) {
        await handleApi(req, res, pathname);
        return;
      }

      // Document/static surface: exact Host header as well, GET/HEAD only.
      const hostGuard = guardRequest(req, { auth: "public", session });
      if (!hostGuard.ok) {
        sendRuntimeError(res, hostGuard.status, hostGuard.error);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendRuntimeError(
          res,
          405,
          makeError("METHOD_NOT_ALLOWED", "security", "Only GET is supported on this surface."),
        );
        return;
      }

      if (config.mode === "production") {
        if (serveStatic(pathname, res)) return;
        await serveDocument(req, res);
        return;
      }

      // Development: Vite middleware serves modules/assets; requests it does
      // not handle fall through to our injected index.html.
      if (options.viteMiddlewares) {
        options.viteMiddlewares(req, res, () => {
          serveDocument(req, res).catch((error) => {
            logger.error("server.document", {
              error: sanitizeString(error instanceof Error ? error.message : String(error)),
            });
            if (!res.headersSent) {
              sendRuntimeError(
                res,
                500,
                makeError("INTERNAL", "security", "Failed to serve the application shell."),
              );
            } else {
              res.end();
            }
          });
        });
        return;
      }
      await serveDocument(req, res);
    })().catch((error) => {
      logger.error("server.unhandled", {
        error: sanitizeString(error instanceof Error ? error.message : String(error)),
      });
      if (!res.headersSent) {
        sendRuntimeError(res, 500, makeError("INTERNAL", "security", "Unhandled internal error."));
      } else {
        res.end();
      }
    });
  });

  // Track live sockets so close() can shut down promptly instead of waiting
  // out client keep-alive timeouts or unbounded SSE responses.
  const liveSockets = new Set<Socket>();
  server.on("connection", (socket) => {
    liveSockets.add(socket);
    socket.on("close", () => liveSockets.delete(socket));
  });

  return {
    server,
    listen(port = config.port, hostname = config.hostname) {
      return new Promise((resolvePromise, rejectPromise) => {
        const onError = (error: NodeJS.ErrnoException) => {
          if (error.code === "EADDRINUSE") {
            rejectPromise(
              httpError(
                500,
                makeError(
                  "PORT_IN_USE",
                  "bootstrap",
                  `Port ${port} is already in use. Identify the occupant (e.g. lsof -nP -iTCP:${port} -sTCP:LISTEN) and stop it; the canonical origin never moves.`,
                ),
              ),
            );
          } else {
            rejectPromise(error);
          }
        };
        server.once("error", onError);
        server.listen(port, hostname, () => {
          server.removeListener("error", onError);
          resolvePromise();
        });
      });
    },
    close() {
      return new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
        // Idle keep-alive sockets otherwise linger for the client's own
        // keep-alive timeout (undici: ~4s) and delay shutdown; active ones
        // (e.g. open SSE streams) are destroyed — this is a shutdown path.
        server.closeIdleConnections();
        for (const socket of liveSockets) socket.destroy();
      });
    },
  };
}
