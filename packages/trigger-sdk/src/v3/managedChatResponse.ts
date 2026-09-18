import type { UIMessage, UIMessageChunk } from "ai";
import { generateId, readUIMessageStream } from "../imports/ai-runtime.js";

/** One ordered output channel for a turn's managed model and data chunks. */
export class ManagedChatResponse {
  private controller?: ReadableStreamDefaultController<UIMessageChunk>;
  private completion?: Promise<unknown>;
  private failure?: unknown;
  private closed = false;
  private chunks: UIMessageChunk[] = [];
  private original?: UIMessage;
  private fallbackId = generateId();
  private completedSteps = 0;
  private dataBoundary = 0;
  private generationOffset = 0;
  private orderedSteps = true;
  private pendingData: Array<{ chunk: UIMessageChunk; capture: boolean; after: number }> = [];

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

  beginGeneration(): void {
    this.generationOffset = this.completedSteps;
    this.dataBoundary = this.completedSteps;
  }

  afterStep(completedSteps: number): void {
    this.dataBoundary = this.orderedSteps ? this.generationOffset + completedSteps : 0;
  }

  /** Raw pipes own their output ordering and do not feed this capture. */
  useRawPipe(): void {
    this.orderedSteps = false;
    this.dataBoundary = 0;
    this.flushPendingData();
  }

  private flushPendingData(): void {
    this.dataBoundary = this.completedSteps;
    for (const next of this.pendingData.splice(0)) this.write(next.chunk, next.capture);
  }

  writeData(chunk: UIMessageChunk): void {
    const capture = chunk.type.startsWith("data-") && !("transient" in chunk && chunk.transient);
    if (this.closed) throw new Error("The managed chat response is closed");
    if (this.dataBoundary > this.completedSteps) {
      this.pendingData.push({ chunk, capture, after: this.dataBoundary });
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
    if (capture && chunk.type === "finish-step") {
      this.completedSteps++;
      while (this.pendingData[0] && this.pendingData[0].after <= this.completedSteps) {
        const next = this.pendingData.shift()!;
        this.write(next.chunk, next.capture);
      }
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
    let message: UIMessage | undefined = options?.message;
    const original = options?.message ?? this.original;
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    for await (const update of readUIMessageStream({
      stream,
      ...(original ? { message: structuredClone(original) } : {}),
      // An error chunk must leave previously streamed content recoverable.
      terminateOnError: false,
    }))
      message = update;
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
