import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import { StreamsWriter } from "./types.js";

export type StreamsWriterV1Options<T> = {
  baseUrl: string;
  runId: string;
  key: string;
  source: ReadableStream<T>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  version?: string;
  target?: "self" | "parent" | "root";
  maxRetries?: number;
  maxBufferSize?: number; // Max number of chunks to keep in ring buffer
  clientId?: string; // Optional client ID, auto-generated if not provided
};

interface BufferedChunk<T> {
  index: number;
  data: T;
}

export class StreamsWriterV1<T> implements StreamsWriter {
  private controller = new AbortController();
  private serverStream: ReadableStream<T>;
  private consumerStream: ReadableStream<T>;
  private streamPromise: Promise<void>;
  private retryCount = 0;
  private readonly maxRetries: number;
  private currentChunkIndex = 0;
  private readonly baseDelayMs = 1000; // 1 second base delay
  private readonly maxDelayMs = 30000; // 30 seconds max delay
  private readonly maxBufferSize: number;
  private readonly clientId: string;
  private ringBuffer: BufferedChunk<T>[] = []; // Ring buffer for recent chunks
  private bufferStartIndex = 0; // Index of the oldest chunk in buffer
  private highestBufferedIndex = -1; // Highest chunk index that's been buffered
  private streamReader: ReadableStreamDefaultReader<T> | null = null;
  private bufferReaderTask: Promise<void> | null = null;
  private streamComplete = false;

  constructor(private options: StreamsWriterV1Options<T>) {
    const [serverStream, consumerStream] = this.options.source.tee();
    this.serverStream = serverStream;
    this.consumerStream = consumerStream;
    this.maxRetries = options.maxRetries ?? 10;
    this.maxBufferSize = options.maxBufferSize ?? 10000; // Default 10000 chunks
    this.clientId = options.clientId || this.generateClientId();

    // Start background task to continuously read from stream into ring buffer
    this.startBuffering();

    this.streamPromise = this.initializeServerStream();
  }

  private generateClientId(): string {
    return randomBytes(4).toString("hex");
  }

  private startBuffering(): void {
    this.streamReader = this.serverStream.getReader();

    this.bufferReaderTask = (async () => {
      try {
        let chunkIndex = 0;
        while (true) {
          const { done, value } = await this.streamReader!.read();

          if (done) {
            this.streamComplete = true;
            break;
          }

          // Add to ring buffer
          this.addToRingBuffer(chunkIndex, value);
          this.highestBufferedIndex = chunkIndex;
          chunkIndex++;
        }
      } catch (error) {
        throw error;
      }
    })();
  }

