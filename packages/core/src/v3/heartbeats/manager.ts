import { tryCatch } from "../tryCatch.js";
import { HeartbeatsManager } from "./types.js";
import { setInterval, setImmediate, setTimeout } from "node:timers/promises";

export class StandardHeartbeatsManager implements HeartbeatsManager {
  private listener: ((id: string) => Promise<void>) | undefined = undefined;
  private currentAbortController: AbortController | undefined = undefined;
  private lastHeartbeatYieldTime: number | undefined = undefined;
  private lastHeartbeatDate: Date | undefined = undefined;

  constructor(private readonly intervalInMs: number) {}

  registerListener(callback: (id: string) => Promise<void>) {
    this.listener = callback;
  }

  async yield(): Promise<void> {
    if (!this.lastHeartbeatYieldTime) {
      return;
    }

    // Only call setImmediate if we haven't yielded in the last interval
    if (Date.now() - this.lastHeartbeatYieldTime >= this.intervalInMs) {
      // await setImmediate();
      await setTimeout(24);

      this.lastHeartbeatYieldTime = Date.now();
    }
  }

  startHeartbeat(id: string) {
    this.currentAbortController = new AbortController();
    this.lastHeartbeatYieldTime = Date.now();

    // Ignore errors as we expect them to be thrown when the heartbeat is stopped
    this.startHeartbeatLoop(id, this.currentAbortController.signal).catch((error) => {});
  }

  private async startHeartbeatLoop(id: string, signal: AbortSignal) {
    try {
      for await (const _ of setInterval(this.intervalInMs, undefined, {
        signal,
      })) {
        if (this.listener) {
          const [error] = await tryCatch(this.listener(id));
          this.lastHeartbeatDate = new Date();

          if (error) {
            console.error("Failed to send HEARTBEAT message", { error: String(error) });
          }
        }
      }
    } catch (error) {
      // Ignore errors as we expect them to be thrown when the heartbeat is stopped
      // And since we tryCatch inside the loop, we don't need to handle any other errors here
    }
  }

  stopHeartbeat(): void {
    this.currentAbortController?.abort();
  }

  get lastHeartbeat(): Date | undefined {
    return this.lastHeartbeatDate;
  }

  reset() {
    this.stopHeartbeat();
    this.lastHeartbeatDate = undefined;
    this.lastHeartbeatYieldTime = undefined;
    this.currentAbortController = undefined;

    // NOTE: Don't reset the listener, it's really just a single global callback,
    // but because of the structure of the dev/managed-run-worker and the ZodIpc constructor,
    // we have to create the StandardHeartbeatsManager instance before the ZodIpc instance is created.
  }
}
