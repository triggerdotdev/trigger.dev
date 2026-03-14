/**
 * TimerWheel implements a hashed timer wheel for efficiently managing large numbers
 * of delayed operations with O(1) submit, cancel, and per-item dispatch.
 *
 * Used by the supervisor to delay snapshot requests so that short-lived waitpoints
 * (e.g. triggerAndWait that resolves in <3s) skip the snapshot entirely.
 *
 * The wheel is a ring buffer of slots. A single setInterval advances a cursor.
 * When the cursor reaches a slot, all items in that slot are dispatched.
 *
 * Fixed capacity: 600 slots at 100ms tick = 60s max delay.
 */

const TICK_MS = 100;
const NUM_SLOTS = 600; // 60s max delay at 100ms tick

export type TimerWheelItem<T> = {
  key: string;
  data: T;
};

export type TimerWheelOptions<T> = {
  /** Called when an item's delay expires. */
  onExpire: (item: TimerWheelItem<T>) => void;
  /** Delay in milliseconds before items fire. Clamped to [100, 60000]. */
  delayMs: number;
};

type Entry<T> = {
  key: string;
  data: T;
  slotIndex: number;
};

export class TimerWheel<T> {
  private slots: Set<string>[];
  private entries: Map<string, Entry<T>>;
  private cursor: number;
  private intervalId: ReturnType<typeof setInterval> | null;
  private onExpire: (item: TimerWheelItem<T>) => void;
  private delaySlots: number;

  constructor(opts: TimerWheelOptions<T>) {
    this.slots = Array.from({ length: NUM_SLOTS }, () => new Set());
    this.entries = new Map();
    this.cursor = 0;
    this.intervalId = null;
    this.onExpire = opts.onExpire;
    this.delaySlots = Math.max(1, Math.min(NUM_SLOTS, Math.round(opts.delayMs / TICK_MS)));
  }

  /** Start the timer wheel. Must be called before submitting items. */
  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.tick(), TICK_MS);
    // Don't hold the process open just for the timer wheel
    if (this.intervalId && typeof this.intervalId === "object" && "unref" in this.intervalId) {
      this.intervalId.unref();
    }
  }

  /**
   * Stop the timer wheel and return all unprocessed items.
   * The wheel keeps running normally during graceful shutdown - call stop()
   * only when you're ready to tear down. Caller decides what to do with leftovers.
   */
  stop(): TimerWheelItem<T>[] {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    const remaining: TimerWheelItem<T>[] = [];
    for (const [key, entry] of this.entries) {
      remaining.push({ key, data: entry.data });
    }

    for (const slot of this.slots) {
      slot.clear();
    }
    this.entries.clear();

    return remaining;
  }

  /**
   * Update the delay for future submissions. Already-queued items keep their original timing.
   * Clamped to [TICK_MS, 60000ms].
   */
  setDelay(delayMs: number): void {
    this.delaySlots = Math.max(1, Math.min(NUM_SLOTS, Math.round(delayMs / TICK_MS)));
  }

  /**
   * Submit an item to be dispatched after the configured delay.
   * If an item with the same key already exists, it is replaced (dedup).
   * No-op if the wheel is stopped.
   */
  submit(key: string, data: T): void {
    if (!this.intervalId) return;

    // Dedup: remove existing entry for this key
    this.cancel(key);

    const slotIndex = (this.cursor + this.delaySlots) % NUM_SLOTS;
    const entry: Entry<T> = { key, data, slotIndex };

    this.entries.set(key, entry);
    this.slot(slotIndex).add(key);
  }

  /**
   * Cancel a pending item. Returns true if the item was found and removed.
   */
  cancel(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;

    this.slot(entry.slotIndex).delete(key);
    this.entries.delete(key);
    return true;
  }

  /** Number of pending items in the wheel. */
  get size(): number {
    return this.entries.size;
  }

  /** Whether the wheel is running. */
  get running(): boolean {
    return this.intervalId !== null;
  }

  /** Get a slot by index. The array is fully initialized so this always returns a Set. */
  private slot(index: number): Set<string> {
    const s = this.slots[index];
    if (!s) throw new Error(`TimerWheel: invalid slot index ${index}`);
    return s;
  }

  /** Advance the cursor and dispatch all items in the current slot. */
  private tick(): void {
    this.cursor = (this.cursor + 1) % NUM_SLOTS;
    const slot = this.slot(this.cursor);

    if (slot.size === 0) return;

    // Collect items to dispatch (copy keys since we mutate during iteration)
    const keys = [...slot];
    slot.clear();

    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;

      this.entries.delete(key);
      this.onExpire({ key, data: entry.data });
    }
  }
}
