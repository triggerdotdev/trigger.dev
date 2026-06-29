import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { zodfetch } from "./core.js";

vi.setConfig({ testTimeout: 5_000 });

const schema = z.object({ ok: z.boolean() });

describe("zodfetch request timeout", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.TRIGGER_API_REQUEST_TIMEOUT_MS;
  });

  // Never settles unless the request is aborted (models a half-open keep-alive socket).
  function neverResponds(init?: RequestInit): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal!.reason ?? new DOMException("aborted", "AbortError"))
      );
    });
  }

  it("aborts a hung request after the timeout instead of hanging forever", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) => neverResponds(init));

    const start = Date.now();
    await expect(
      zodfetch(
        schema,
        "http://localhost/x",
        { method: "POST" },
        {
          timeoutInMs: 150,
          retry: { maxAttempts: 1 },
        }
      )
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("retries on a fresh connection after a timeout and recovers", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      calls++;
      // First connection hangs; the retry's fresh connection responds.
      if (calls === 1) {
        return neverResponds(init);
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    });

    const result = await zodfetch(
      schema,
      "http://localhost/x",
      { method: "POST" },
      {
        timeoutInMs: 150,
        retry: {
          maxAttempts: 3,
          minTimeoutInMs: 10,
          maxTimeoutInMs: 50,
          factor: 1,
          randomize: false,
        },
      }
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("reuses the same request idempotency key across a timeout retry so the server can dedupe", async () => {
    const keys: Array<string | null> = [];
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      calls++;
      keys.push(new Headers(init?.headers).get("x-trigger-request-idempotency-key"));
      if (calls === 1) {
        return neverResponds(init);
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    });

    await zodfetch(
      schema,
      "http://localhost/x",
      { method: "POST" },
      {
        timeoutInMs: 150,
        retry: {
          maxAttempts: 3,
          minTimeoutInMs: 10,
          maxTimeoutInMs: 50,
          factor: 1,
          randomize: false,
        },
      }
    );

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
  });

  it("does not time out when timeoutInMs is 0 (for long-lived requests)", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ ok: true }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                })
              ),
            300
          )
        )
    );

    const result = await zodfetch(
      schema,
      "http://localhost/x",
      { method: "POST" },
      {
        timeoutInMs: 0,
        retry: { maxAttempts: 1 },
      }
    );

    expect(result).toEqual({ ok: true });
  });

  it("treats an out-of-range timeout as disabled instead of aborting instantly", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ ok: true }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                })
              ),
            300
          )
        )
    );

    const result = await zodfetch(
      schema,
      "http://localhost/x",
      { method: "POST" },
      {
        timeoutInMs: 5_000_000_000,
        retry: { maxAttempts: 1 },
      }
    );

    expect(result).toEqual({ ok: true });
  });

  it("uses TRIGGER_API_REQUEST_TIMEOUT_MS as the default when no timeout is passed", async () => {
    process.env.TRIGGER_API_REQUEST_TIMEOUT_MS = "120";
    globalThis.fetch = vi
      .fn()
      .mockImplementation((_url: string, init?: RequestInit) => neverResponds(init));

    const start = Date.now();
    await expect(
      zodfetch(schema, "http://localhost/x", { method: "POST" }, { retry: { maxAttempts: 1 } })
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});
