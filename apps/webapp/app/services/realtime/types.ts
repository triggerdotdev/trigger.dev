export type StreamRecord = {
  data: string;
  id: string;
  seqNum: number;
  /**
   * S2 record headers, when the underlying backend is the v2 (S2) shape.
   * Undefined or empty for run-scoped Redis streams. First-header empty-name
   * is an S2 command record (trim/fence); the parser strips those before
   * surfacing the record, so callers never see them.
   */
  headers?: Array<[string, string]>;
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
   * if the last record is a terminal marker (a `trigger-control`
   * `turn-complete` control record, ignoring any trailing S2 trim
   * command record). Used by `TriggerChatTransport.reconnectToStream`
   * on page reload.
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
