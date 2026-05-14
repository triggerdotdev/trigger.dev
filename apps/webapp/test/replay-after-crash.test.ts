// Plan F.3: integration test for the crash-recovery boot path. The
// scenario it locks down:
//
//   1. Run A streams chunks to `session.out` and `onTurnComplete` fires.
//   2. Run A crashes BEFORE `writeChatSnapshot` lands the post-turn
//      blob (or the write fails silently — both have the same effect).
//   3. Run B boots: `readChatSnapshot` returns `undefined` (no snapshot
//      yet, or stale-from-prior-turn). Replay then drains
//      `session.out` from the snapshot's `lastOutEventId` (or seq 0)
//      and reduces the chunks back into UIMessage[].
//   4. The accumulator is consistent — Run A's completed chunks reach
//      Run B's run loop without losing data.
//
// Plan section H.1 / H.4 spell out the "snapshot didn't make it before
// crash" path; this test is the integration safety net behind the
// unit tests in `packages/trigger-sdk/test/replay-session-out.test.ts`.
//
// We exercise the SDK's `__replaySessionOutTailProductionPathForTests`
// against a stubbed `apiClient.readSessionStreamRecords` — the new
// non-SSE records endpoint introduced in plan task #22. The replay path
// is a single GET that returns whatever's already on the stream; no
// long-poll. MinIO is provisioned to keep parity with
// `chat-snapshot-integration.test.ts` (the snapshot read path runs
// through it), even though the replay path itself doesn't read from S3.

import { postgresAndMinioTest } from "@internal/testcontainers";
import { apiClientManager } from "@trigger.dev/core/v3";
import {
  __readChatSnapshotProductionPathForTests as readChatSnapshot,
  __replaySessionOutTailProductionPathForTests as replaySessionOutTail,
  type ChatSnapshotV1,
} from "@trigger.dev/sdk/ai";
import type { UIMessageChunk } from "ai";
import { afterEach, describe, expect, vi } from "vitest";
import { env } from "~/env.server";
import { generatePresignedUrl } from "~/v3/objectStore.server";

vi.setConfig({ testTimeout: 60_000 });

// ── Helpers ────────────────────────────────────────────────────────────

function textTurn(id: string, text: string): UIMessageChunk[] {
  return [
    { type: "start", messageId: id, messageMetadata: { role: "assistant" } } as UIMessageChunk,
    { type: "text-start", id: `${id}.t1` } as UIMessageChunk,
    { type: "text-delta", id: `${id}.t1`, delta: text } as UIMessageChunk,
    { type: "text-end", id: `${id}.t1` } as UIMessageChunk,
    { type: "finish" } as UIMessageChunk,
  ];
}

/**
 * Stub `apiClientManager.clientOrThrow()` so:
 *   - `getPayloadUrl` / `createUploadPayloadUrl` mint MinIO presigned URLs
 *     via the webapp's real `generatePresignedUrl` (so snapshot reads
 *     hit a real S3-compatible backend).
 *   - `readSessionStreamRecords` returns the canonical
 *     `{ records: [{ data, id, seqNum }] }` shape — `data` is the
 *     JSON-encoded chunk body, mirroring the webapp's S2 record shape.
 */
function stubApiClient(opts: {
  projectRef: string;
  envSlug: string;
  sessionOutChunks: unknown[];
}) {
  const records = opts.sessionOutChunks.map((chunk, i) => ({
    data: typeof chunk === "string" ? chunk : JSON.stringify(chunk),
    id: `evt-${i + 1}`,
    seqNum: i + 1,
  }));
  const readRecordsSpy = vi.fn(
    async (_id: string, _io: "in" | "out", _options?: { afterEventId?: string }) => ({
      records,
    })
  );
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
    readSessionStreamRecords: readRecordsSpy,
  } as never);
  return readRecordsSpy;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

