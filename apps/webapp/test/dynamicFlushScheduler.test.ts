import { describe, it, expect } from "vitest";
import { DynamicFlushScheduler } from "../app/v3/dynamicFlushScheduler.server";

describe("DynamicFlushScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.resetAllMocks();
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

  it("calls callback once with batchSize items", async () => {
    const callback = vi.fn();
    const dynamicFlushScheduler = new DynamicFlushScheduler({
      batchSize: 3,
      flushInterval: 5000,
      callback,
    });
    const items = [1, 2, 3];
    await dynamicFlushScheduler.addToBatch(items);

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
      flushInterval: 10000,
      callback,
    });
    const items = [1, 2, 3, 4, 5, 6];
    await dynamicFlushScheduler.addToBatch(items);

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1, expect.any(String), [1, 2, 3]);
    expect(callback).toHaveBeenNthCalledWith(2, expect.any(String), [4, 5, 6]);
  });

  it("handles SIGTERM signal correctly", async () => {
    const callback = vi.fn();

    const processOnMock = vi.fn();
    process.on = processOnMock;

    const dynamicFlushScheduler = new DynamicFlushScheduler({
      batchSize: 10,
      flushInterval: 5000,
      callback,
    });

    const items = [1, 2, 3, 4, 5, 6];
    await dynamicFlushScheduler.addToBatch(items);

    const sigtermHandler = processOnMock.mock.calls.find((call) => call[0] === "SIGTERM")[1];

    await sigtermHandler();

    expect(callback).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(expect.any(String), items);
  });
});
