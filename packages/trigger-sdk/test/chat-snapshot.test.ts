// Import the test entry point first so the resource catalog is installed —
// not strictly required for these helper-level tests, but keeps parity with
// the rest of the test suite and removes a potential foot-gun if a future
// edit introduces a chat.agent({...}) at module scope.
import "../src/v3/test/index.js";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClientManager } from "@trigger.dev/core/v3";
import {
  __readChatSnapshotProductionPathForTests as readChatSnapshot,
  __writeChatSnapshotProductionPathForTests as writeChatSnapshot,
  type ChatSnapshotV1,
} from "../src/v3/ai.js";

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Build a minimal ChatSnapshotV1 with `count` user messages. Used as the
 * production-path test payload — `messages` is the only field the runtime
 * inspects beyond `version`.
 */
function buildSnapshot(count = 1): ChatSnapshotV1 {
  return {
    version: 1,
    savedAt: 1_000_000,
    messages: Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: `hello ${i}` }],
    })),
    lastOutEventId: "evt-42",
    lastOutTimestamp: 2_000_000,
  };
}

/**
 * Stub `apiClientManager.clientOrThrow()` so the helpers see a fake API
 * client whose `getPayloadUrl` / `createUploadPayloadUrl` resolve with the
 * presigned URLs the test wants. Returns spies for assertion.
 */
function stubApiClient(opts: {
  getPayloadUrl?: () => Promise<{ presignedUrl: string }>;
  createUploadPayloadUrl?: () => Promise<{ presignedUrl: string }>;
}) {
  const getPayloadUrl = vi.fn(opts.getPayloadUrl ?? (async () => ({ presignedUrl: "https://example.invalid/get" })));
  const createUploadPayloadUrl = vi.fn(
    opts.createUploadPayloadUrl ?? (async () => ({ presignedUrl: "https://example.invalid/put" }))
  );
  const fakeClient = {
    getPayloadUrl,
    createUploadPayloadUrl,
  };
  vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue(
    fakeClient as never
  );
  return { getPayloadUrl, createUploadPayloadUrl };
}

