import type { UIMessage, UIMessageChunk } from "ai";
import { reduceUIMessageChunks } from "./uiMessageChunks.js";

/** Data part type that carries a sub-agent's chunks on the parent chat stream. */
export const SUB_AGENT_DATA_TYPE = "data-subagent";

/** Payload of a forwarded {@link SUB_AGENT_DATA_TYPE} chunk. */
export type SubAgentChunkBatch = {
  /** The parent tool call the sub-agent runs inside. */
  toolCallId: string;
  /** Position of this batch in the sub-agent's stream, starting at 0. */
  seq: number;
  /** The sub-agent's chunks, in stream order. */
  chunks: UIMessageChunk[];
};

/** The transient data chunk `chat.forwardSubAgent` writes to the parent chat stream. */
export type SubAgentDataChunk = {
  type: typeof SUB_AGENT_DATA_TYPE;
  data: SubAgentChunkBatch;
  transient: true;
};

/**
 * Upper bound on the serialized chunks in one batch, in UTF-16 code units. The
 * record is escaped again on the way to storage, so this keeps a batch well
 * under the 1 MiB record limit even for quote-heavy, non-ASCII payloads. A
 * single larger chunk still goes out on its own.
 */
const MAX_BATCH_CHARS = 128 * 1024;

/** @internal */
export type ForwardSubAgentChunksOptions = {
  toolCallId: string;
  flushIntervalMs: number;
  write: (chunk: SubAgentDataChunk) => void;
};

/**
 * Read a sub-agent's chunk stream, write it to the parent in batches, and
 * return the message it builds. Bytes written grow with the length of the
 * sub-agent's reply, where yielding `readUIMessageStream` snapshots grows with
 * its square.
 * @internal
 */
export async function forwardSubAgentChunks(
  source: ReadableStream<UIMessageChunk>,
  options: ForwardSubAgentChunksOptions
): Promise<UIMessage | undefined> {
  const all: UIMessageChunk[] = [];
  let batch: UIMessageChunk[] = [];
  let batchChars = 0;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (batch.length === 0) return;
    options.write({
      type: SUB_AGENT_DATA_TYPE,
      data: { toolCallId: options.toolCallId, seq: seq++, chunks: batch },
      transient: true,
    });
    batch = [];
    batchChars = 0;
  };

  const reader = source.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      all.push(value);
      const chars = JSON.stringify(value).length;
      if (batchChars > 0 && batchChars + chars > MAX_BATCH_CHARS) flush();
      batch.push(value);
      batchChars += chars;
      if (batchChars >= MAX_BATCH_CHARS || options.flushIntervalMs <= 0) {
        flush();
      } else if (timer === undefined) {
        timer = setTimeout(flush, options.flushIntervalMs);
      }
    }
  } finally {
    flush();
    reader.releaseLock();
  }

  return reduceUIMessageChunks(all);
}

/** Options for {@link createSubAgentMessages}. */
export type SubAgentMessagesOptions = {
  /**
   * Minimum time between rebuilds of a sub-agent's message while its chunks
   * stream in. Each rebuild is linear in the chunks received so far.
   * @default 100
   */
  throttleMs?: number;
  /** Called after one or more sub-agent messages change. */
  onChange?: () => void;
};

/** Live sub-agent messages rebuilt from forwarded chunks. See {@link createSubAgentMessages}. */
export type SubAgentMessages<TUIMessage extends UIMessage = UIMessage> = {
  /** Pass to `useChat({ onData })` (or call with every data part you receive). */
  onData: (part: { type: string; data?: unknown }) => void;
  /** The sub-agent's message so far for a parent tool call, or `undefined` before its first chunk. */
  get: (toolCallId: string) => TUIMessage | undefined;
  /** Stop pending rebuilds and drop every message. */
  dispose: () => void;
};

type Entry = {
  chunks: UIMessageChunk[];
  nextSeq: number;
  message: UIMessage | undefined;
  dirty: boolean;
  finished: boolean;
};

/**
 * Rebuild sub-agent messages from the chunks `chat.forwardSubAgent` writes to
 * the parent chat stream. Batches replayed after a reconnect are skipped by
 * their sequence number, so a resumed stream does not duplicate content.
 *
 * Framework-agnostic; React apps use `useSubAgentMessages` from
 * `@trigger.dev/sdk/chat/react`.
 */
export function createSubAgentMessages<TUIMessage extends UIMessage = UIMessage>(
  options: SubAgentMessagesOptions = {}
): SubAgentMessages<TUIMessage> {
  const throttleMs = options.throttleMs ?? 100;
  const entries = new Map<string, Entry>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rebuilding = false;
  let disposed = false;

  const schedule = () => {
    if (timer !== undefined || rebuilding || disposed) return;
    timer = setTimeout(rebuild, throttleMs);
  };

  const rebuild = async () => {
    timer = undefined;
    rebuilding = true;
    let changed = false;
    try {
      for (const entry of entries.values()) {
        if (!entry.dirty) continue;
        entry.dirty = false;
        const message = await reduceUIMessageChunks(entry.chunks);
        if (disposed) return;
        if (message) {
          entry.message = message;
          changed = true;
        }
        if (entry.finished && !entry.dirty) entry.chunks = [];
      }
    } finally {
      rebuilding = false;
    }
    if (changed) options.onChange?.();
    for (const entry of entries.values()) {
      if (entry.dirty) {
        schedule();
        break;
      }
    }
  };

  return {
    onData(part) {
      if (disposed || part.type !== SUB_AGENT_DATA_TYPE) return;
      const batch = part.data as SubAgentChunkBatch | undefined;
      if (!batch || typeof batch.toolCallId !== "string" || !Array.isArray(batch.chunks)) return;

      let entry = entries.get(batch.toolCallId);
      if (!entry) {
        entry = { chunks: [], nextSeq: 0, message: undefined, dirty: false, finished: false };
        entries.set(batch.toolCallId, entry);
      }
      if (batch.seq !== entry.nextSeq) return;

      entry.nextSeq++;
      entry.chunks.push(...batch.chunks);
      if (batch.chunks.some((chunk) => chunk.type === "finish")) entry.finished = true;
      entry.dirty = true;
      schedule();
    },
    get(toolCallId) {
      return entries.get(toolCallId)?.message as TUIMessage | undefined;
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      entries.clear();
    },
  };
}
