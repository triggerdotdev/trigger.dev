import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiClientManager } from "./apiClientManager-api.js";
import {
  createIdempotencyKey,
  getIdempotencyKeyOptions,
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
  // A user key that is itself a 64-character digest, which is indistinguishable by
  // length from a key returned by `idempotencyKeys.create()`.
  const digestShapedKey = "a".repeat(64);

  let server: Server;
  let resetKeys: string[] = [];

  /** The value `resetIdempotencyKey` put on the wire. */
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

    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const match = /^\/api\/v1\/idempotencyKeys\/(.+)\/reset$/.exec(req.url ?? "");
        if (!match) {
          res.writeHead(404).end();
          return;
        }

        resetKeys.push(decodeURIComponent(match[1]!));
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

  it("hashes 64-character key material when an explicit scope is passed", async () => {
    const created = await createIdempotencyKey(digestShapedKey, { scope: "global" });

    // The reset happens in a different process from the trigger (e.g. from a
    // lifecycle hook), so the catalog no longer knows the key.
    resetIdempotencyKeyCatalog();

    expect(await resetAndCaptureKey("my-task", digestShapedKey, { scope: "global" })).toBe(created);
  });

  it("hashes 64-character key material for run scope when an explicit scope is passed", async () => {
    const parentRunId = "run_abc123";
    const expected = await digestSHA256(`${digestShapedKey}-${parentRunId}`);

    expect(
      await resetAndCaptureKey("my-task", digestShapedKey, { scope: "run", parentRunId })
    ).toBe(expected);
  });

  it("sends a key created with idempotencyKeys.create() unchanged", async () => {
    const created = await createIdempotencyKey("my-key", { scope: "global" });

    expect(await resetAndCaptureKey("my-task", created)).toBe(created);
    // An explicit scope must not hash an already-created key a second time.
    expect(await resetAndCaptureKey("my-task", created, { scope: "global" })).toBe(created);
  });

  it("sends a 64-character key unchanged when no scope is passed", async () => {
    // Passing 64-character material straight to `trigger()` stores it un-hashed, so
    // resetting it without a scope must keep sending it verbatim.
    expect(await resetAndCaptureKey("my-task", digestShapedKey)).toBe(digestShapedKey);
  });

  it("hashes key material that is not 64 characters", async () => {
    const created = await createIdempotencyKey("my-key", { scope: "global" });
    resetIdempotencyKeyCatalog();

    expect(await resetAndCaptureKey("my-task", "my-key", { scope: "global" })).toBe(created);
  });
});
