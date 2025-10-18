import { AuthenticatedEnvironment } from "../apiAuth.server";

// Interface for stream ingestion
export interface StreamIngestor {
  ingestData(
    stream: ReadableStream<Uint8Array>,
    runId: string,
    streamId: string,
    clientId: string,
    resumeFromChunk?: number
  ): Promise<Response>;

  getLastChunkIndex(runId: string, streamId: string, clientId: string): Promise<number>;
}

// Interface for stream response
export interface StreamResponder {
  streamResponse(
    request: Request,
    runId: string,
    streamId: string,
    signal: AbortSignal,
    lastEventId?: string
  ): Promise<Response>;
}
