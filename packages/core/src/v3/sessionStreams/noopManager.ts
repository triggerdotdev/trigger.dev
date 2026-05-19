import { InputStreamOnceOptions } from "../realtimeStreams/types.js";
import { InputStreamOncePromise } from "../inputStreams/types.js";
import { SessionChannelIO, SessionStreamManager } from "./types.js";

export class NoopSessionStreamManager implements SessionStreamManager {
  on(
    _sessionId: string,
    _io: SessionChannelIO,
    _handler: (data: unknown) => void | Promise<void>
  ): { off: () => void } {
    return { off: () => {} };
  }

  once(
    _sessionId: string,
    _io: SessionChannelIO,
    _options?: InputStreamOnceOptions
  ): InputStreamOncePromise<unknown> {
    return new InputStreamOncePromise(() => {
      // Never resolves in noop mode.
    });
  }

  peek(_sessionId: string, _io: SessionChannelIO): unknown | undefined {
    return undefined;
  }

  lastSeqNum(_sessionId: string, _io: SessionChannelIO): number | undefined {
    return undefined;
  }

  setLastSeqNum(_sessionId: string, _io: SessionChannelIO, _seqNum: number): void {}

  lastDispatchedSeqNum(_sessionId: string, _io: SessionChannelIO): number | undefined {
    return undefined;
  }

  setLastDispatchedSeqNum(
    _sessionId: string,
    _io: SessionChannelIO,
    _seqNum: number
  ): void {}

  setMinTimestamp(
    _sessionId: string,
    _io: SessionChannelIO,
    _minTimestamp: number | undefined
  ): void {}

  shiftBuffer(_sessionId: string, _io: SessionChannelIO): boolean {
    return false;
  }

  disconnectStream(_sessionId: string, _io: SessionChannelIO): void {}

  clearHandlers(): void {}

  reset(): void {}

  disconnect(): void {}
}