afterEach(() => {
  vi.restoreAllMocks();
  warnSpy?.mockRestore();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("replay after crash (MinIO + SDK helpers)", () => {
  postgresAndMinioTest(
    "boot reconstructs accumulator from session.out replay when no snapshot exists",
    async ({ minioConfig }) => {
      env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
      env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      env.OBJECT_STORE_REGION = minioConfig.region;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // The crashed run's session.out: two completed assistant turns, no
      // snapshot ever written. Boot must recover both via replay.
      const chunks = [...textTurn("a-1", "first turn"), ...textTurn("a-2", "second turn")];
      stubApiClient({
        projectRef: "proj_replay_crash",
        envSlug: "dev",
        sessionOutChunks: chunks,
      });

      // Step 1: read snapshot — returns undefined (fresh boot, no snap).
      const snapshot = await readChatSnapshot("sess_no_snap");
      expect(snapshot).toBeUndefined();

      // Step 2: replay tail.
      const replayed = await replaySessionOutTail("sess_no_snap");

      expect(replayed).toHaveLength(2);
      expect(replayed.map((m) => m.id)).toEqual(["a-1", "a-2"]);
      const texts = replayed.flatMap((m) =>
        (m.parts as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text")
          .map((p) => p.text)
      );
      expect(texts).toEqual(["first turn", "second turn"]);
    }
  );

  postgresAndMinioTest(
    "boot replays only chunks AFTER snapshot.lastOutEventId (resume cursor)",
    async ({ minioConfig }) => {
      env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
      env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      env.OBJECT_STORE_REGION = minioConfig.region;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

      // The replay helper accepts the snapshot's `lastEventId` cursor
      // and forwards it as `afterEventId` on the records endpoint —
      // that's the cursor field name on the new non-SSE route. Here we
      // feed only the post-snapshot chunks (modeling what the server
      // returns for `afterEventId=evt-snapped`) and verify the helper
      // threads the cursor through.
      const readRecordsSpy = stubApiClient({
        projectRef: "proj_replay_resume",
        envSlug: "dev",
        sessionOutChunks: textTurn("a-after-snap", "post-snapshot turn"),
      });

      const result = await replaySessionOutTail("sess_resume", { lastEventId: "evt-snapped" });

      expect(readRecordsSpy).toHaveBeenCalledWith(
        "sess_resume",
        "out",
        expect.objectContaining({ afterEventId: "evt-snapped" })
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("a-after-snap");
    }
  );

  postgresAndMinioTest(
    "boot returns [] when session.out is empty (first-ever turn, no snapshot)",
    async ({ minioConfig }) => {
      env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
      env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      env.OBJECT_STORE_REGION = minioConfig.region;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      stubApiClient({
        projectRef: "proj_replay_empty",
        envSlug: "dev",
        sessionOutChunks: [],
      });

      const snapshot = await readChatSnapshot("sess_empty");
      expect(snapshot).toBeUndefined();

      const replayed = await replaySessionOutTail("sess_empty");
      expect(replayed).toEqual([]);
    }
  );

  postgresAndMinioTest(
    "boot drops orphaned trailing tool parts (cleanupAbortedParts) — partial crash",
    async ({ minioConfig }) => {
      // Simulates a true mid-turn crash: assistant finished one turn,
      // then started a tool-call but the run died before resolution.
      // Replay must surface the completed turn but NOT include the
      // orphaned tool part in `input-streaming` state.
      env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
      env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      env.OBJECT_STORE_REGION = minioConfig.region;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

      stubApiClient({
        projectRef: "proj_replay_partial",
        envSlug: "dev",
        sessionOutChunks: [
          ...textTurn("a-complete", "I finished step 1"),
          // Partial tool turn — no tool-input-end, no finish.
          { type: "start", messageId: "a-orphan", messageMetadata: { role: "assistant" } } as UIMessageChunk,
          { type: "tool-input-start", id: "tc-cut", toolName: "search" } as UIMessageChunk,
          { type: "tool-input-delta", id: "tc-cut", delta: '{"q":"x"}' } as UIMessageChunk,
        ],
      });

      const replayed = await replaySessionOutTail("sess_partial_crash");

      // Completed turn always present.
      expect(replayed.find((m) => m.id === "a-complete")).toBeTruthy();
      // Orphaned tool-call never surfaces in `input-streaming` state.
      const orphan = replayed.find((m) => m.id === "a-orphan");
      if (orphan) {
        const stillStreaming = (orphan.parts as Array<{ toolCallId?: string; state?: string }>).find(
          (p) => p.toolCallId === "tc-cut" && p.state === "input-streaming"
        );
        expect(stillStreaming).toBeUndefined();
      }
    }
  );

  postgresAndMinioTest(
    "snapshot+replay merge: snapshot supplies user msgs, replay supplies assistants",
    async ({ minioConfig }) => {
      // The boot orchestration calls
      // `mergeByIdReplaceWins(snapshot.messages, replayed)`. The runtime
      // contract is that user messages live in snapshot only (session.in
      // never goes through replay) and assistants come from replay
      // (which carries the freshest representation). Here we simulate
      // the realistic split: snapshot has [u-1, a-1-stale], replay has
      // [a-1-fresh, a-2-new]. After merge the accumulator should reflect
      // the fresh assistant + new assistant, with the user message
      // preserved.
      //
      // Note: this is a pre-merge round-trip — we drive the read and
      // replay through real MinIO + stubbed S2 to confirm both arrive
      // intact for the orchestration to merge.
      env.OBJECT_STORE_BASE_URL = minioConfig.baseUrl;
      env.OBJECT_STORE_ACCESS_KEY_ID = minioConfig.accessKeyId;
      env.OBJECT_STORE_SECRET_ACCESS_KEY = minioConfig.secretAccessKey;
      env.OBJECT_STORE_REGION = minioConfig.region;
      env.OBJECT_STORE_DEFAULT_PROTOCOL = undefined;

      // Pre-write a snapshot to MinIO via real apiClient stub.
      const sessionId = "sess_merge_round_trip";
      const snapshot: ChatSnapshotV1 = {
        version: 1,
        savedAt: 1_700_000_000_000,
        messages: [
          { id: "u-1", role: "user", parts: [{ type: "text", text: "hi" }] },
          { id: "a-1", role: "assistant", parts: [{ type: "text", text: "stale-assistant" }] },
        ],
        lastOutEventId: "evt-prev",
        lastOutTimestamp: 1_700_000_000_500,
      };

      // Use the SDK's own writer to lay the snapshot down, then swap
      // the stub to also serve replay chunks for the read path.
      stubApiClient({
        projectRef: "proj_merge",
        envSlug: "dev",
        sessionOutChunks: [],
      });
      const { __writeChatSnapshotProductionPathForTests: writeSnapshot } = await import(
        "@trigger.dev/sdk/ai"
      );
      await writeSnapshot(sessionId, snapshot);

      // Restubbing for the boot phase: replay tail carries the fresh
      // assistant for `a-1` plus a brand-new `a-2`. The orchestration's
      // merge would replace `a-1` and append `a-2` after `u-1`.
      vi.restoreAllMocks();
      stubApiClient({
        projectRef: "proj_merge",
        envSlug: "dev",
        sessionOutChunks: [
          ...textTurn("a-1", "fresh-assistant"),
          ...textTurn("a-2", "next-assistant"),
        ],
      });

      const readBack = await readChatSnapshot(sessionId);
      expect(readBack?.messages.map((m) => m.id)).toEqual(["u-1", "a-1"]);

      const replayed = await replaySessionOutTail(sessionId, {
        lastEventId: readBack?.lastOutEventId,
      });
      expect(replayed.map((m) => m.id)).toEqual(["a-1", "a-2"]);
      // Replay's `a-1` carries the fresh content — when merge runs in
      // the runtime, this version would replace the snapshot's stale
      // `a-1`.
      const replayedA1Text = (replayed[0]!.parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(replayedA1Text).toBe("fresh-assistant");
    }
  );
});
