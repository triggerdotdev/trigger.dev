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

  readRecords(
    runId: string,
    streamId: string,
    afterSeqNum?: number
  ): Promise<StreamRecord[]>;
}

export type StreamResponseOptions = {
  timeoutInSeconds?: number;
  lastEventId?: string;
  /**
   * Session-stream-only. When `true`, the responder MAY peek the tail
   * of `.out` and short-circuit to `wait=0` + `X-Session-Settled: true`
   * if the last chunk is a terminal marker (e.g. `trigger:turn-complete`).
   * Used by `TriggerChatTransport.reconnectToStream` on page reload.
   *
   * When absent/false, the responder keeps the unconditional long-poll
   * behavior — required on the active send-a-message path where the
   * peek would race the newly-triggered turn's first chunk.
   */
  peekSettled?: boolean;
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