  private async makeRequest(startFromChunk: number = 0): Promise<void> {
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
          "X-Client-Id": this.clientId,
          "X-Resume-From-Chunk": startFromChunk.toString(),
          "X-Stream-Version": this.options.version ?? "v1",
        },
        timeout,
      });

      req.on("error", async (error) => {
        const errorCode = "code" in error ? error.code : undefined;
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Check if this is a retryable connection error
        if (this.isRetryableError(error)) {
          if (this.retryCount < this.maxRetries) {
            this.retryCount++;

            // Clean up the current request to avoid socket leaks
            req.destroy();

            const delayMs = this.calculateBackoffDelay();

            await this.delay(delayMs);

            // Query server to find out what the last chunk it received was
            const serverLastChunk = await this.queryServerLastChunkIndex();

            // Resume from the next chunk after what the server has
            const resumeFromChunk = serverLastChunk + 1;

            resolve(this.makeRequest(resumeFromChunk));
            return;
          }
        }

        reject(error);
      });

      req.on("timeout", async () => {
        // Timeout is retryable
        if (this.retryCount < this.maxRetries) {
          this.retryCount++;

          // Clean up the current request to avoid socket leaks
          req.destroy();

          const delayMs = this.calculateBackoffDelay();

          await this.delay(delayMs);

          // Query server to find where to resume
          const serverLastChunk = await this.queryServerLastChunkIndex();
          const resumeFromChunk = serverLastChunk + 1;

          resolve(this.makeRequest(resumeFromChunk));
          return;
        }

        req.destroy();
        reject(new Error("Request timed out"));
      });

      req.on("response", async (res) => {
        // Check for retryable status codes (408, 429, 5xx)
        if (res.statusCode && this.isRetryableStatusCode(res.statusCode)) {
          if (this.retryCount < this.maxRetries) {
            this.retryCount++;

            // Drain and destroy the response and request to avoid socket leaks
            // We need to consume the response before destroying it
            res.resume(); // Start draining the response
            res.destroy(); // Destroy the response to free the socket
            req.destroy(); // Destroy the request as well

            const delayMs = this.calculateBackoffDelay();

            await this.delay(delayMs);

            // Query server to find where to resume (in case some data was written)
            const serverLastChunk = await this.queryServerLastChunkIndex();
            const resumeFromChunk = serverLastChunk + 1;

            resolve(this.makeRequest(resumeFromChunk));
            return;
          }

          res.destroy();
          req.destroy();
          reject(
            new Error(`Max retries (${this.maxRetries}) exceeded for status code ${res.statusCode}`)
          );
          return;
        }

        // Non-retryable error status
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.destroy();
          req.destroy();
          const error = new Error(`HTTP error! status: ${res.statusCode}`);
          reject(error);
          return;
        }

        // Success! Reset retry count
        this.retryCount = 0;

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
          let lastSentIndex = startFromChunk - 1;

          while (true) {
            // Send all chunks that are available in buffer
            while (lastSentIndex < this.highestBufferedIndex) {
              lastSentIndex++;
              const chunk = this.ringBuffer.find((c) => c.index === lastSentIndex);

              if (chunk) {
                const stringified = JSON.stringify(chunk.data) + "\n";
                req.write(stringified);
                this.currentChunkIndex = lastSentIndex + 1;
              }
            }

            // If stream is complete and we've sent all buffered chunks, we're done
            if (this.streamComplete && lastSentIndex >= this.highestBufferedIndex) {
              req.end();
              break;
            }

            // Wait a bit for more chunks to be buffered
            await this.delay(10);
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
    return `${this.options.baseUrl}/realtime/v1/streams/${this.options.runId}/${
      this.options.target ?? "self"
    }/${this.options.key}`;
  }

  private isRetryableError(error: any): boolean {
    if (!error) return false;

    // Connection errors that are safe to retry
    const retryableErrors = [
      "ECONNRESET", // Connection reset by peer
      "ECONNREFUSED", // Connection refused
      "ETIMEDOUT", // Connection timed out
      "ENOTFOUND", // DNS lookup failed
      "EPIPE", // Broken pipe
      "EHOSTUNREACH", // Host unreachable
      "ENETUNREACH", // Network unreachable
      "socket hang up", // Socket hang up
    ];

    // Check error code
    if (error.code && retryableErrors.includes(error.code)) {
      return true;
    }

    // Check error message for socket hang up
    if (error.message && error.message.includes("socket hang up")) {
      return true;
    }

    return false;
  }

  private isRetryableStatusCode(statusCode: number): boolean {
    // Retry on transient server errors
    if (statusCode === 408) return true; // Request Timeout
    if (statusCode === 429) return true; // Rate Limit
    if (statusCode === 500) return true; // Internal Server Error
    if (statusCode === 502) return true; // Bad Gateway
    if (statusCode === 503) return true; // Service Unavailable
    if (statusCode === 504) return true; // Gateway Timeout

    return false;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private calculateBackoffDelay(): number {
    // Exponential backoff with jitter: baseDelay * 2^retryCount + random jitter
    const exponentialDelay = this.baseDelayMs * Math.pow(2, this.retryCount);
    const jitter = Math.random() * 1000; // 0-1000ms jitter
    return Math.min(exponentialDelay + jitter, this.maxDelayMs);
  }

  private addToRingBuffer(index: number, data: T): void {
    const chunk: BufferedChunk<T> = { index, data };

    if (this.ringBuffer.length < this.maxBufferSize) {
      // Buffer not full yet, just append
      this.ringBuffer.push(chunk);
    } else {
      // Buffer full, replace oldest chunk (ring buffer behavior)
      const bufferIndex = index % this.maxBufferSize;
      this.ringBuffer[bufferIndex] = chunk;
      this.bufferStartIndex = Math.max(this.bufferStartIndex, index - this.maxBufferSize + 1);
    }
  }

  private getChunksFromBuffer(startIndex: number): BufferedChunk<T>[] {
    const result: BufferedChunk<T>[] = [];

    for (const chunk of this.ringBuffer) {
      if (chunk.index >= startIndex) {
        result.push(chunk);
      }
    }

    // Sort by index to ensure correct order
    result.sort((a, b) => a.index - b.index);
    return result;
  }

  private async queryServerLastChunkIndex(attempt: number = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.buildUrl());
      const maxHeadRetries = 3; // Separate retry limit for HEAD requests

      const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = requestFn({
        method: "HEAD",
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          ...this.options.headers,
          "X-Client-Id": this.clientId,
          "X-Stream-Version": this.options.version ?? "v1",
        },
        timeout: 5000, // 5 second timeout for HEAD request
      });

      req.on("error", async (error) => {
        if (this.isRetryableError(error) && attempt < maxHeadRetries) {
          // Clean up the current request to avoid socket leaks
          req.destroy();

          await this.delay(1000 * (attempt + 1)); // Simple linear backoff
          const result = await this.queryServerLastChunkIndex(attempt + 1);
          resolve(result);
          return;
        }

        req.destroy();
        // Return -1 to indicate we don't know what the server has (resume from 0)
        resolve(-1);
      });

      req.on("timeout", async () => {
        req.destroy();

        if (attempt < maxHeadRetries) {
          await this.delay(1000 * (attempt + 1));
          const result = await this.queryServerLastChunkIndex(attempt + 1);
          resolve(result);
          return;
        }

        resolve(-1);
      });

      req.on("response", async (res) => {
        // Retry on 5xx errors
        if (res.statusCode && this.isRetryableStatusCode(res.statusCode)) {
          if (attempt < maxHeadRetries) {
            // Drain and destroy the response and request to avoid socket leaks
            res.resume();
            res.destroy();
            req.destroy();

            await this.delay(1000 * (attempt + 1));
            const result = await this.queryServerLastChunkIndex(attempt + 1);
            resolve(result);
            return;
          }

          res.destroy();
          req.destroy();
          resolve(-1);
          return;
        }

        // Non-retryable error
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.destroy();
          req.destroy();
          resolve(-1);
          return;
        }

        // Success - extract chunk index
        const lastChunkHeader = res.headers["x-last-chunk-index"];
        if (lastChunkHeader) {
          const lastChunkIndex = parseInt(
            Array.isArray(lastChunkHeader) ? lastChunkHeader[0] ?? "0" : lastChunkHeader ?? "0",
            10
          );
          resolve(lastChunkIndex);
        } else {
          resolve(-1);
        }

        res.resume(); // Consume response
      });

      req.end();
    });
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
    safeReleaseLock(reader);
  }
}

function safeReleaseLock(reader: ReadableStreamDefaultReader<any>) {
  try {
    reader.releaseLock();
  } catch (error) {}
}
