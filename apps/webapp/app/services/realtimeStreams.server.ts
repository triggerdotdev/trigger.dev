import Redis, { RedisOptions } from "ioredis";
import { logger } from "./logger.server";

export type RealtimeStreamsOptions = {
  redis: RedisOptions | undefined;
};

export class RealtimeStreams {
  constructor(private options: RealtimeStreamsOptions) {}

  async streamResponse(runId: string, streamId: string, signal: AbortSignal): Promise<Response> {
    const redis = new Redis(this.options.redis ?? {});
    const streamKey = `stream:${runId}:${streamId}`;

    const stream = new TransformStream({
      transform(chunk: string, controller) {
        try {
          const data = JSON.parse(chunk);

          if (typeof data === "object" && data !== null && "__end" in data && data.__end === true) {
            controller.terminate();
            return;
          }
          controller.enqueue(`data: ${chunk}\n\n`);
        } catch (error) {
          console.error("Invalid JSON in stream:", error);
        }
      },
    });

    const response = new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });

    let isCleanedUp = false;

    async function cleanup() {
      if (isCleanedUp) return;
      isCleanedUp = true;
      await redis.quit();
      const writer = stream.writable.getWriter();
      if (writer) await writer.close().catch(() => {}); // Ensure close doesn't error if already closed
    }

    signal.addEventListener("abort", cleanup);

    (async () => {
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

                if (fields && fields.length >= 2 && !stream.writable.locked) {
                  const writer = stream.writable.getWriter();
                  try {
                    await writer.write(fields[1]);
                  } finally {
                    writer.releaseLock();
                  }
                }
              }
            }
          } catch (error) {
            console.error("Error reading from Redis stream:", error);
            retryCount++;
            if (retryCount >= maxRetries) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount));
          }
        }
      } catch (error) {
        console.error("Fatal error in stream processing:", error);
      } finally {
        await cleanup();
      }
    })();

    return response;
  }

  async ingestData(
    stream: ReadableStream<Uint8Array>,
    runId: string,
    streamId: string
  ): Promise<Response> {
    const redis = new Redis(this.options.redis ?? {});

    const streamKey = `stream:${runId}:${streamId}`;

    async function cleanup(stream?: TransformStream) {
      try {
        await redis.quit();
        if (stream) {
          const writer = stream.writable.getWriter();
          await writer.close(); // Catch in case the stream is already closed
        }
      } catch (error) {
        logger.error("[RealtimeStreams][ingestData] Error in cleanup:", { error });
      }
    }

    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        logger.debug("[RealtimeStreams][ingestData] Reading data", { streamKey, done });

        if (done) {
          if (buffer) {
            const data = JSON.parse(buffer);
            await redis.xadd(streamKey, "*", "data", JSON.stringify(data));
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            const data = JSON.parse(line);

            logger.debug("[RealtimeStreams][ingestData] Ingesting data", { streamKey });

            await redis.xadd(streamKey, "*", "data", JSON.stringify(data));
          }
        }
      }

      await redis.xadd(streamKey, "*", "data", JSON.stringify({ __end: true }));
      return new Response(null, { status: 200 });
    } catch (error) {
      console.error("Error in ingestData:", error);
      return new Response(null, { status: 500 });
    } finally {
      await cleanup();
    }
  }
}
