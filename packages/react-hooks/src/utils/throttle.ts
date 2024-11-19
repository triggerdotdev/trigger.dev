// Reusable throttle utility
export type ThrottledQueue<T> = {
  add: (item: T) => void;
  flush: () => Promise<void>;
  isEmpty: () => boolean;
};

export function createThrottledQueue<T>(
  onFlush: (items: T[]) => Promise<void>,
  throttleInMs?: number
): ThrottledQueue<T> {
  let queue: T[] = [];
  let lastFlushTime = 0;
  let flushPromise: Promise<void> | null = null;

  const scheduleFlush = async () => {
    // If no throttle specified or there's already a flush in progress, return
    if (!throttleInMs) {
      // Immediately flush when no throttling is specified
      const itemsToFlush = [...queue];
      queue = [];
      await onFlush(itemsToFlush);
      return;
    }

    if (queue.length === 0 || flushPromise) return;

    const now = Date.now();
    const timeUntilNextFlush = Math.max(0, lastFlushTime + throttleInMs - now);

    if (timeUntilNextFlush === 0) {
      const itemsToFlush = [...queue];
      queue = [];
      lastFlushTime = now;
      flushPromise = onFlush(itemsToFlush).finally(() => {
        flushPromise = null;
        // Check if more items accumulated during flush
        scheduleFlush();
      });
    } else {
      setTimeout(scheduleFlush, timeUntilNextFlush);
    }
  };

  return {
    add: (item: T) => {
      queue.push(item);
      scheduleFlush();
    },
    flush: async () => {
      if (queue.length === 0) return;
      const itemsToFlush = [...queue];
      queue = [];
      await onFlush(itemsToFlush);
    },
    isEmpty: () => queue.length === 0,
  };
}
