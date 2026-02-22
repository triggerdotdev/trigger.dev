import { getGlobal, registerGlobal } from "../utils/globals.js";
import { NoopInputStreamManager } from "./noopManager.js";
import { InputStreamManager } from "./types.js";
import { InputStreamOnceOptions } from "../realtimeStreams/types.js";

const API_NAME = "input-streams";

const NOOP_MANAGER = new NoopInputStreamManager();

export class InputStreamsAPI implements InputStreamManager {
  private static _instance?: InputStreamsAPI;

  private constructor() {}

  public static getInstance(): InputStreamsAPI {
    if (!this._instance) {
      this._instance = new InputStreamsAPI();
    }

    return this._instance;
  }

  setGlobalManager(manager: InputStreamManager): boolean {
    return registerGlobal(API_NAME, manager);
  }

  #getManager(): InputStreamManager {
    return getGlobal(API_NAME) ?? NOOP_MANAGER;
  }

  public on(
    streamId: string,
    handler: (data: unknown) => void | Promise<void>
  ): { off: () => void } {
    return this.#getManager().on(streamId, handler);
  }

  public once(streamId: string, options?: InputStreamOnceOptions): Promise<unknown> {
    return this.#getManager().once(streamId, options);
  }

  public peek(streamId: string): unknown | undefined {
    return this.#getManager().peek(streamId);
  }

  public reset(): void {
    this.#getManager().reset();
  }

  public disconnect(): void {
    this.#getManager().disconnect();
  }

  public connectTail(runId: string, fromSeq?: number): void {
    this.#getManager().connectTail(runId, fromSeq);
  }
}
