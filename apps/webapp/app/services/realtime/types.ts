// Interface for stream ingestion
export interface StreamIngestor {
  initializeStream(
    runId: string,
    streamId: string
  ): Promise<{ responseHeaders?: Record<string, string> }>;

  ingestData(
    stream: ReadableStream<Uint8Array>,
    runId: string,
    streamId: string,
    clientId: string,
    resumeFromChunk?: number
  ): Promise<Response>;

  getLastChunkIndex(runId: string, streamId: string, clientId: string): Promise<number>;
}

export type StreamResponseOptions = {
  timeoutInSeconds?: number;
  lastEventId?: string;
};

// Interface for stream response
export interface StreamResponder {
  streamResponse(
    request: Request,
    runId: string,
    streamId: string,
    signal: AbortSignal,
    options?: StreamResponseOptions
  ): Promise<Response>;
}
