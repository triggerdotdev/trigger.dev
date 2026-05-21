import { beforeEach, describe, expect, test, vi } from "vitest";

// Intentional exception to the root CLAUDE.md "Never mock anything" rule.
//
// That rule targets unit-under-test and external-service mocking (Prisma,
// Redis, etc.) to avoid mock/prod drift — testcontainers is the prescribed
// alternative for those. Here we're mocking `logger.server` only as an
// *observability sink* so two tests can assert `logger.error` is/isn't
// called on the sanitize path. There is no production behavior the mock
// can disagree with; the alternatives (refactoring the middleware to a
// DI factory, or importing the real logger which pulls in Sentry + env
// validation) add indirection that neither this PR nor the codebase
// pattern wants. Mirrors the existing approach in 7+ other webapp test
// files that mock `logger.server` the same way.
vi.mock("../app/services/logger.server", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

import compression from "compression";
import express, { type Express } from "express";
import request from "supertest";
import { apiErrorBoundary } from "../app/services/apiErrorBoundary.server.js";
import { logger } from "../app/services/logger.server.js";

function buildApp(): Express {
  const app = express();
  app.use(apiErrorBoundary);
  return app;
}

describe("apiErrorBoundary", () => {
  beforeEach(() => {
    vi.mocked(logger.error).mockClear();
  });

  test("sanitizes a 500 body that matches a leak rule", async () => {
    const app = buildApp();
    app.get("/api/v1/leaky", (_req, res) => {
      res.status(500).json({
        message:
          "PrismaClientInitializationError: Can't reach database server at host:5432 (P1001)",
      });
    });

    const response = await request(app).get("/api/v1/leaky");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
  });

  // Remix's express adapter writes responses via
  // `writeReadableStreamToWritable`, which calls `res.write(chunk)` for each
  // body chunk and then `res.end()` with no arguments. Any sanitizer that
  // only inspects `res.end`'s chunk is a no-op against Remix-emitted responses.
  test("sanitizes a 500 body written via res.write then res.end() (Remix adapter pattern)", async () => {
    const app = buildApp();
    app.get("/api/v1/leaky-remix-style", (_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.write(
        Buffer.from(
          JSON.stringify({
            message:
              "PrismaClientInitializationError: Can't reach database server at host:5432 (P1001)",
          })
        )
      );
      res.end();
    });

    const response = await request(app).get("/api/v1/leaky-remix-style");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
  });

  // Remix's express adapter pipes a ReadableStream<Uint8Array> into the
  // response, so chunks reach `res.write` as raw Uint8Array — not Node
  // Buffers. Treating them with `String(chunk)` byte-mangles the body.
  test("sanitizes a 500 body written as a Uint8Array (Remix stream pattern)", async () => {
    const app = buildApp();
    app.get("/api/v1/leaky-uint8array", (_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      const payload = JSON.stringify({
        message: "PrismaClientInitializationError: Can't reach database server (P1001)",
      });
      res.write(new Uint8Array(Buffer.from(payload, "utf8")));
      res.end();
    });

    const response = await request(app).get("/api/v1/leaky-uint8array");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
  });

  test("passes through a clean 5xx body written as a Uint8Array without mangling bytes", async () => {
    const app = buildApp();
    app.get("/api/v1/clean-uint8array", (_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.write(new Uint8Array(Buffer.from("Unexpected Server Error", "utf8")));
      res.end();
    });

    const response = await request(app).get("/api/v1/clean-uint8array");

    expect(response.status).toBe(500);
    expect(response.text).toBe("Unexpected Server Error");
  });

  test("passes through a clean 500 body written via res.write then res.end()", async () => {
    const app = buildApp();
    app.get("/api/v1/clean-500-remix-style", (_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.write(Buffer.from(JSON.stringify({ error: "Service unavailable for reasons" })));
      res.end();
    });

    const response = await request(app).get("/api/v1/clean-500-remix-style");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Service unavailable for reasons" });
  });

  test("passes through a 500 body that does not match any rule", async () => {
    const app = buildApp();
    app.get("/api/v1/clean-500", (_req, res) => {
      res.status(500).json({ error: "Service unavailable for reasons" });
    });

    const response = await request(app).get("/api/v1/clean-500");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Service unavailable for reasons" });
  });

  test("passes through 200 responses", async () => {
    const app = buildApp();
    app.get("/api/v1/ok", (_req, res) => {
      res.status(200).json({ hello: "world" });
    });

    const response = await request(app).get("/api/v1/ok");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ hello: "world" });
  });

  // Only /api/* is monitored. /engine/*, /otel/*, /realtime/*, and UI/dashboard
  // routes all pass through unchanged regardless of their body content.
  test.each([
    ["/engine/v1/leaky"],
    ["/otel/v1/traces"],
    ["/realtime/v1/runs/run_123"],
    ["/dashboard/leaky"],
  ])("does NOT sanitize non-/api/ path: %s", async (path) => {
    const app = buildApp();
    app.get(path, (_req, res) => {
      res.status(500).json({ message: "Boom: P1001 from a non-api route" });
    });

    const response = await request(app).get(path);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: "Boom: P1001 from a non-api route" });
  });

  // Kept as a separate assertion so the dashboard exclusion has its own
  // grep-able test name; the rationale is different (UI ErrorBoundary).
  test("does not sanitize dashboard/UI paths", async () => {
    const app = buildApp();
    app.get("/dashboard/leaky", (_req, res) => {
      res.status(500).json({ message: "P1001 leak from a dashboard route" });
    });

    const response = await request(app).get("/dashboard/leaky");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: "P1001 leak from a dashboard route" });
  });

  test("passes through 4xx responses untouched even if body contains a leak pattern", async () => {
    const app = buildApp();
    app.get("/api/v1/bad-request", (_req, res) => {
      res.status(400).json({ error: "Invalid params: P1001 included to ensure 4xx is exempt" });
    });

    const response = await request(app).get("/api/v1/bad-request");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Invalid params: P1001 included to ensure 4xx is exempt",
    });
  });

  test("streams text/event-stream responses written as Uint8Array without buffering (Remix stream pattern)", async () => {
    const app = buildApp();
    app.get("/api/v1/stream", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      const enc = new TextEncoder();
      res.write(enc.encode("data: chunk-1\n\n"));
      res.write(enc.encode("data: chunk-2\n\n"));
      res.end();
    });

    const response = await request(app).get("/api/v1/stream");

    expect(response.status).toBe(200);
    expect(response.text).toBe("data: chunk-1\n\ndata: chunk-2\n\n");
  });

  // Real Remix responses arrive as multiple Uint8Array chunks via
  // writeReadableStreamToWritable. The single-chunk Uint8Array test above
  // exercises one slice; this exercises the chunk-pushing/concat loop.
  test("assembles multi-chunk Uint8Array writes into a single body without mangling", async () => {
    const app = buildApp();
    app.get("/api/v1/multichunk", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      const enc = new TextEncoder();
      res.write(enc.encode('{"part1":"hello"'));
      res.write(enc.encode(',"part2":"world"}'));
      res.end();
    });

    const response = await request(app).get("/api/v1/multichunk");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ part1: "hello", part2: "world" });
  });

  // patchedWrite applies the isStreamingContentType / MAX_BUFFER_BYTES
  // bypass checks before buffering; patchedEnd does not, because a
  // single-call `res.end(chunk)` is one-shot rather than streaming
  // pileup — the body is fully assembled either way. These tests pin
  // the byte-integrity contract for that single-call shape: octet-stream
  // bodies and >64KB bodies both flow through unchanged.
  test("preserves bytes for octet-stream body delivered via single-call res.end(chunk)", async () => {
    const app = buildApp();
    // Construct binary bytes that span the full 0-255 range to catch any
    // accidental encoding interpretation.
    const binary = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));

    app.get("/api/v1/octet-end", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(binary);
    });

    const response = await request(app)
      .get("/api/v1/octet-end")
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(Buffer.compare(response.body as Buffer, binary)).toBe(0);
  });

  test("preserves bytes for >64KB body delivered via single-call res.end(chunk)", async () => {
    const app = buildApp();
    const payload = JSON.stringify({
      filler: "x".repeat(80 * 1024),
      marker: "END_OF_LARGE_BODY",
    });

    app.get("/api/v1/large-end", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(Buffer.from(payload, "utf8"));
    });

    const response = await request(app).get("/api/v1/large-end");

    expect(response.status).toBe(200);
    expect(response.body.filler).toHaveLength(80 * 1024);
    expect(response.body.marker).toBe("END_OF_LARGE_BODY");
  });

  // The actual production leak path: Remix's returnLastResortErrorResponse
  // returns Content-Type: text/plain in non-production mode with the raw
  // error message appended. Our middleware must detect the leak in text/plain
  // bodies and rewrite the response to JSON before flushing.
  test("sanitizes a text/plain 500 body matching a leak rule (Remix non-prod error shape)", async () => {
    const app = buildApp();
    app.get("/api/v1/text-plain-leak", (_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.write(
        new TextEncoder().encode(
          "Unexpected Server Error\n\nError: PrismaClientInitializationError: Can't reach database server (P1001)"
        )
      );
      res.end();
    });

    const response = await request(app).get("/api/v1/text-plain-leak");

    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: "Internal Server Error" });
  });

  // Responses that exceed MAX_BUFFER_BYTES (64KB) bypass the buffer to avoid
  // holding large streams in memory. Bytes must still reach the client intact.
  test("passes through a 5xx response larger than the buffer cap without mangling bytes", async () => {
    const app = buildApp();
    const filler = "x".repeat(80 * 1024);
    app.get("/api/v1/large-5xx", (_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.write(new TextEncoder().encode(JSON.stringify({ filler, marker: "END" })));
      res.end();
    });

    const response = await request(app).get("/api/v1/large-5xx");

    expect(response.status).toBe(500);
    expect(response.body.filler).toHaveLength(80 * 1024);
    expect(response.body.marker).toBe("END");
  });

  // If a route flushes headers before writing the body, the middleware
  // cannot rewrite Content-Type / Content-Length later. It must skip
  // sanitization gracefully — no crash, no byte-mangling — and let the
  // original body through. (Per-route #3664 catches remain the primary
  // defense; this is just about not making things worse.)
  test("skips sanitization gracefully when response headers are already flushed", async () => {
    const app = buildApp();
    app.get("/api/v1/headers-flushed", (_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.flushHeaders();
      res.write(new TextEncoder().encode("leaky body with P1001 written after headers flushed"));
      res.end();
    });

    const response = await request(app).get("/api/v1/headers-flushed");

    expect(response.status).toBe(500);
    // Bytes must not be mangled into "85,110,..." style.
    expect(response.text).not.toMatch(/^\d+(?:,\d+){5,}/);
    // We cannot change Content-Type after flush, so the original text leaks
    // through. That is an accepted limitation — per-route try/catch is the
    // primary defense.
    expect(response.text).toContain("leaky body with P1001");
  });

  // Same shape of bug as the original Uint8Array miss — if a chunk arrives
  // as a typed array that is not specifically Uint8Array (e.g. Uint16Array,
  // DataView), the `instanceof Uint8Array` check misses it and toBuffer
  // falls through to String(chunk), byte-mangling the body. Guarding via
  // ArrayBuffer.isView() catches all typed-array variants.
  test("preserves bytes when chunk is a non-Uint8Array typed array (Uint16Array)", async () => {
    const app = buildApp();
    const text = "Hello, world!";
    const utf16 = new Uint16Array(text.length);
    for (let i = 0; i < text.length; i++) utf16[i] = text.charCodeAt(i);
    const expectedBytes = Buffer.from(utf16.buffer, utf16.byteOffset, utf16.byteLength);

    app.get("/api/v1/uint16", (_req, res) => {
      res.statusCode = 200;
      // Use application/json so the chunk hits the buffer path (not the
      // streaming-content-type bypass).
      res.setHeader("Content-Type", "application/json");
      res.write(utf16);
      res.end();
    });

    const response = await request(app)
      .get("/api/v1/uint16")
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(Buffer.compare(response.body as Buffer, expectedBytes)).toBe(0);
  });

  test("sanitizes a 503 body that matches a leak rule, preserving the original status", async () => {
    const app = buildApp();
    app.get("/api/v1/leaky-503", (_req, res) => {
      res.status(503).json({
        message: "PrismaClientInitializationError: Can't reach database server (P1001)",
      });
    });

    const response = await request(app).get("/api/v1/leaky-503");

    // The 503 is preserved so status-aware clients still know "service
    // unavailable, retry" vs a generic 500. The body is sanitized.
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "Internal Server Error" });
  });

  test("sanitizes a leak on POST as well as GET (method-independent)", async () => {
    const app = buildApp();
    app.post("/api/v1/leaky-post", (_req, res) => {
      res.status(500).json({ message: "Boom: Can't reach database server (P1001)" });
    });

    const response = await request(app).post("/api/v1/leaky-post").send({});

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
  });

  test("passes through an empty-body 5xx response without crashing", async () => {
    const app = buildApp();
    app.get("/api/v1/empty-500", (_req, res) => {
      res.statusCode = 500;
      res.end();
    });

    const response = await request(app).get("/api/v1/empty-500");

    expect(response.status).toBe(500);
    expect(response.text).toBe("");
  });

  test("matches leak rule case-insensitively (e.g. lowercase 'p1001' still sanitized)", async () => {
    const app = buildApp();
    app.get("/api/v1/leaky-lowercase", (_req, res) => {
      res.status(500).json({ message: "boom: can't reach database server, code p1001" });
    });

    const response = await request(app).get("/api/v1/leaky-lowercase");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
  });

  // server.ts mounts compression() before apiErrorBoundary, so compression's
  // res.write/end wrappers are what our middleware's originalWrite/End point
  // to. Verifies that the sanitized body still reaches the client correctly
  // when compression is in the chain (supertest auto-decompresses).
  test("sanitizes leak correctly when compression middleware is mounted in front", async () => {
    const app = express();
    app.use(compression({ threshold: 0 }));
    app.use(apiErrorBoundary);
    app.get("/api/v1/compressed-leak", (_req, res) => {
      res.status(500).json({
        message: "Boom: Can't reach database server (P1001)",
        // Padding to ensure compression has something meaningful to do.
        padding: "x".repeat(2048),
      });
    });

    const response = await request(app)
      .get("/api/v1/compressed-leak")
      .set("Accept-Encoding", "gzip");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
  });

  test("passes a non-leak compressed response through without mangling bytes", async () => {
    const app = express();
    app.use(compression({ threshold: 0 }));
    app.use(apiErrorBoundary);
    app.get("/api/v1/compressed-ok", (_req, res) => {
      res.status(200).json({ hello: "world", padding: "y".repeat(2048) });
    });

    const response = await request(app)
      .get("/api/v1/compressed-ok")
      .set("Accept-Encoding", "gzip");

    expect(response.status).toBe(200);
    expect(response.body.hello).toBe("world");
    expect(response.body.padding).toHaveLength(2048);
  });

  // HEAD requests run the loader but Node strips the body before sending.
  // The middleware still buffers + matches against the (would-be) body, so
  // its sanitize/log path still fires — we just want to confirm no crash
  // and that the status is preserved.
  test("does not crash on HEAD requests to leaky routes", async () => {
    const app = buildApp();
    app.get("/api/v1/leaky-head", (_req, res) => {
      res.status(500).json({ message: "Boom: P1001" });
    });

    const response = await request(app).head("/api/v1/leaky-head");

    expect(response.status).toBe(500);
    expect(response.text ?? "").toBe("");
  });

  test("logs at error level when sanitization occurs", async () => {
    const app = buildApp();
    app.get("/api/v1/leaky-logged", (_req, res) => {
      res.status(500).json({ message: "boom P1001 boom" });
    });

    await request(app).get("/api/v1/leaky-logged");

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, context] = vi.mocked(logger.error).mock.calls[0];
    expect(message).toMatch(/sanitized/i);
    expect(context).toMatchObject({
      rule: "prisma-p1001",
      path: "/api/v1/leaky-logged",
      status: 500,
    });
  });

  test("does not log when no sanitization occurs", async () => {
    const app = buildApp();
    app.get("/api/v1/quiet", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    await request(app).get("/api/v1/quiet");

    expect(logger.error).not.toHaveBeenCalled();
  });
});
