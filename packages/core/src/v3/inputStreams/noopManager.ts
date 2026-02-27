import { InputStreamManager, InputStreamOncePromise } from "./types.js";
import { InputStreamOnceOptions } from "../realtimeStreams/types.js";

export class NoopInputStreamManager implements InputStreamManager {
  setRunId(_runId: string, _streamsVersion?: string): void {}

  on(_streamId: string, _handler: (data: unknown) => void | Promise<void>): { off: () => void } {
    return { off: () => {} };
  }

  once(_streamId: string, _options?: InputStreamOnceOptions): InputStreamOncePromise<unknown> {
    return new InputStreamOncePromise(() => {
      // Never resolves in noop mode
    });
  }

  peek(_streamId: string): unknown | undefined {
    return undefined;
  }

  lastSeqNum(_streamId: string): number | undefined {
    return undefined;
  }

  reset(): void {}
  disconnect(): void {}
  connectTail(_runId: string, _fromSeq?: number): void {}
}
