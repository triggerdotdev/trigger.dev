import {
  apiClientManager,
  logger,
  parseTranscriptSnapshot,
  type TranscriptSnapshotV2,
} from "@trigger.dev/core/v3";
import type { UIMessage } from "ai";

/**
 * Test-only override hook. `mockChatAgent` installs a fake to return
 * synthetic snapshots without hitting S3. The fake may return a blob of any
 * known version; it is parsed the same way a fetched body is.
 * @internal
 */
export type ReadChatSnapshotImpl = (sessionId: string) => Promise<unknown> | unknown;
let readChatSnapshotImpl: ReadChatSnapshotImpl | undefined;

export function __setReadChatSnapshotImplForTests(impl: ReadChatSnapshotImpl | undefined): void {
  readChatSnapshotImpl = impl;
}

/**
 * Test-only override hook. The mock harness records writes for assertion
 * via this setter.
 * @internal
 */
export type WriteChatSnapshotImpl = <TUIMessage extends UIMessage>(
  sessionId: string,
  snapshot: TranscriptSnapshotV2<TUIMessage>
) => Promise<void> | void;
let writeChatSnapshotImpl: WriteChatSnapshotImpl | undefined;

export function __setWriteChatSnapshotImplForTests(impl: WriteChatSnapshotImpl | undefined): void {
  writeChatSnapshotImpl = impl;
}

/**
 * Read the persisted snapshot for a session, in the version 2 shape
 * whatever version was stored. Returns `undefined` on:
 *   - missing object (404 from the presigned GET: fresh session, never persisted)
 *   - presign failure (network/auth issue)
 *   - malformed JSON
 *   - a version this runtime does not know
 *
 * Always swallows errors via `logger.warn`. The agent boot loop must stay
 * available even if S3 hiccups; the worst case is replaying more of
 * `session.out` than strictly necessary.
 * @internal
 */
export async function readChatSnapshot<TUIMessage extends UIMessage>(
  sessionId: string
): Promise<TranscriptSnapshotV2<TUIMessage> | undefined> {
  if (readChatSnapshotImpl) {
    const seeded = await readChatSnapshotImpl(sessionId);
    return seeded === undefined || seeded === null
      ? undefined
      : parseTranscriptSnapshot<TUIMessage>(seeded);
  }
  const apiClient = apiClientManager.clientOrThrow();
  let presignedUrl: string;
  try {
    const resp = await apiClient.getChatSnapshotUrl(sessionId);
    presignedUrl = resp.presignedUrl;
  } catch (error) {
    logger.warn("chat.agent: snapshot presign (read) failed; continuing without snapshot", {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
    return undefined;
  }
  let response: Response;
  try {
    response = await fetch(presignedUrl, { method: "GET" });
  } catch (error) {
    logger.warn("chat.agent: snapshot fetch failed; continuing without snapshot", {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
    return undefined;
  }
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    logger.warn("chat.agent: snapshot fetch returned non-OK; continuing without snapshot", {
      status: response.status,
      sessionId,
    });
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    logger.warn("chat.agent: snapshot JSON parse failed; continuing without snapshot", {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
    return undefined;
  }
  const snapshot = parseTranscriptSnapshot<TUIMessage>(parsed);
  if (!snapshot) {
    logger.warn("chat.agent: snapshot version/shape mismatch; ignoring", {
      version: (parsed as { version?: unknown } | null)?.version,
      sessionId,
    });
    return undefined;
  }
  return snapshot;
}

/**
 * Persist the snapshot for a session. Awaited by callers immediately after
 * `onTurnComplete`: the agent may suspend right after this point, and
 * fire-and-forget promises don't reliably complete on suspend.
 *
 * Errors are swallowed via `logger.warn`. A failed write means the next
 * boot replays slightly more of `session.out` (back to the previous
 * snapshot's cursor) instead of failing.
 * @internal
 */
export async function writeChatSnapshot<TUIMessage extends UIMessage>(
  sessionId: string,
  snapshot: TranscriptSnapshotV2<TUIMessage>
): Promise<void> {
  if (writeChatSnapshotImpl) {
    await writeChatSnapshotImpl<TUIMessage>(sessionId, snapshot);
    return;
  }
  const apiClient = apiClientManager.clientOrThrow();
  let presignedUrl: string;
  try {
    const resp = await apiClient.createChatSnapshotUploadUrl(sessionId);
    presignedUrl = resp.presignedUrl;
  } catch (error) {
    logger.warn("chat.agent: snapshot presign (write) failed; next run will replay further", {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
    return;
  }
  let response: Response;
  try {
    response = await fetch(presignedUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
  } catch (error) {
    logger.warn("chat.agent: snapshot upload failed; next run will replay further", {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
    return;
  }
  if (!response.ok) {
    logger.warn("chat.agent: snapshot upload returned non-OK; next run will replay further", {
      status: response.status,
      sessionId,
    });
  }
}

/**
 * Test-only entry point that bypasses `__setReadChatSnapshotImplForTests`
 * and reaches the real presign + `fetch` + parse path, so tests can drive
 * the production code by mocking global `fetch` and the api client.
 * @internal
 */
export async function __readChatSnapshotProductionPathForTests<TUIMessage extends UIMessage>(
  sessionId: string
): Promise<TranscriptSnapshotV2<TUIMessage> | undefined> {
  const saved = readChatSnapshotImpl;
  readChatSnapshotImpl = undefined;
  try {
    return await readChatSnapshot<TUIMessage>(sessionId);
  } finally {
    readChatSnapshotImpl = saved;
  }
}

/**
 * Test-only entry point that bypasses `__setWriteChatSnapshotImplForTests`
 * and reaches the real presign + `fetch` PUT path.
 * @internal
 */
export async function __writeChatSnapshotProductionPathForTests<TUIMessage extends UIMessage>(
  sessionId: string,
  snapshot: TranscriptSnapshotV2<TUIMessage>
): Promise<void> {
  const saved = writeChatSnapshotImpl;
  writeChatSnapshotImpl = undefined;
  try {
    await writeChatSnapshot<TUIMessage>(sessionId, snapshot);
  } finally {
    writeChatSnapshotImpl = saved;
  }
}
