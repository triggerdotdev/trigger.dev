import { describe, it, expect } from "vitest";
import { DynamicFlushScheduler } from "../app/v3/dynamicFlushScheduler.server";

describe("DynamicFlushScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("doesn't call callback when there are no items", () => {
    const callback = vi.fn();
    const dynamicFlushScheduler = new DynamicFlushScheduler({
      batchSize: 3,
      flushInterval: 5000,
      callback,
    });
    dynamicFlushScheduler.addToBatch([]);

    expect(callback).toBeCalledTimes(0);
  });

  it("calls callback once with batchSize items", () => {
    const callback = vi.fn();
    const dynamicFlushScheduler = new DynamicFlushScheduler({
      batchSize: 3,
      flushInterval: 5000,
      callback,
    });
    const items = [1, 2, 3];
    dynamicFlushScheduler.addToBatch(items);

    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith(expect.any(String), [1, 2, 3]);
  });

  it("calls callback when flush interval is reached", async () => {
    const callback = vi.fn();
    const dynamicFlushScheduler = new DynamicFlushScheduler({
      batchSize: 100,
      flushInterval: 3000,
      callback,
    });
    const items = [1, 2, 3, 4, 5];
    dynamicFlushScheduler.addToBatch(items);

    await vi.advanceTimersByTimeAsync(3000);

    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith(expect.any(String), [1, 2, 3, 4, 5]);
  });

  it("calls callback multiple times with the correct batch size", async () => {
    const callback = vi.fn();
    const dynamicFlushScheduler = new DynamicFlushScheduler({
      batchSize: 3,
      flushInterval: 3000,
      callback,
    });
    const items = [1, 2, 3, 4, 5, 6];
    dynamicFlushScheduler.addToBatch(items);

    await vi.advanceTimersByTimeAsync(100); // we need to wait for the async callback to complete);

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1, expect.any(String), [1, 2, 3]);
    expect(callback).toHaveBeenNthCalledWith(2, expect.any(String), [4, 5, 6]);
  });
});
