import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiClientManager } from "./apiClientManager-api.js";
import {
  createIdempotencyKey,
  getIdempotencyKeyOptions,
  makeIdempotencyKey,
  resetIdempotencyKey,
  resetIdempotencyKeyCatalog,
} from "./idempotencyKeys.js";
import { digestSHA256 } from "./utils/crypto.js";

describe("idempotencyKeys metadata retention", () => {
  it("retains key/scope options for every key created in a run, even beyond 1000", async () => {
    const count = 3000;
    const keys: string[] = [];

    for (let i = 0; i < count; i++) {
      const key = await createIdempotencyKey(`item-${i}`, { scope: "global" });
      keys.push(key);
    }

    // The very first key created should still resolve its original options.
    // With a fixed-size LRU catalog (cap 1000), the earliest ~2000 keys are
    // silently evicted and this returns undefined.
    const firstOptions = getIdempotencyKeyOptions(keys[0]!);
    expect(firstOptions).toEqual({ key: "item-0", scope: "global" });

    // Every key should resolve to its own original options.
    for (let i = 0; i < count; i++) {
      const options = getIdempotencyKeyOptions(keys[i]!);
      expect(options, `options missing for key index ${i}`).toEqual({
        key: `item-${i}`,
        scope: "global",
      });
    }
  });

  it("forgets options after the catalog is reset at a run boundary", async () => {
    const key = await createIdempotencyKey("boundary-key", { scope: "global" });
    expect(getIdempotencyKeyOptions(key)).toEqual({ key: "boundary-key", scope: "global" });

    resetIdempotencyKeyCatalog();

    expect(getIdempotencyKeyOptions(key)).toBeUndefined();
  });
});

