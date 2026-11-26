import type { SignalHandler, SignalsManager } from "./types.js";

export class NoopSignalsManager implements SignalsManager {
  on(_name: string, _handler: SignalHandler): () => void {
    return () => {};
  }

  reset(): void {}
}
