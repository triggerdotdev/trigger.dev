import Redis, { RedisOptions } from "ioredis";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { logger } from "../logger.server";
import { StreamIngestor, StreamResponder } from "./types";
import { LineTransformStream } from "./utils.server";
import { env } from "~/env.server";

export type RealtimeStreamsOptions = {
  redis: RedisOptions | undefined;
};

const END_SENTINEL = "<<CLOSE_STREAM>>";

// Class implementing both interfaces
export class RedisRealtimeStreams implements StreamIngestor, StreamResponder {
  constructor(private options: RealtimeStreamsOptions) {}

  async streamResponse(
    request: Request,
    runId: string,
    streamId: string,
    environment: AuthenticatedEnvironment,
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
                    controller.enqueue(fields[1]);

                    if (signal.aborted) {
                      controller.close();
                      return;
                    }
                  }
                }
              }
            } catch (error) {
              if (signal.aborted) break;

              logger.error("[RealtimeStreams][streamResponse] Error reading from Redis stream:", {
                error,
              });
              retryCount++;
              if (retryCount >= maxRetries) throw error;
              await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount));
            }
          }
        } catch (error) {
          logger.error("[RealtimeStreams][streamResponse] Fatal error in stream processing:", {
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
    streamId: string
  ): Promise<Response> {
    const redis = new Redis(this.options.redis ?? {});
    const streamKey = `stream:${runId}:${streamId}`;

    async function cleanup() {
      try {
        await redis.quit();
      } catch (error) {
        logger.error("[RedisRealtimeStreams][ingestData] Error in cleanup:", { error });
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

        logger.debug("[RedisRealtimeStreams][ingestData] Reading data", {
          streamKey,
          runId,
          value,
        });

        await redis.xadd(
          streamKey,
          "MAXLEN",
          "~",
          String(env.REALTIME_STREAM_MAX_LENGTH),
          "*",
          "data",
          value
        );
      }

      // Send the END_SENTINEL and set TTL with a pipeline.
      const pipeline = redis.pipeline();
      pipeline.xadd(
        streamKey,
        "MAXLEN",
        "~",
        String(env.REALTIME_STREAM_MAX_LENGTH),
        "*",
        "data",
        END_SENTINEL
      );
      pipeline.expire(streamKey, env.REALTIME_STREAM_TTL);
      await pipeline.exec();

      return new Response(null, { status: 200 });
    } catch (error) {
      logger.error("[RealtimeStreams][ingestData] Error in ingestData:", { error });

      return new Response(null, { status: 500 });
    } finally {
      await cleanup();
    }
  }
}
