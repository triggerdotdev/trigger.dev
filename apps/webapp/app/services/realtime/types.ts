import { AuthenticatedEnvironment } from "../apiAuth.server";

// Interface for stream ingestion
export interface StreamIngestor {
  ingestData(
    stream: ReadableStream<Uint8Array>,
    runId: string,
    streamId: string,
    resumeFromChunk?: number
  ): Promise<Response>;

  getLastChunkIndex(runId: string, streamId: string): Promise<number>;
}

// Interface for stream response
export interface StreamResponder {
  streamResponse(
    request: Request,
    runId: string,
    streamId: string,
    environment: AuthenticatedEnvironment,
    signal: AbortSignal
  ): Promise<Response>;
}
