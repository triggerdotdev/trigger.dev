export type StreamRecord = {
  data: string;
  id: string;
  seqNum: number;
};

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

  appendPart(part: string, partId: string, runId: string, streamId: string): Promise<void>;

  getLastChunkIndex(runId: string, streamId: string, clientId: string): Promise<number>;

  /**
   * Read records from a stream starting after a given sequence number.
   * Returns immediately with whatever records exist (non-blocking).
   * Not all backends support this — returns undefined if unsupported.
   */
  readRecords?(
    runId: string,
    streamId: string,
    afterSeqNum?: number
  ): Promise<StreamRecord[] | undefined>;
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
