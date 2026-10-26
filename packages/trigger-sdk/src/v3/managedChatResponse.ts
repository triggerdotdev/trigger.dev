import type { UIMessage, UIMessageChunk } from "ai";
import { generateId } from "../imports/ai-runtime.js";
import { reduceUIMessageChunks } from "./uiMessageChunks.js";

/** One ordered output channel for a turn's managed model and data chunks. */
export class ManagedChatResponse {
  private controller?: ReadableStreamDefaultController<UIMessageChunk>;
  private completion?: Promise<unknown>;
  private failure?: unknown;
  private closed = false;
  private chunks: UIMessageChunk[] = [];
  private original?: UIMessage;
  private fallbackId = generateId();
  private openStepToolCallIds = new Set<string>();
  private finishedToolCallIds = new Set<string>();
  /** Data written now waits for the step that made these tool calls. */
  private dataAnchor?: string[];
  private orderedSteps = true;
  private pendingData: Array<{ chunk: UIMessageChunk; capture: boolean; anchor: string[] }> = [];

  constructor(
    private readonly publish: (stream: ReadableStream<UIMessageChunk>) => Promise<unknown>
  ) {}

  seed(messages: readonly UIMessage[] | undefined): void {
    // Never mutate the caller's history while processing a continuation.
    const last = messages?.at(-1);
    this.original = last?.role === "assistant" ? structuredClone(last) : undefined;
  }

  get isClosed(): boolean {
    return this.closed;
  }
  get revision(): number {
    return this.chunks.length;
  }

  continues(id: string): boolean {
    return this.original?.id === id;
  }

  /**
   * Hold data written from now on until the step that made `toolCallIds` has
   * finished in this stream. Anchored by tool call rather than step count, so
   * it holds whichever generation made the calls and whenever it is piped. A
   * generation that is never piped (e.g. nested in a tool) holds its data until
   * the pipe ends or the response closes.
   */
  afterToolStep(toolCallIds: readonly string[]): void {
    this.dataAnchor =
      this.orderedSteps &&
      toolCallIds.length > 0 &&
      !toolCallIds.some((id) => this.finishedToolCallIds.has(id))
        ? [...toolCallIds]
        : undefined;
  }

  /** Raw pipes own their output ordering and do not feed this capture. */
  useRawPipe(): void {
    this.orderedSteps = false;
    this.flushPendingData();
  }

  private flushPendingData(): void {
    this.dataAnchor = undefined;
    for (const next of this.pendingData.splice(0)) this.write(next.chunk, next.capture);
  }

  private finished(anchor: readonly string[]): boolean {
    return anchor.some((id) => this.finishedToolCallIds.has(id));
  }

  writeData(chunk: UIMessageChunk): void {
    const capture = chunk.type.startsWith("data-") && !("transient" in chunk && chunk.transient);
    if (this.closed) throw new Error("The managed chat response is closed");
    if (this.dataAnchor && !this.finished(this.dataAnchor)) {
      this.pendingData.push({ chunk, capture, anchor: this.dataAnchor });
    } else this.write(chunk, capture);
  }

  write(chunk: UIMessageChunk, capture = true): void {
    if (this.closed) throw new Error("The managed chat response is closed");
    if (this.failure) throw this.failure;
    if (!this.controller) {
      const stream = new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          this.controller = controller;
        },
      });
      this.completion = this.publish(stream);
      // Transport errors are observed by pipe/close; never leave an unhandled
      // rejection when a fire-and-forget custom write opened the response.
      this.completion.catch((error) => {
        this.failure = error;
      });
    }
    if (capture) this.chunks.push(chunk);
    this.controller!.enqueue(chunk);
    if (!capture) return;
    const toolCallId = (chunk as { toolCallId?: unknown }).toolCallId;
    if (typeof toolCallId === "string") this.openStepToolCallIds.add(toolCallId);
    if (chunk.type === "finish-step") {
      for (const id of this.openStepToolCallIds) this.finishedToolCallIds.add(id);
      this.openStepToolCallIds.clear();
      const released = this.pendingData.filter((next) => this.finished(next.anchor));
      this.pendingData = this.pendingData.filter((next) => !released.includes(next));
      for (const next of released) this.write(next.chunk, next.capture);
    }
  }

  async pipe(
    source: AsyncIterable<UIMessageChunk> | ReadableStream<UIMessageChunk>,
    signal?: AbortSignal
  ): Promise<void> {
    const reader = source instanceof ReadableStream ? source.getReader() : undefined;
    const iterator = reader
      ? undefined
      : (source as AsyncIterable<UIMessageChunk>)[Symbol.asyncIterator]();
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    // A pre-aborted signal or a synchronously throwing iterator can leave this
    // promise outside the read race; observe its rejection in either case.
    aborted.catch(() => {});
    const cancel = () => rejectAbort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        signal?.throwIfAborted();
        if (this.failure) throw this.failure;
        const next = reader ? reader.read() : iterator!.next();
        const result = signal ? await Promise.race([next, aborted]) : await next;
        signal?.throwIfAborted();
        if (result.done) break;
        this.write(result.value);
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      try {
        if (signal?.aborted) {
          // Async generators can queue return() behind a blocked next(). Stop
          // the turn without waiting for provider cleanup, and observe failures.
          try {
            void Promise.resolve(
              reader ? reader.cancel(signal.reason) : iterator?.return?.()
            ).catch(() => {});
          } catch {
            // A synchronous cleanup failure must not replace the abort reason.
          }
        } else if (iterator) await iterator.return?.();
      } finally {
        reader?.releaseLock();
        // No further finish-step can arrive from this source. Preserve accepted
        // data at the end of the available partial before callers snapshot it.
        this.flushPendingData();
      }
    }
  }

  /** Native reduction of the exact admitted chunks, including same-ID updates. */
  async snapshot(options?: { message: UIMessage; from: number }): Promise<UIMessage | undefined> {
    if (!this.chunks.length) return options?.message;
    const chunks = this.chunks.slice(options?.from ?? 0);
    const original = options?.message ?? this.original;
    const message =
      (await reduceUIMessageChunks(chunks, original ? { message: original } : undefined)) ??
      options?.message;
    return message ? { ...message, id: message.id || this.fallbackId } : undefined;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.flushPendingData();
      // A data-only response still needs the same server ID on both sides.
      if (
        !this.original &&
        this.chunks.length &&
        !this.chunks.some((chunk) => chunk.type === "start")
      ) {
        this.write({ type: "start", messageId: this.fallbackId });
      }
      this.closed = true;
      this.controller?.close();
    }
    await this.completion;
  }
}

/** Hook streams share a publisher; only persistent data joins managed capture. */
export function createOrderedChatWriter(
  activeResponse: () => ManagedChatResponse | undefined,
  publish: (stream: ReadableStream<UIMessageChunk>) => Promise<unknown>
) {
  const raw = new ManagedChatResponse(publish);
  const merging: Promise<void>[] = [];
  const writer = {
    write(part: UIMessageChunk) {
      const managed = activeResponse();
      if (managed) managed.writeData(part);
      else raw.write(part, false);
    },
    merge(stream: ReadableStream<UIMessageChunk>) {
      const work = (async () => {
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writer.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      })();
      work.catch(() => {});
      merging.push(work);
    },
  };
  return {
    writer,
    async flush() {
      try {
        let cursor = 0;
        while (cursor < merging.length) {
          const batch = merging.slice(cursor);
          cursor = merging.length;
          await Promise.all(batch);
        }
      } finally {
        await raw.close();
      }
    },
  };
}
