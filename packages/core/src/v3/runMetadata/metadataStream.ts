export type MetadataOptions<T> = {
  baseUrl: string;
  runId: string;
  key: string;
  source: AsyncIterable<T>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  version?: "v1" | "v2";
  target?: "self" | "parent" | "root";
};

export class MetadataStream<T> {
  private controller = new AbortController();
  private serverStream: ReadableStream<T>;
  private consumerStream: ReadableStream<T>;
  private streamPromise: Promise<void | Response>;

  constructor(private options: MetadataOptions<T>) {
    const [serverStream, consumerStream] = this.createTeeStreams();
    this.serverStream = serverStream;
    this.consumerStream = consumerStream;

    this.streamPromise = this.initializeServerStream();
  }

  private createTeeStreams() {
    const readableSource = new ReadableStream<T>({
      start: async (controller) => {
        for await (const value of this.options.source) {
          controller.enqueue(value);
        }

        controller.close();
      },
    });

    return readableSource.tee();
  }

  private initializeServerStream(): Promise<Response> {
    const serverStream = this.serverStream.pipeThrough(
      new TransformStream<T, string>({
        async transform(chunk, controller) {
          controller.enqueue(JSON.stringify(chunk) + "\n");
        },
      })
    );

    return fetch(this.buildUrl(), {
      method: "POST",
      headers: this.options.headers ?? {},
      body: serverStream,
      signal: this.controller.signal,
      // @ts-expect-error
      duplex: "half",
    });
  }

  public async wait(): Promise<void> {
    return this.streamPromise.then(() => void 0);
  }

  public [Symbol.asyncIterator]() {
    return streamToAsyncIterator(this.consumerStream);
  }

  private buildUrl(): string {
    switch (this.options.version ?? "v1") {
      case "v1": {
        return `${this.options.baseUrl}/realtime/v1/streams/${this.options.runId}/${
          this.options.target ?? "self"
        }/${this.options.key}`;
      }
      case "v2": {
        return `${this.options.baseUrl}/realtime/v2/streams/${this.options.runId}/${this.options.key}`;
      }
    }
  }
}

async function* streamToAsyncIterator<T>(stream: ReadableStream<T>): AsyncIterableIterator<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
