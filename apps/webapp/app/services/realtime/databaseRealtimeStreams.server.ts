import { PrismaClient } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { logger } from "../logger.server";
import { RealtimeClient } from "../realtimeClient.server";
import { StreamIngestor, StreamResponder } from "./types";

export type DatabaseRealtimeStreamsOptions = {
  prisma: PrismaClient;
  realtimeClient: RealtimeClient;
};

// Class implementing both interfaces
export class DatabaseRealtimeStreams implements StreamIngestor, StreamResponder {
  constructor(private options: DatabaseRealtimeStreamsOptions) {}

  async streamResponse(
    request: Request,
    runId: string,
    streamId: string,
    environment: AuthenticatedEnvironment,
    signal: AbortSignal
  ): Promise<Response> {
    return this.options.realtimeClient.streamChunks(
      request.url,
      environment,
      runId,
      streamId,
      signal,
      request.headers.get("x-trigger-electric-version") ?? undefined
    );
  }

  async ingestData(
    stream: ReadableStream<Uint8Array>,
    runId: string,
    streamId: string
  ): Promise<Response> {
    try {
      const textStream = stream.pipeThrough(new TextDecoderStream());
      const reader = textStream.getReader();
      let sequence = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        logger.debug("[DatabaseRealtimeStreams][ingestData] Reading data", {
          streamId,
          runId,
          value,
        });

        const chunks = value
          .split("\n")
          .filter((chunk) => chunk) // Remove empty lines
          .map((line) => {
            return {
              sequence: sequence++,
              value: line,
            };
          });

        await this.options.prisma.realtimeStreamChunk.createMany({
          data: chunks.map((chunk) => {
            return {
              runId,
              key: streamId,
              sequence: chunk.sequence,
              value: chunk.value,
            };
          }),
        });
      }

      return new Response(null, { status: 200 });
    } catch (error) {
      logger.error("[DatabaseRealtimeStreams][ingestData] Error in ingestData:", { error });

      return new Response(null, { status: 500 });
    }
  }
}
