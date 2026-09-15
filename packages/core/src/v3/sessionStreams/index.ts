import { getGlobal, registerGlobal } from "../utils/globals.js";
import { NoopSessionStreamManager } from "./noopManager.js";
import type {
  InputStreamOncePromise,
  SessionChannelIO,
  SessionStreamManager,
  SessionStreamRecord,
  SessionStreamRecordPredicate,
} from "./types.js";
import type { InputStreamOnceOptions } from "../realtimeStreams/types.js";

const API_NAME = "session-streams";

const NOOP_MANAGER = new NoopSessionStreamManager();

export class SessionStreamsAPI implements SessionStreamManager {
  private static _instance?: SessionStreamsAPI;

  private constructor() {}

  public static getInstance(): SessionStreamsAPI {
    if (!this._instance) {
      this._instance = new SessionStreamsAPI();
    }
    return this._instance;
  }

  setGlobalManager(manager: SessionStreamManager): boolean {
    return registerGlobal(API_NAME, manager);
  }

  #getManager(): SessionStreamManager {
    return getGlobal(API_NAME) ?? NOOP_MANAGER;
  }

  public on(
    sessionId: string,
    io: SessionChannelIO,
    handler: (data: unknown) => void | boolean | Promise<void>,
    channel?: string
  ): { off: () => void } {
    return this.#getManager().on(sessionId, io, handler, channel);
  }

  public onRecord(
    sessionId: string,
    io: SessionChannelIO,
    handler: (record: SessionStreamRecord) => void | boolean | Promise<void>,
    channel?: string
  ): { off: () => void } {
    const manager = this.#getManager();
    if (!manager.onRecord) {
      throw new Error("The configured Session stream manager does not support record handlers");
    }
    return manager.onRecord(sessionId, io, handler, channel);
  }

  public once(
    sessionId: string,
    io: SessionChannelIO,
    options?: InputStreamOnceOptions,
    channel?: string
  ): InputStreamOncePromise<unknown> {
    return this.#getManager().once(sessionId, io, options, channel);
  }

  public onceRecord(
    sessionId: string,
    io: SessionChannelIO,
    options?: InputStreamOnceOptions,
    channel?: string
  ): InputStreamOncePromise<SessionStreamRecord> {
    const manager = this.#getManager();
    if (!manager.onceRecord) {
      throw new Error("The configured Session stream manager does not support record metadata");
    }
    return manager.onceRecord(sessionId, io, options, channel);
  }

  public onceRecordWhere(
    sessionId: string,
    io: SessionChannelIO,
    predicate: SessionStreamRecordPredicate,
    options?: InputStreamOnceOptions,
    channel?: string
  ): InputStreamOncePromise<SessionStreamRecord> {
    const manager = this.#getManager();
    if (!manager.onceRecordWhere) {
      throw new Error("The configured Session stream manager does not support selective records");
    }
    return manager.onceRecordWhere(sessionId, io, predicate, options, channel);
  }

  public peek(sessionId: string, io: SessionChannelIO, channel?: string): unknown | undefined {
    return this.#getManager().peek(sessionId, io, channel);
  }

  public peekRecord(
    sessionId: string,
    io: SessionChannelIO,
    channel?: string
  ): SessionStreamRecord | undefined {
    const manager = this.#getManager();
    if (!manager.peekRecord) {
      throw new Error("The configured Session stream manager does not support record metadata");
    }
    return manager.peekRecord(sessionId, io, channel);
  }

  public lastSeqNum(sessionId: string, io: SessionChannelIO, channel?: string): number | undefined {
    return this.#getManager().lastSeqNum(sessionId, io, channel);
  }

  public setLastSeqNum(
    sessionId: string,
    io: SessionChannelIO,
    seqNum: number,
    channel?: string
  ): void {
    this.#getManager().setLastSeqNum(sessionId, io, seqNum, channel);
  }

  public consumeRecord(
    sessionId: string,
    io: SessionChannelIO,
    seqNum: number,
    channel?: string
  ): void {
    const manager = this.#getManager();
    if (!manager.consumeRecord) {
      throw new Error("The configured Session stream manager does not support exact consumption");
    }
    manager.consumeRecord(sessionId, io, seqNum, channel);
  }

  public lastDispatchedSeqNum(
    sessionId: string,
    io: SessionChannelIO,
    channel?: string
  ): number | undefined {
    return this.#getManager().lastDispatchedSeqNum(sessionId, io, channel);
  }

  public setLastDispatchedSeqNum(
    sessionId: string,
    io: SessionChannelIO,
    seqNum: number,
    channel?: string
  ): void {
    this.#getManager().setLastDispatchedSeqNum(sessionId, io, seqNum, channel);
  }

  public setMinTimestamp(
    sessionId: string,
    io: SessionChannelIO,
    minTimestamp: number | undefined,
    channel?: string
  ): void {
    this.#getManager().setMinTimestamp(sessionId, io, minTimestamp, channel);
  }

  public shiftBuffer(sessionId: string, io: SessionChannelIO, channel?: string): boolean {
    return this.#getManager().shiftBuffer(sessionId, io, channel);
  }

  public reconnectStream(sessionId: string, io: SessionChannelIO, channel?: string): void {
    this.#getManager().reconnectStream?.(sessionId, io, channel);
  }

  public disconnectStream(sessionId: string, io: SessionChannelIO, channel?: string): void {
    this.#getManager().disconnectStream(sessionId, io, channel);
  }

  public clearHandlers(): void {
    this.#getManager().clearHandlers();
  }

  public reset(): void {
    this.#getManager().reset();
  }

  public disconnect(): void {
    this.#getManager().disconnect();
  }
}
