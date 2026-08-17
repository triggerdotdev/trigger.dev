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
    handler: (data: unknown) => void | boolean | Promise<void>
  ): { off: () => void } {
    return this.#getManager().on(sessionId, io, handler);
  }

  public once(
    sessionId: string,
    io: SessionChannelIO,
    options?: InputStreamOnceOptions
  ): InputStreamOncePromise<unknown> {
    return this.#getManager().once(sessionId, io, options);
  }

  public onceRecord(
    sessionId: string,
    io: SessionChannelIO,
    options?: InputStreamOnceOptions
  ): InputStreamOncePromise<SessionStreamRecord> {
    const manager = this.#getManager();
    if (!manager.onceRecord) {
      throw new Error("The configured Session stream manager does not support record metadata");
    }
    return manager.onceRecord(sessionId, io, options);
  }

  public onceRecordWhere(
    sessionId: string,
    io: SessionChannelIO,
    predicate: SessionStreamRecordPredicate,
    options?: InputStreamOnceOptions
  ): InputStreamOncePromise<SessionStreamRecord> {
    const manager = this.#getManager();
    if (!manager.onceRecordWhere) {
      throw new Error("The configured Session stream manager does not support selective records");
    }
    return manager.onceRecordWhere(sessionId, io, predicate, options);
  }

  public peek(sessionId: string, io: SessionChannelIO): unknown | undefined {
    return this.#getManager().peek(sessionId, io);
  }

  public peekRecord(sessionId: string, io: SessionChannelIO): SessionStreamRecord | undefined {
    const manager = this.#getManager();
    if (!manager.peekRecord) {
      throw new Error("The configured Session stream manager does not support record metadata");
    }
    return manager.peekRecord(sessionId, io);
  }

  public peekRecordWhere(
    sessionId: string,
    io: SessionChannelIO,
    predicate: SessionStreamRecordPredicate
  ): SessionStreamRecord | undefined {
    const manager = this.#getManager();
    if (!manager.peekRecordWhere) {
      throw new Error("The configured Session stream manager does not support selective records");
    }
    return manager.peekRecordWhere(sessionId, io, predicate);
  }

  public lastSeqNum(sessionId: string, io: SessionChannelIO): number | undefined {
    return this.#getManager().lastSeqNum(sessionId, io);
  }

  public setLastSeqNum(sessionId: string, io: SessionChannelIO, seqNum: number): void {
    this.#getManager().setLastSeqNum(sessionId, io, seqNum);
  }

  public lastDispatchedSeqNum(sessionId: string, io: SessionChannelIO): number | undefined {
    return this.#getManager().lastDispatchedSeqNum(sessionId, io);
  }

  public setLastDispatchedSeqNum(sessionId: string, io: SessionChannelIO, seqNum: number): void {
    this.#getManager().setLastDispatchedSeqNum(sessionId, io, seqNum);
  }

  public setMinTimestamp(
    sessionId: string,
    io: SessionChannelIO,
    minTimestamp: number | undefined
  ): void {
    this.#getManager().setMinTimestamp(sessionId, io, minTimestamp);
  }

  public shiftBuffer(sessionId: string, io: SessionChannelIO): boolean {
    return this.#getManager().shiftBuffer(sessionId, io);
  }

  public disconnectStream(sessionId: string, io: SessionChannelIO): void {
    this.#getManager().disconnectStream(sessionId, io);
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
