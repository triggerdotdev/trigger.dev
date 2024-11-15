import { run } from "node:test";

export type MetadataOptions<T> = {
  baseUrl: string;
  runId: string;
  key: string;
  iterator: AsyncIterator<T>;
  signal?: AbortSignal;
};

export class MetadataStream<T> {
  private controller = new AbortController();
  private serverQueue: Array<Promise<IteratorResult<T>>> = [];
  private consumerQueue: Array<Promise<IteratorResult<T>>> = [];
  private serverIterator: AsyncIterator<T>;
  private consumerIterator: AsyncIterator<T>;
  private streamPromise: Promise<void | Response>;

  constructor(private options: MetadataOptions<T>) {
    const { serverIterator, consumerIterator } = this.createTeeIterators();
    this.serverIterator = serverIterator;
    this.consumerIterator = consumerIterator;

    this.streamPromise = this.initializeServerStream();
  }

  private createTeeIterators() {
    const teeIterator = (queue: Array<Promise<IteratorResult<T>>>): AsyncIterator<T> => ({
      next: () => {
        if (queue.length === 0) {
          const result = this.options.iterator.next();
          this.serverQueue.push(result);
          this.consumerQueue.push(result);
        }
        return queue.shift()!;
      },
    });

    return {
      serverIterator: teeIterator(this.serverQueue),
      consumerIterator: teeIterator(this.consumerQueue),
    };
  }

  private initializeServerStream(): Promise<void | Response> {
    const serverIterator = this.serverIterator;

    // TODO: Why is this only sending stuff to the server at the end of the run?
    const serverStream = new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await serverIterator.next();
          if (done) {
            controller.close();
            return;
          }

          controller.enqueue(JSON.stringify(value) + "\n");
        } catch (err) {
          controller.error(err);
        }
      },
      cancel: () => this.controller.abort(),
    });

    return fetch(
      `${this.options.baseUrl}/realtime/v1/streams/${this.options.runId}/${this.options.key}`,
      {
        method: "POST",
        headers: {},
        body: serverStream,
        // @ts-expect-error
        duplex: "half",
        signal: this.controller.signal,
      }
    );
  }

  public async wait(): Promise<void> {
    return this.streamPromise.then(() => void 0);
  }

  public [Symbol.asyncIterator]() {
    return this.consumerIterator;
  }
}
