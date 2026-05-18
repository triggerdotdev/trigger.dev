// Plan F.3: integration test that round-trips a `ChatSnapshotV1` blob
// through the SDK's snapshot helpers + a real MinIO backing store. Mirrors
// the testcontainer pattern from `objectStore.test.ts`.
//
// What this verifies end-to-end:
//   - SDK's `writeChatSnapshot` calls `apiClient.createUploadPayloadUrl`
//     to mint a presigned PUT, then PUTs JSON to it.
//   - SDK's `readChatSnapshot` calls `apiClient.getPayloadUrl` to mint a
//     presigned GET, then fetches and parses.
//   - The webapp's `generatePresignedUrl` produces URLs MinIO accepts.
//   - The blob round-trips with `version: 1` shape preserved.
//   - 404 (no snapshot for a fresh session) returns `undefined`, not an
//     error.
//
// This is the integration safety net behind the unit tests in
// `packages/trigger-sdk/test/chat-snapshot.test.ts` — those tests mock
// `fetch`; this one drives a real S3-compatible backend.

import { postgresAndMinioTest } from "@internal/testcontainers";
import { apiClientManager } from "@trigger.dev/core/v3";
import {
  __readChatSnapshotProductionPathForTests as readChatSnapshot,
  __writeChatSnapshotProductionPathForTests as writeChatSnapshot,
  type ChatSnapshotV1,
} from "@trigger.dev/sdk/ai";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, vi } from "vitest";
import { env } from "~/env.server";
import { generatePresignedUrl } from "~/v3/objectStore.server";

vi.setConfig({ testTimeout: 60_000 });

// ── Helpers ────────────────────────────────────────────────────────────

function makeSnapshot(opts: { messages?: UIMessage[]; lastOutEventId?: string } = {}): ChatSnapshotV1 {
  return {
    version: 1,
    savedAt: 1_700_000_000_000,
    messages: opts.messages ?? [
      {
        id: "u-1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      {
        id: "a-1",
        role: "assistant",
        parts: [{ type: "text", text: "world" }],
      },
    ],
    lastOutEventId: opts.lastOutEventId ?? "evt-42",
  };
}

/**
 * Stub `apiClientManager.clientOrThrow()` so the SDK helpers see a fake
 * api client whose `getPayloadUrl` / `createUploadPayloadUrl` return
 * presigned URLs minted by the webapp's real `generatePresignedUrl`
 * (which signs against MinIO).
 *
 * The SDK helpers internally do `fetch(presignedUrl, ...)` to read/write
 * the blob, so MinIO ends up holding the actual bytes.
 */
function stubApiClient(opts: { projectRef: string; envSlug: string }) {
  vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue({
    async getPayloadUrl(filename: string) {
      const result = await generatePresignedUrl(opts.projectRef, opts.envSlug, filename, "GET");
      if (!result.success) throw new Error(result.error);
      return { presignedUrl: result.url };
    },
    async createUploadPayloadUrl(filename: string) {
      const result = await generatePresignedUrl(opts.projectRef, opts.envSlug, filename, "PUT");
      if (!result.success) throw new Error(result.error);
      return { presignedUrl: result.url };
    },
  } as never);
}

// Suppress noisy warnings from logger.warn during error-path tests.
let warnSpy: ReturnType<typeof vi.spyOn>;

