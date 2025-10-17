import Redis, { RedisOptions } from "ioredis";
import { StreamIngestor, StreamResponder } from "./types";
import { LineTransformStream } from "./utils.server";
import { env } from "~/env.server";
import { Logger, LogLevel } from "@trigger.dev/core/logger";

export type RealtimeStreamsOptions = {
  redis: RedisOptions | undefined;
  logger?: Logger;
  logLevel?: LogLevel;
  inactivityTimeoutMs?: number; // Close stream after this many ms of no new data (default: 60000)
};

// Legacy constant for backward compatibility (no longer written, but still recognized when reading)
const END_SENTINEL = "<<CLOSE_STREAM>>";

// Class implementing both interfaces
export class RedisRealtimeStreams implements StreamIngestor, StreamResponder {
  private logger: Logger;
  private inactivityTimeoutMs: number;

  constructor(private options: RealtimeStreamsOptions) {
    this.logger = options.logger ?? new Logger("RedisRealtimeStreams", options.logLevel ?? "info");
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 60000; // Default: 60 seconds
  }

  async streamResponse(
    request: Request,
    runId: string,
    streamId: string,
    signal: AbortSignal
  ): Promise<Response> {
    const redis = new Redis(this.options.redis ?? {});
    const streamKey = `stream:${runId}:${streamId}`;
    let isCleanedUp = false;

    const stream = new ReadableStream({
      start: async (controller) => {
        let lastId = "0";
        let retryCount = 0;
        const maxRetries = 3;
        let lastDataTime = Date.now();
        const blockTimeMs = 5000;

        try {
          while (!signal.aborted) {
            try {
              const messages = await redis.xread(
                "COUNT",
                100,
                "BLOCK",
                blockTimeMs,
                "STREAMS",
                streamKey,
                lastId
              );

              retryCount = 0;

              if (messages && messages.length > 0) {
                const [_key, entries] = messages[0];
                let foundData = false;

                for (let i = 0; i < entries.length; i++) {
                  const [id, fields] = entries[i];
                  lastId = id;

                  if (fields && fields.length >= 2) {
                    // Extract the data field from the Redis entry
                    // Fields format: ["field1", "value1", "field2", "value2", ...]
                    let data: string | null = null;

                    for (let j = 0; j < fields.length; j += 2) {
                      if (fields[j] === "data") {
                        data = fields[j + 1];
                        break;
                      }
                    }

                    // Handle legacy entries that don't have field names (just data at index 1)
                    if (data === null && fields.length >= 2) {
                      data = fields[1];
                    }

                    if (data) {
                      // Skip legacy END_SENTINEL entries (backward compatibility)
                      if (data === END_SENTINEL) {
                        continue;
                      }

                      controller.enqueue(data);
                      foundData = true;
                      lastDataTime = Date.now();

                      if (signal.aborted) {
                        controller.close();
                        return;
                      }
                    }
                  }
                }

                // If we didn't find any data in this batch, might have only seen sentinels
                if (!foundData) {
                  // Check for inactivity timeout
                  const inactiveMs = Date.now() - lastDataTime;
                  if (inactiveMs >= this.inactivityTimeoutMs) {
                    this.logger.debug(
                      "[RealtimeStreams][streamResponse] Closing stream due to inactivity",
                      {
                        streamKey,
                        inactiveMs,
                        threshold: this.inactivityTimeoutMs,
                      }
                    );
                    controller.close();
                    return;
                  }
                }
              } else {
                // No messages received (timed out on BLOCK)
                // Check for inactivity timeout
                const inactiveMs = Date.now() - lastDataTime;
                if (inactiveMs >= this.inactivityTimeoutMs) {
                  this.logger.debug(
                    "[RealtimeStreams][streamResponse] Closing stream due to inactivity",
                    {
                      streamKey,
                      inactiveMs,
                      threshold: this.inactivityTimeoutMs,
                    }
                  );
                  controller.close();
                  return;
                }
              }
            } catch (error) {
              if (signal.aborted) break;

              this.logger.error(
                "[RealtimeStreams][streamResponse] Error reading from Redis stream:",
                {
                  error,
                }
              );
              retryCount++;
              if (retryCount >= maxRetries) throw error;
              await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount));
            }
          }
        } catch (error) {
          this.logger.error("[RealtimeStreams][streamResponse] Fatal error in stream processing:", {
            error,
          });
          controller.error(error);
        } finally {
          await cleanup();
        }
      },
      cancel: async () => {
        await cleanup();
      },
    })
      .pipeThrough(new LineTransformStream())
      .pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            for (const line of chunk) {
              controller.enqueue(`data: ${line}\n\n`);
            }
          },
        })
      )
      .pipeThrough(new TextEncoderStream());

    async function cleanup() {
      if (isCleanedUp) return;
      isCleanedUp = true;
      await redis.quit().catch(console.error);
    }

    signal.addEventListener("abort", cleanup);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  async ingestData(
    stream: ReadableStream<Uint8Array>,
    runId: string,
    streamId: string,
    clientId: string,
    resumeFromChunk?: number
  ): Promise<Response> {
    const redis = new Redis(this.options.redis ?? {});
    const streamKey = `stream:${runId}:${streamId}`;
    const startChunk = resumeFromChunk ?? 0;
    // Start counting from the resume point, not from 0
    let currentChunkIndex = startChunk;

    const self = this;

    async function cleanup() {
      try {
        await redis.quit();
      } catch (error) {
        self.logger.error("[RedisRealtimeStreams][ingestData] Error in cleanup:", { error });
      }
    }

    try {
      const textStream = stream.pipeThrough(new TextDecoderStream());
      const reader = textStream.getReader();

      while (true) {
        const { done, value } = await reader.read();

        if (done || !value) {
          break;
        }

        // Write each chunk with its index and clientId
        this.logger.debug("[RedisRealtimeStreams][ingestData] Writing chunk", {
          streamKey,
          runId,
          clientId,
          chunkIndex: currentChunkIndex,
          resumeFromChunk: startChunk,
          value,
        });

        await redis.xadd(
          streamKey,
          "MAXLEN",
          "~",
          String(env.REALTIME_STREAM_MAX_LENGTH),
          "*",
          "clientId",
          clientId,
          "chunkIndex",
          currentChunkIndex.toString(),
          "data",
          value
        );

        currentChunkIndex++;
      }

      // Set TTL for cleanup when stream is done
      await redis.expire(streamKey, env.REALTIME_STREAM_TTL);

      return new Response(null, { status: 200 });
    } catch (error) {
      if (error instanceof Error) {
        if ("code" in error && error.code === "ECONNRESET") {
          this.logger.info("[RealtimeStreams][ingestData] Connection reset during ingestData:", {
            error,
          });
          return new Response(null, { status: 500 });
        }
      }

      this.logger.error("[RealtimeStreams][ingestData] Error in ingestData:", { error });

      return new Response(null, { status: 500 });
    } finally {
      await cleanup();
    }
  }

  async getLastChunkIndex(runId: string, streamId: string, clientId: string): Promise<number> {
    const redis = new Redis(this.options.redis ?? {});
    const streamKey = `stream:${runId}:${streamId}`;

    try {
      // Paginate through the stream from newest to oldest until we find this client's last chunk
      const batchSize = 100;
      let lastId = "+"; // Start from newest

      while (true) {
        const entries = await redis.xrevrange(streamKey, lastId, "-", "COUNT", batchSize);

        if (!entries || entries.length === 0) {
          // Reached the beginning of the stream, no chunks from this client
          this.logger.debug(
            "[RedisRealtimeStreams][getLastChunkIndex] No chunks found for client",
            {
              streamKey,
              clientId,
            }
          );
          return -1;
        }

        // Search through this batch for the client's last chunk
        for (const [id, fields] of entries) {
          let entryClientId: string | null = null;
          let chunkIndex: number | null = null;
          let data: string | null = null;

          for (let i = 0; i < fields.length; i += 2) {
            if (fields[i] === "clientId") {
              entryClientId = fields[i + 1];
            }
            if (fields[i] === "chunkIndex") {
              chunkIndex = parseInt(fields[i + 1], 10);
            }
            if (fields[i] === "data") {
              data = fields[i + 1];
            }
          }

          // Skip legacy END_SENTINEL entries (backward compatibility)
          if (data === END_SENTINEL) {
            continue;
          }

          // Check if this entry is from our client and has a chunkIndex
          if (entryClientId === clientId && chunkIndex !== null) {
            this.logger.debug("[RedisRealtimeStreams][getLastChunkIndex] Found last chunk", {
              streamKey,
              clientId,
              chunkIndex,
            });
            return chunkIndex;
          }
        }

        // Move to next batch (older entries)
        // Use the ID of the last entry in this batch as the new cursor
        lastId = `(${entries[entries.length - 1][0]}`; // Exclusive range with (
      }
    } catch (error) {
      this.logger.error("[RedisRealtimeStreams][getLastChunkIndex] Error getting last chunk:", {
        error,
        streamKey,
        clientId,
      });
      // Return -1 to indicate we don't know what the server has
      return -1;
    } finally {
      await redis.quit().catch((err) => {
        this.logger.error("[RedisRealtimeStreams][getLastChunkIndex] Error in cleanup:", { err });
      });
    }
  }
}
