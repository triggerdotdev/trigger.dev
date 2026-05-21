import type { RequestHandler } from "express";
import { logger } from "./logger.server";

// Last line of defense for leaked error messages in `/api/*` responses.
//
// PR #3664 added a per-route try/catch to every `api.v1.*` loader/action so an
// unhandled throw can no longer reach Remix's default error path and surface
// `error.message` to the client. This middleware sits one layer further out:
// when an `/api/*` response ends with status 5xx and the assembled body matches
// a known leak rule, the body is rewritten to a generic
// `{"error":"Internal Server Error"}` before it reaches the client. The
// original status code is preserved — a leaky 503 stays 503 — so status-aware
// clients keep any nuance the route deliberately set.
//
// Remix's express adapter writes the response body via `res.write(chunk)` (not
// `res.end(chunk)`), so this middleware must buffer writes and evaluate the
// assembled body at `end` time. SSE responses bypass buffering by content-type
// inspection; oversized responses bypass via a hard cap so streaming code
// paths that exceed the cap are not held in memory.
//
// Conservative initial rule set: only the patterns we have observed leaking
// in production are filtered. Mirrors `FINGERPRINT_RULES` in
// `apps/webapp/sentry.server.ts`. Add a rule here when a new leak is spotted.
const LEAK_RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    // Prisma "Can't reach database server" — surfaces connection strings and
    // host info when Postgres is unreachable mid-query (the failure mode that
    // motivated #3664 and the Sentry P1001 fingerprint rule).
    name: "prisma-p1001",
    pattern: /\bP1001\b|Can't reach database server/i,
  },
];

const SANITIZED_BODY = JSON.stringify({ error: "Internal Server Error" });

// Path prefixes the middleware monitors. Scoped to `/api/*` only — the SDK
// surface where leaks have actually been reported. `/engine/*`, `/otel/*`,
// `/realtime/*`, and UI/dashboard routes are intentionally out of scope:
// they have different traffic profiles, leak shapes, or already self-handle
// errors. Expand this list reactively when a leak is observed on another
// namespace.
const MONITORED_PREFIXES = ["/api/"] as const;

// Error responses are tiny. A buffered response that grows past this cap is
// not a 5xx error body — bail out of buffering so streaming responses do not
// pile up in memory.
const MAX_BUFFER_BYTES = 64 * 1024;

export const apiErrorBoundary: RequestHandler = (req, res, next) => {
  if (!MONITORED_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    return next();
  }

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  let chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let bypass = false;

  const flushAndBypass = () => {
    if (bypass) return;
    bypass = true;
    if (chunks.length === 0) return;
    const buffered = Buffer.concat(chunks);
    chunks = [];
    bufferedBytes = 0;
    (originalWrite as (c: Buffer) => boolean)(buffered);
  };

  const isStreamingContentType = (): boolean => {
    const ct = String(res.getHeader("content-type") ?? "");
    if (!ct) return false;
    return ct.includes("text/event-stream") || ct.includes("application/octet-stream");
  };

  const toBuffer = (chunk: unknown): Buffer => {
    if (Buffer.isBuffer(chunk)) return chunk;
    // Covers Uint8Array (Remix's stream output), Uint16Array, Int32Array,
    // DataView, etc. — anything backed by an ArrayBuffer. Without this,
    // `String(chunk)` byte-mangles typed arrays into "85,110,..." strings.
    if (ArrayBuffer.isView(chunk)) {
      return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (typeof chunk === "string") return Buffer.from(chunk);
    return Buffer.from(String(chunk));
  };

  const patchedWrite = (chunk: unknown, ...rest: unknown[]): boolean => {
    // If headers have already been flushed, we cannot rewrite Content-Type
    // or status later — sanitization is impossible. Flush + bypass and let
    // bytes flow through unmodified.
    if (!bypass && (res.headersSent || isStreamingContentType())) flushAndBypass();
    if (bypass) {
      return (originalWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    }
    if (chunk != null) {
      const buf = toBuffer(chunk);
      chunks.push(buf);
      bufferedBytes += buf.length;
      if (bufferedBytes > MAX_BUFFER_BYTES) flushAndBypass();
    }
    return true;
  };

  const patchedEnd = (chunk?: unknown, ...rest: unknown[]) => {
    // Mirror patchedWrite's bypass guards. headersSent: if headers were
    // flushed (e.g. via an explicit `res.flushHeaders()` before end-with-body),
    // we cannot rewrite the response. isStreamingContentType: if a single-call
    // `res.end(chunk)` carries a streaming content-type (SSE / octet-stream),
    // the leak rules are JSON-text heuristics and have no business interpreting
    // that payload — flush unchanged and skip sanitization.
    if (!bypass && (res.headersSent || isStreamingContentType())) flushAndBypass();
    if (bypass) {
      return (originalEnd as (c?: unknown, ...r: unknown[]) => typeof res)(chunk, ...rest);
    }
    if (chunk != null) chunks.push(toBuffer(chunk));
    const body = Buffer.concat(chunks);
    bypass = true;

    if (res.statusCode >= 500 && body.length > 0) {
      const text = body.toString("utf8");
      const matched = LEAK_RULES.find((rule) => rule.pattern.test(text));
      if (matched) {
        logger.error("apiErrorBoundary sanitized leaked error response", {
          rule: matched.name,
          path: req.path,
          method: req.method,
          status: res.statusCode,
        });
        res.setHeader("Content-Type", "application/json");
        res.removeHeader("Content-Length");
        return (originalEnd as (c?: unknown) => typeof res)(SANITIZED_BODY);
      }
    }

    if (body.length > 0) (originalWrite as (c: Buffer) => boolean)(body);
    return (originalEnd as () => typeof res)();
  };

  res.write = patchedWrite as unknown as typeof res.write;
  res.end = patchedEnd as unknown as typeof res.end;

  next();
};
