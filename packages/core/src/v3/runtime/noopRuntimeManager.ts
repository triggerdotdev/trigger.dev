import { RuntimeManager } from "./manager";

export class NoopRuntimeManager implements RuntimeManager {
  disable(): void {
    // do nothing
  }

  waitUntil(date: Date): Promise<void> {
    return Promise.resolve();
  }
}
