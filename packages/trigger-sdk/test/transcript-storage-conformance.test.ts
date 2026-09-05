import { runTranscriptStorageTests } from "../src/v3/test/index.js";

import type { TranscriptSnapshotV2 } from "@trigger.dev/core/v3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  __setReadChatSnapshotImplForTests,
  __setWriteChatSnapshotImplForTests,
} from "../src/v3/chatSnapshotIo.js";
import { memoryTranscriptStorage, snapshotTranscriptStorage } from "../src/v3/transcriptStorage.js";

describe("memoryTranscriptStorage", () => {
  runTranscriptStorageTests(() => memoryTranscriptStorage(), { api: { describe, it, expect } });
});

describe("snapshotTranscriptStorage over an in-memory object store", () => {
  const blobs = new Map<string, TranscriptSnapshotV2>();

  beforeAll(() => {
    __setReadChatSnapshotImplForTests((sessionId) => blobs.get(sessionId));
    __setWriteChatSnapshotImplForTests((sessionId, snapshot) => {
      blobs.set(sessionId, snapshot as TranscriptSnapshotV2);
    });
  });

  afterAll(() => {
    __setReadChatSnapshotImplForTests(undefined);
    __setWriteChatSnapshotImplForTests(undefined);
  });

  runTranscriptStorageTests(() => snapshotTranscriptStorage(), {
    api: { describe, it, expect },
    chatId: "snapshot-conformance",
  });
});