/**
 * Stub global `fetch` so the helpers see whatever Response (or throw) the
 * test wants. Returns a spy keyed on the URL passed.
 */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("chat snapshot helpers", () => {
  // Suppress the runtime's `logger.warn` calls — they pollute output but
  // don't change test outcomes. Restored in afterEach.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  describe("readChatSnapshot", () => {
    it("returns the snapshot on a successful GET", async () => {
      const { getPayloadUrl } = stubApiClient({});
      const snapshot = buildSnapshot(2);
      stubFetch(async () =>
        new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );

      const result = await readChatSnapshot("session-1");
      expect(getPayloadUrl).toHaveBeenCalledWith("sessions/session-1/snapshot.json");
      expect(result).toMatchObject({
        version: 1,
        messages: snapshot.messages,
        lastOutEventId: "evt-42",
      });
    });

    it("returns undefined on 404 (fresh session, no snapshot yet)", async () => {
      stubApiClient({});
      stubFetch(async () => new Response("Not Found", { status: 404 }));

      const result = await readChatSnapshot("missing-session");
      expect(result).toBeUndefined();
    });

    it("returns undefined on non-404 non-OK (e.g. 500)", async () => {
      stubApiClient({});
      stubFetch(async () => new Response("Internal Error", { status: 500 }));

      const result = await readChatSnapshot("flaky-session");
      expect(result).toBeUndefined();
    });

    it("returns undefined when the response body is malformed JSON", async () => {
      stubApiClient({});
      stubFetch(async () =>
        new Response("not-json-{[", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );

      const result = await readChatSnapshot("malformed-session");
      expect(result).toBeUndefined();
    });

    it("returns undefined on version mismatch (forward-compat)", async () => {
      stubApiClient({});
      // Future format the current runtime can't decode — runtime ignores it.
      const futureSnapshot = {
        version: 99,
        savedAt: Date.now(),
        messages: [],
      };
      stubFetch(async () =>
        new Response(JSON.stringify(futureSnapshot), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );

      const result = await readChatSnapshot("v99-session");
      expect(result).toBeUndefined();
    });

    it("returns undefined when `messages` field is missing or wrong type", async () => {
      stubApiClient({});
      stubFetch(async () =>
        new Response(JSON.stringify({ version: 1, savedAt: 1, messages: "not-an-array" }), {
          status: 200,
        })
      );

      const result = await readChatSnapshot("bad-shape-session");
      expect(result).toBeUndefined();
    });

    it("returns undefined when fetch throws (network error)", async () => {
      stubApiClient({});
      stubFetch(async () => {
        throw new Error("ECONNREFUSED");
      });

      const result = await readChatSnapshot("offline-session");
      expect(result).toBeUndefined();
    });

    it("returns undefined when presign call fails", async () => {
      stubApiClient({
        getPayloadUrl: async () => {
          throw new Error("presign denied");
        },
      });
      // No fetch should fire — presign failed.
      const fetchSpy = stubFetch(async () => new Response("nope", { status: 500 }));

      const result = await readChatSnapshot("denied-session");
      expect(result).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns undefined when the response is not an object", async () => {
      stubApiClient({});
      stubFetch(async () =>
        new Response(JSON.stringify("just-a-string"), { status: 200 })
      );

      const result = await readChatSnapshot("string-response");
      expect(result).toBeUndefined();
    });
  });

  describe("writeChatSnapshot", () => {
    it("PUTs the snapshot JSON to the presigned URL", async () => {
      const { createUploadPayloadUrl } = stubApiClient({});
      const fetchSpy = stubFetch(async () => new Response(null, { status: 200 }));

      const snapshot = buildSnapshot(3);
      await writeChatSnapshot("session-2", snapshot);

      expect(createUploadPayloadUrl).toHaveBeenCalledWith("sessions/session-2/snapshot.json");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://example.invalid/put");
      expect((init as RequestInit).method).toBe("PUT");
      expect((init as RequestInit).headers).toMatchObject({
        "content-type": "application/json",
      });
      // Body is the JSON-stringified snapshot — round-trip to confirm.
      const sentBody = JSON.parse((init as RequestInit).body as string);
      expect(sentBody).toEqual(snapshot);
    });

    it("returns without throwing on a non-OK PUT response (warns)", async () => {
      stubApiClient({});
      stubFetch(async () => new Response("forbidden", { status: 403 }));

      await expect(writeChatSnapshot("forbidden-session", buildSnapshot())).resolves.toBeUndefined();
    });

    it("returns without throwing on a fetch network error (warns)", async () => {
      stubApiClient({});
      stubFetch(async () => {
        throw new Error("ETIMEDOUT");
      });

      await expect(writeChatSnapshot("timeout-session", buildSnapshot())).resolves.toBeUndefined();
    });

    it("returns without throwing when presign fails (warns)", async () => {
      stubApiClient({
        createUploadPayloadUrl: async () => {
          throw new Error("presign denied");
        },
      });
      const fetchSpy = stubFetch(async () => new Response(null, { status: 200 }));

      await expect(writeChatSnapshot("denied-session", buildSnapshot())).resolves.toBeUndefined();
      // Presign failed → no PUT attempted.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("uses the same `snapshotFilename(sessionId)` convention as the read path", async () => {
      // Round-trip check: read and write target the same key for a given
      // sessionId. The runtime relies on this to make read-after-write
      // coherent on subsequent boots.
      const { getPayloadUrl } = stubApiClient({
        getPayloadUrl: async () => ({ presignedUrl: "https://example.invalid/get" }),
      });
      stubFetch(async () => new Response(null, { status: 404 }));

      // Trigger a read.
      await readChatSnapshot("round-trip-session");
      const [readKey] = getPayloadUrl.mock.calls[0]!;

      // Trigger a write to the same session.
      const { createUploadPayloadUrl } = stubApiClient({
        createUploadPayloadUrl: async () => ({ presignedUrl: "https://example.invalid/put" }),
      });
      stubFetch(async () => new Response(null, { status: 200 }));
      await writeChatSnapshot("round-trip-session", buildSnapshot());
      const [writeKey] = createUploadPayloadUrl.mock.calls[0]!;

      expect(readKey).toBe(writeKey);
      expect(readKey).toBe("sessions/round-trip-session/snapshot.json");
    });
  });
});
