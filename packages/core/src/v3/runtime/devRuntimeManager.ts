import { RuntimeManager } from "./manager";

export class DevRuntimeManager implements RuntimeManager {
  disable(): void {
    // do nothing
  }

  async waitUntil(date: Date): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, date.getTime() - Date.now());
    });
  }
}
