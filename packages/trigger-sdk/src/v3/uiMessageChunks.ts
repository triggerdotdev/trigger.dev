import type { UIMessage, UIMessageChunk } from "ai";
import { createUIMessageStream } from "../imports/ai-runtime.js";

/** How long a reduction runs before handing the event loop back to timers and heartbeats. */
const YIELD_EVERY_MS = 10;

/**
 * Reduce recorded `UIMessageChunk`s to the final `UIMessage` they build, with
 * the AI SDK's own reducer.
 *
 * `readUIMessageStream` emits a `structuredClone` of the whole message after
 * almost every chunk, so draining it just to keep the last snapshot is
 * quadratic in the length of the message. A long unfinished turn could block
 * the event loop for minutes. `createUIMessageStream`'s `onFinish` runs the
 * same reducer over one mutable state and only hands back the end result,
 * which is cloned once so it shares nothing with the recorded chunks.
 *
 * Chunks are written one at a time, each after the previous one comes out of
 * the stream. Dequeuing from a long web stream queue is linear in its length
 * on Node, so writing a whole turn up front would make the reduction quadratic
 * even without any cloning. This relies on the AI SDK passing every chunk
 * through, which its UI message streams do. Chunks are also copied before they
 * are written, because the AI SDK writes a missing `messageId` onto `start`
 * chunks and stores data chunks as message parts.
 *
 * Matches the last snapshot `readUIMessageStream` would emit, except that
 * `step-start` parts pushed after the last snapshot are kept (they are part of
 * the reducer's final state, which is also what `onFinish` returns on the live
 * path). Returns `undefined` when no chunk would have emitted a snapshot.
 *
 * A malformed chunk (e.g. a delta for a part that never started) errors the
 * stream, while `readUIMessageStream` keeps everything reduced before it.
 * Because only one chunk is in flight, the failing chunk is known exactly, and
 * the chunks before it are reduced again on the same linear path.
 *
 * @param options.message - The assistant message the chunks continue. Not mutated.
 * @internal
 */
export async function reduceUIMessageChunks(
  chunks: readonly UIMessageChunk[],
  options?: { message?: UIMessage }
): Promise<UIMessage | undefined> {
  let end = chunks.length;
  while (emitsAnySnapshot(chunks, end)) {
    const result = await reducePrefix(chunks, end, options?.message);
    if ("message" in result) return result.message && structuredClone(result.message);
    if (result.failedAt >= end) return undefined;
    end = result.failedAt;
  }
  return undefined;
}

async function reducePrefix(
  chunks: readonly UIMessageChunk[],
  end: number,
  original: UIMessage | undefined
): Promise<{ message: UIMessage | undefined } | { failedAt: number }> {
  let message: UIMessage | undefined;
  let read = 0;
  let done = false;
  let resume: (() => void) | undefined;
  const stream = createUIMessageStream({
    generateId: () => "",
    ...(original ? { originalMessages: [original] } : {}),
    async execute({ writer }) {
      for (let written = 0; written < end && !done; written++) {
        writer.write({ ...chunks[written]! });
        if (read <= written) {
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        }
      }
    },
    onFinish({ responseMessage }) {
      message = responseMessage;
    },
  });

  const reader = stream.getReader();
  let sliceStart = performance.now();
  try {
    while (!(await reader.read()).done) {
      read++;
      resume?.();
      resume = undefined;
      if (performance.now() - sliceStart >= YIELD_EVERY_MS) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        sliceStart = performance.now();
      }
    }
  } catch {
    return { failedAt: read };
  } finally {
    done = true;
    resume?.();
    reader.releaseLock();
  }
  return { message };
}

function emitsAnySnapshot(chunks: readonly UIMessageChunk[], end: number): boolean {
  for (let index = 0; index < end; index++) if (emitsSnapshot(chunks[index]!)) return true;
  return false;
}

/** Whether `readUIMessageStream` emits a snapshot after this chunk. */
function emitsSnapshot(chunk: UIMessageChunk): boolean {
  switch (chunk.type) {
    case "start":
      return chunk.messageId != null || chunk.messageMetadata != null;
    case "finish":
    case "message-metadata":
      return chunk.messageMetadata != null;
    case "start-step":
    case "finish-step":
    case "error":
    case "abort":
      return false;
    default:
      return !(chunk.type.startsWith("data-") && "transient" in chunk && chunk.transient === true);
  }
}
