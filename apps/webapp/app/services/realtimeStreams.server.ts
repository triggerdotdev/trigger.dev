import Redis, { RedisKey, RedisOptions, RedisValue } from "ioredis";
import { logger } from "./logger.server";

export type RealtimeStreamsOptions = {
  redis: RedisOptions | undefined;
};

const END_SENTINEL = "<<CLOSE_STREAM>>";

export class RealtimeStreams {
  constructor(private options: RealtimeStreamsOptions) {}

  async streamResponse(runId: string, streamId: string, signal: AbortSignal): Promise<Response> {
    const redis = new Redis(this.options.redis ?? {});
    const streamKey = `stream:${runId}:${streamId}`;
    let isCleanedUp = false;

    const stream = new ReadableStream({
      start: async (controller) => {
        let lastId = "0";
        let retryCount = 0;
        const maxRetries = 3;

        try {
          while (!signal.aborted) {
            try {
              const messages = await redis.xread(
                "COUNT",
                100,
                "BLOCK",
                5000,
                "STREAMS",
                streamKey,
                lastId
              );

              retryCount = 0;

              if (messages && messages.length > 0) {
                const [_key, entries] = messages[0];

                for (const [id, fields] of entries) {
                  lastId = id;

                  if (fields && fields.length >= 2) {
                    if (fields[1] === END_SENTINEL) {
                      controller.close();
                      return;
                    }
                    controller.enqueue(`data: ${fields[1]}\n\n`);

                    if (signal.aborted) {
                      controller.close();
                      return;
                    }
                  }
                }
              }
            } catch (error) {
              if (signal.aborted) break;

              console.error("Error reading from Redis stream:", error);
              retryCount++;
              if (retryCount >= maxRetries) throw error;
              await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount));
            }
          }
        } catch (error) {
          console.error("Fatal error in stream processing:", error);
          controller.error(error);
        } finally {
          await cleanup();
        }
      },
      cancel: async () => {
        await cleanup();
      },
    });

    async function cleanup() {
      if (isCleanedUp) return;
      isCleanedUp = true;
      await redis.quit().catch(console.error);
    }

    signal.addEventListener("abort", cleanup);

    return new Response(stream.pipeThrough(new TextEncoderStream()), {
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
    streamId: string
  ): Promise<Response> {
    const redis = new Redis(this.options.redis ?? {});
    const streamKey = `stream:${runId}:${streamId}`;

    async function cleanup() {
      try {
        await redis.quit();
      } catch (error) {
        logger.error("[RealtimeStreams][ingestData] Error in cleanup:", { error });
      }
    }

    try {
      // Use TextDecoderStream to simplify text decoding
      const textStream = stream.pipeThrough(new TextDecoderStream());
      const reader = textStream.getReader();

      const batchSize = 10; // Adjust this value based on performance testing
      let batchCommands: Array<[key: RedisKey, ...args: RedisValue[]]> = [];

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        logger.debug("[RealtimeStreams][ingestData] Reading data", { streamKey, value });

        // 'value' is a string containing the decoded text
        const lines = value.split("\n");

        for (const line of lines) {
          if (line.trim()) {
            // Avoid unnecessary parsing; assume 'line' is already a JSON string
            // Add XADD command with MAXLEN option to limit stream size
            batchCommands.push([streamKey, "MAXLEN", "~", "1000", "*", "data", line]);

            if (batchCommands.length >= batchSize) {
              // Send batch using a pipeline
              const pipeline = redis.pipeline();
              for (const args of batchCommands) {
                pipeline.xadd(...args);
              }
              await pipeline.exec();
              batchCommands = [];
            }
          }
        }
      }

      // Send any remaining commands
      if (batchCommands.length > 0) {
        const pipeline = redis.pipeline();
        for (const args of batchCommands) {
          pipeline.xadd(...args);
        }
        await pipeline.exec();
      }

      // Send the __end message to indicate the end of the stream
      await redis.xadd(streamKey, "MAXLEN", "~", "1000", "*", "data", END_SENTINEL);

      return new Response(null, { status: 200 });
    } catch (error) {
      console.error("Error in ingestData:", error);
      return new Response(null, { status: 500 });
    } finally {
      await cleanup();
    }
  }
}
