import { InputStreamManager } from "./types.js";
import { InputStreamOnceOptions } from "../realtimeStreams/types.js";

export class NoopInputStreamManager implements InputStreamManager {
  on(_streamId: string, _handler: (data: unknown) => void | Promise<void>): { off: () => void } {
    return { off: () => {} };
  }

  once(_streamId: string, _options?: InputStreamOnceOptions): Promise<unknown> {
    return new Promise(() => {
      // Never resolves in noop mode
    });
  }

  peek(_streamId: string): unknown | undefined {
    return undefined;
  }

  reset(): void {}
  disconnect(): void {}
  connectTail(_runId: string, _fromSeq?: number): void {}
}