afterEach(() => {
  vi.restoreAllMocks();
  warnSpy?.mockRestore();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("chat snapshot integration (MinIO + SDK helpers)", () => {
  postgresAndMinioTest("round-trips a snapshot through real MinIO", async ({ minioConfig }) => {
    env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
    env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
    env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
    env.OBJECT_STORE_REGION = minioConfig.region;
    env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

    stubApiClient({ projectRef: "proj_snap_rt", envSlug: "dev" });

    const sessionId = "sess_round_trip_1";
    const snapshot = makeSnapshot();

    // Write through the SDK helper — should land in MinIO at
    // `packets/proj_snap_rt/dev/sessions/sess_round_trip_1/snapshot.json`.
    await writeChatSnapshot(sessionId, snapshot);

    // Read back through the SDK helper — should reconstruct the original.
    const result = await readChatSnapshot(sessionId);

    expect(result).toEqual(snapshot);
  });

  postgresAndMinioTest("returns undefined for a fresh session with no snapshot", async ({ minioConfig }) => {
    env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
    env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
    env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
    env.OBJECT_STORE_REGION = minioConfig.region;
    env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

    stubApiClient({ projectRef: "proj_snap_404", envSlug: "dev" });

    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Session never had a snapshot written — read returns undefined.
    const result = await readChatSnapshot("sess_never_existed");
    expect(result).toBeUndefined();
  });

  postgresAndMinioTest("overwrites a prior snapshot in place (single-writer)", async ({ minioConfig }) => {
    // The runtime guarantees one attempt alive at a time, and
    // `writeChatSnapshot` runs awaited after `onTurnComplete`. Verify
    // that a second write to the same key replaces the first cleanly —
    // the read-after-write reflects the latest blob.
    env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
    env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
    env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
    env.OBJECT_STORE_REGION = minioConfig.region;
    env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

    stubApiClient({ projectRef: "proj_snap_overwrite", envSlug: "dev" });

    const sessionId = "sess_overwrite";

    const turn1 = makeSnapshot({
      messages: [
        { id: "u-1", role: "user", parts: [{ type: "text", text: "first" }] },
      ],
      lastOutEventId: "evt-turn1",
    });
    const turn2 = makeSnapshot({
      messages: [
        { id: "u-1", role: "user", parts: [{ type: "text", text: "first" }] },
        { id: "a-1", role: "assistant", parts: [{ type: "text", text: "reply-1" }] },
        { id: "u-2", role: "user", parts: [{ type: "text", text: "second" }] },
        { id: "a-2", role: "assistant", parts: [{ type: "text", text: "reply-2" }] },
      ],
      lastOutEventId: "evt-turn2",
    });

    await writeChatSnapshot(sessionId, turn1);
    await writeChatSnapshot(sessionId, turn2);

    const result = await readChatSnapshot(sessionId);
    expect(result).toEqual(turn2);
    expect(result?.messages).toHaveLength(4);
    expect(result?.lastOutEventId).toBe("evt-turn2");
  });

  postgresAndMinioTest("isolates snapshots by sessionId (no cross-talk)", async ({ minioConfig }) => {
    env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
    env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
    env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
    env.OBJECT_STORE_REGION = minioConfig.region;
    env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

    stubApiClient({ projectRef: "proj_snap_iso", envSlug: "dev" });

    const sessA = "sess_iso_A";
    const sessB = "sess_iso_B";
    const snapA = makeSnapshot({ lastOutEventId: "evt-A" });
    const snapB = makeSnapshot({ lastOutEventId: "evt-B" });

    await writeChatSnapshot(sessA, snapA);
    await writeChatSnapshot(sessB, snapB);

    const readA = await readChatSnapshot(sessA);
    const readB = await readChatSnapshot(sessB);

    expect(readA?.lastOutEventId).toBe("evt-A");
    expect(readB?.lastOutEventId).toBe("evt-B");
    // Distinct objects — modifying one shouldn't affect the other.
    expect(readA?.lastOutEventId).not.toBe(readB?.lastOutEventId);
  });

  postgresAndMinioTest("handles snapshots with large message lists (~50 messages)", async ({ minioConfig }) => {
    // Stress test: a 50-turn chat snapshot. Plan F.4 mentions the
    // pre-change baseline grew past 512 KiB around turn 10-30 with tool
    // use; the post-slim wire keeps wire payloads small but the snapshot
    // itself can still get large. Verify the helpers handle a realistic
    // payload size.
    env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
    env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
    env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
    env.OBJECT_STORE_REGION = minioConfig.region;
    env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

    stubApiClient({ projectRef: "proj_snap_big", envSlug: "dev" });

    const messages: UIMessage[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        id: `u-${i}`,
        role: "user",
        parts: [{ type: "text", text: `user message ${i}: ${"x".repeat(200)}` }],
      });
      messages.push({
        id: `a-${i}`,
        role: "assistant",
        parts: [{ type: "text", text: `assistant reply ${i}: ${"y".repeat(500)}` }],
      });
    }
    const snapshot = makeSnapshot({ messages, lastOutEventId: "evt-50" });

    await writeChatSnapshot("sess_big_chat", snapshot);
    const result = await readChatSnapshot("sess_big_chat");

    expect(result).toBeDefined();
    expect(result!.messages).toHaveLength(100);
    expect(result!.lastOutEventId).toBe("evt-50");
    // Spot-check ordering integrity — the messages array round-tripped
    // in the same order.
    expect(result!.messages[0]!.id).toBe("u-0");
    expect(result!.messages[99]!.id).toBe("a-49");
  });
});
