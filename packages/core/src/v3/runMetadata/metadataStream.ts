import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

export type MetadataOptions<T> = {
  baseUrl: string;
  runId: string;
  key: string;
  source: AsyncIterable<T>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  version?: "v1" | "v2";
  target?: "self" | "parent" | "root";
  maxRetries?: number;
};

export class MetadataStream<T> {
  private controller = new AbortController();
  private serverStream: ReadableStream<T>;
  private consumerStream: ReadableStream<T>;
  private streamPromise: Promise<void>;
  private retryCount = 0;
  private readonly maxRetries: number;
  private currentChunkIndex = 0;

  constructor(private options: MetadataOptions<T>) {
    const [serverStream, consumerStream] = this.createTeeStreams();
    this.serverStream = serverStream;
    this.consumerStream = consumerStream;
    this.maxRetries = options.maxRetries ?? 10;

    this.streamPromise = this.initializeServerStream();
  }

  private createTeeStreams() {
    const readableSource = new ReadableStream<T>({
      start: async (controller) => {
        try {
          for await (const value of this.options.source) {
            controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return readableSource.tee();
  }

  private async makeRequest(startFromChunk: number = 0): Promise<void> {
    const reader = this.serverStream.getReader();

    return new Promise((resolve, reject) => {
      const url = new URL(this.buildUrl());
      const timeout = 15 * 60 * 1000; // 15 minutes

      const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = requestFn({
        method: "POST",
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          ...this.options.headers,
          "Content-Type": "application/json",
          "X-Resume-From-Chunk": startFromChunk.toString(),
        },
        timeout,
      });

      req.on("error", (error) => {
        reader.releaseLock();
        reject(error);
      });

      req.on("timeout", () => {
        reader.releaseLock();
        req.destroy(new Error("Request timed out"));
      });

      req.on("response", (res) => {
        if (res.statusCode === 408) {
          reader.releaseLock();

          if (this.retryCount < this.maxRetries) {
            this.retryCount++;

            resolve(this.makeRequest(this.currentChunkIndex));
            return;
          }
          reject(new Error(`Max retries (${this.maxRetries}) exceeded after timeout`));
          return;
        }

        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          const error = new Error(`HTTP error! status: ${res.statusCode}`);
          reject(error);
          return;
        }

        res.on("end", () => {
          resolve();
        });

        res.resume();
      });

      if (this.options.signal) {
        this.options.signal.addEventListener("abort", () => {
          req.destroy(new Error("Request aborted"));
        });
      }

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              req.end();
              break;
            }

            const stringified = JSON.stringify(value) + "\n";
            req.write(stringified);
            this.currentChunkIndex++;
          }
        } catch (error) {
          reject(error);
        }
      };

      processStream().catch((error) => {
        reject(error);
      });
    });
  }

  private async initializeServerStream(): Promise<void> {
    await this.makeRequest(0);
  }

  public async wait(): Promise<void> {
    return this.streamPromise;
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