describe("resetIdempotencyKey", () => {
  const digestShapedKey = "a".repeat(64);

  let server: Server;
  let resetKeys: string[] = [];
  /** Keys the server has runs for. `undefined` means "accept every key". */
  let existingKeys: Set<string> | undefined;
  /** Per-key failure statuses, applied before the existence check. */
  let statusByKey: Map<string, number>;

  function notFoundMessage(key: string) {
    return `No runs found with idempotency key: ${key}`;
  }

  async function resetAndCaptureKey(
    ...args: Parameters<typeof resetIdempotencyKey>
  ): Promise<string> {
    resetKeys = [];
    await resetIdempotencyKey(...args);
    expect(resetKeys).toHaveLength(1);
    return resetKeys[0]!;
  }

  beforeEach(async () => {
    resetIdempotencyKeyCatalog();
    resetKeys = [];
    existingKeys = undefined;
    statusByKey = new Map();

    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const match = /^\/api\/v1\/idempotencyKeys\/(.+)\/reset$/.exec(req.url ?? "");
        if (!match) {
          res.writeHead(404).end();
          return;
        }

        const key = decodeURIComponent(match[1]!);
        resetKeys.push(key);

        const failWith = statusByKey.get(key);
        if (failWith !== undefined) {
          res.writeHead(failWith, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `request failed for ${key}` }));
          return;
        }

        if (existingKeys !== undefined && !existingKeys.has(key)) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: notFoundMessage(key) }));
          return;
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "run_reset" }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    apiClientManager.setGlobalAPIClientConfiguration({
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      accessToken: "tr_test_key",
    });
  });

  afterEach(async () => {
    apiClientManager.disable();
    resetIdempotencyKeyCatalog();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("derives the hash for 64-character key material with an explicit scope when the verbatim key misses", async () => {
    const created = await createIdempotencyKey(digestShapedKey, { scope: "global" });

    resetIdempotencyKeyCatalog();
    existingKeys = new Set([created]);

    await resetIdempotencyKey("my-task", digestShapedKey, { scope: "global" });

    expect(resetKeys).toEqual([digestShapedKey, created]);
  });

  it("derives the run-scoped hash for 64-character key material when the verbatim key misses", async () => {
    const parentRunId = "run_abc123";
    const expected = await digestSHA256(`${digestShapedKey}-${parentRunId}`);
    existingKeys = new Set([expected]);

    await resetIdempotencyKey("my-task", digestShapedKey, { scope: "run", parentRunId });

    expect(resetKeys).toEqual([digestShapedKey, expected]);
  });

  it("sends a key created with idempotencyKeys.create() unchanged while the catalog knows it", async () => {
    const created = await createIdempotencyKey("my-key", { scope: "global" });
    existingKeys = new Set([created]);

    expect(await resetAndCaptureKey("my-task", created)).toBe(created);
    expect(await resetAndCaptureKey("my-task", created, { scope: "global" })).toBe(created);
  });

  it("sends a created key unchanged when no scope is passed and the catalog is cold", async () => {
    const created = await createIdempotencyKey("my-key", { scope: "global" });

    // The reset can happen in a different process from the create
    resetIdempotencyKeyCatalog();
    existingKeys = new Set([created]);

    expect(await resetAndCaptureKey("my-task", created)).toBe(created);
  });

  it("resolves a created key in one request when reset with a scope and the catalog is cold", async () => {
    const created = await createIdempotencyKey("my-key", { scope: "global" });

    resetIdempotencyKeyCatalog();
    existingKeys = new Set([created]);

    expect(await resetAndCaptureKey("my-task", created, { scope: "global" })).toBe(created);
  });

  it("sends a 64-character key unchanged when no scope is passed", async () => {
    expect(await resetAndCaptureKey("my-task", digestShapedKey)).toBe(digestShapedKey);
  });

  it("resets 64-character material that trigger stored verbatim when no scope is passed", async () => {
    // trigger() forwards 64-character material as-is, so that is what the server stored
    expect(await makeIdempotencyKey(digestShapedKey)).toBe(digestShapedKey);
    existingKeys = new Set([digestShapedKey]);

    expect(await resetAndCaptureKey("my-task", digestShapedKey)).toBe(digestShapedKey);
  });

  it("resets the verbatim run when runs exist under both the verbatim key and the derived hash", async () => {
    const created = await createIdempotencyKey(digestShapedKey, { scope: "global" });

    resetIdempotencyKeyCatalog();
    existingKeys = new Set([digestShapedKey, created]);

    await resetIdempotencyKey("my-task", digestShapedKey, { scope: "global" });

    expect(resetKeys).toEqual([digestShapedKey]);
  });

  it("falls back to the derived hash when the verbatim attempt fails with a 503", async () => {
    const created = await createIdempotencyKey(digestShapedKey, { scope: "global" });

    resetIdempotencyKeyCatalog();
    statusByKey.set(digestShapedKey, 503);
    existingKeys = new Set([created]);

    await resetIdempotencyKey(
      "my-task",
      digestShapedKey,
      { scope: "global" },
      { retry: { maxAttempts: 1 } }
    );

    expect(resetKeys).toEqual([digestShapedKey, created]);
  });

  it("surfaces the verbatim attempt's error when it fails with a 503 and the fallback finds nothing", async () => {
    const derived = await digestSHA256(digestShapedKey);
    statusByKey.set(digestShapedKey, 503);
    existingKeys = new Set();

    await expect(
      resetIdempotencyKey(
        "my-task",
        digestShapedKey,
        { scope: "global" },
        { retry: { maxAttempts: 1 } }
      )
    ).rejects.toMatchObject({ status: 503 });

    expect(resetKeys).toEqual([digestShapedKey, derived]);
  });

  it("surfaces the fallback's error when it fails with something other than a 404", async () => {
    const derived = await digestSHA256(digestShapedKey);
    statusByKey.set(digestShapedKey, 404);
    statusByKey.set(derived, 503);

    await expect(
      resetIdempotencyKey(
        "my-task",
        digestShapedKey,
        { scope: "global" },
        { retry: { maxAttempts: 1 } }
      )
    ).rejects.toMatchObject({ status: 503 });

    expect(resetKeys).toEqual([digestShapedKey, derived]);
  });

  it("surfaces the verbatim key's error when both attempts 404", async () => {
    const derived = await digestSHA256(digestShapedKey);
    existingKeys = new Set();

    await expect(
      resetIdempotencyKey("my-task", digestShapedKey, { scope: "global" })
    ).rejects.toThrow(notFoundMessage(digestShapedKey));

    expect(resetKeys).toEqual([digestShapedKey, derived]);
  });

  it("hashes key material that is not 64 characters", async () => {
    const created = await createIdempotencyKey("my-key", { scope: "global" });
    resetIdempotencyKeyCatalog();

    expect(await resetAndCaptureKey("my-task", "my-key", { scope: "global" })).toBe(created);
  });

  it("sends a 64-character key verbatim when run scope cannot be derived", async () => {
    const created = await createIdempotencyKey("my-key", { scope: "run" });

    resetIdempotencyKeyCatalog();
    existingKeys = new Set([created]);

    // No parentRunId and no task context, so the hash is underivable
    expect(await resetAndCaptureKey("my-task", created, { scope: "run" })).toBe(created);
  });

  it("sends a 64-character key verbatim when attempt scope cannot be derived", async () => {
    existingKeys = new Set([digestShapedKey]);

    expect(await resetAndCaptureKey("my-task", digestShapedKey, { scope: "attempt" })).toBe(
      digestShapedKey
    );
  });

  it("still throws for non-64-character material when run scope cannot be derived", async () => {
    await expect(resetIdempotencyKey("my-task", "my-key", { scope: "run" })).rejects.toThrow(
      "parentRunId is required for 'run' scope"
    );

    expect(resetKeys).toEqual([]);
  });

  it("still throws for non-64-character material when attempt scope cannot be derived", async () => {
    await expect(
      resetIdempotencyKey("my-task", "my-key", { scope: "attempt", parentRunId: "run_abc123" })
    ).rejects.toThrow("parentRunId and attemptNumber are required for 'attempt' scope");

    expect(resetKeys).toEqual([]);
  });
});
