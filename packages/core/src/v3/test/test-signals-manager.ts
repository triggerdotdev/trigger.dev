import { StandardSignalsManager } from "../signals/manager.js";
import { signalEntryKey, type SignalEntry } from "../signals/types.js";

/** A manager for tests: no subscription; `send` applies a record as the stream would. */
export class TestSignalsManager extends StandardSignalsManager {
  #seq = 0;
  #latest = new Map<string, SignalEntry>();

  constructor(currentTaskId: () => string | undefined) {
    super(undefined as never, "", currentTaskId);
  }

  protected override subscribes(): boolean {
    return false;
  }

  /** @internal Send a signal to this process's listeners as the server would. */
  __sendFromTest(name: string, payload: unknown, options?: { task?: string }): void {
    const seq = this.#seq++;
    const entry: SignalEntry = {
      name,
      ...(options?.task !== undefined ? { task: options.task } : {}),
      payload,
      sentAt: new Date().toISOString(),
      seq,
      id: `test-${seq}`,
    };
    this.#latest.set(signalEntryKey(entry), entry);
    this.applyRecord({ name, latest: [...this.#latest.values()] }, seq);
  }
}
