import { describe, expect, it } from "vitest";
import { createAsyncIterableReadable, type AsyncIterableStream } from "./asyncIterableStream.js";

const identity: Transformer<number, number> = {
  transform(chunk, controller) {
    controller.enqueue(chunk);
  },
};

// Emits 1, 2, 3, ... every `intervalMs` until cancelled
function tickingSource(intervalMs = 5) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<number>({
    start(controller) {
      let i = 0;
      timer = setInterval(() => controller.enqueue(++i), intervalMs);
    },
    cancel() {
      cancelled = true;
      clearInterval(timer);
    },
  });
  return { stream, isCancelled: () => cancelled };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

async function collect<T>(stream: AsyncIterableStream<T>) {
  const values: T[] = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
}

describe("createAsyncIterableReadable", () => {
  it("passes chunks through and closes when the source ends", async () => {
    const source = new ReadableStream<number>({
      start(controller) {
        [1, 2, 3].forEach((n) => controller.enqueue(n));
        controller.close();
      },
    });

    const stream = createAsyncIterableReadable(source, identity, new AbortController().signal);

    expect(await collect(stream)).toEqual([1, 2, 3]);
  });

  it("surfaces a source error to the consumer", async () => {
    const source = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.error(new Error("boom"));
      },
    });

    const stream = createAsyncIterableReadable(source, identity, new AbortController().signal);

    await expect(collect(stream)).rejects.toThrow("boom");
  });

  it("does not throw when aborted after the consumer breaks", async () => {
    const abortController = new AbortController();
    let cancels = 0;
    const onCancel = () => cancels++;
    const { stream: source, isCancelled } = tickingSource();

    const stream = createAsyncIterableReadable(source, identity, abortController.signal, onCancel);

    for await (const value of stream) {
      expect(value).toBe(1);
      break;
    }

    abortController.abort();
    await flush();

    expect(cancels).toBe(1);
    expect(isCancelled()).toBe(true);
  });

  it("does not throw when aborted after the source errored", async () => {
    const abortController = new AbortController();
    const source = new ReadableStream<number>({
      start(controller) {
        controller.error(new Error("boom"));
      },
    });

    const stream = createAsyncIterableReadable(source, identity, abortController.signal);
    await expect(collect(stream)).rejects.toThrow("boom");

    abortController.abort();
    await flush();
  });

  it("does not throw when aborted after the source ended", async () => {
    const abortController = new AbortController();
    const source = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.close();
      },
    });

    const stream = createAsyncIterableReadable(source, identity, abortController.signal);
    expect(await collect(stream)).toEqual([1]);

    abortController.abort();
    await flush();
  });

  it("closes cleanly when aborted with chunks still buffered", async () => {
    const abortController = new AbortController();
    const { stream: source, isCancelled } = tickingSource(1);

    const stream = createAsyncIterableReadable(source, identity, abortController.signal);

    const values: number[] = [];
    for await (const value of stream) {
      values.push(value);
      if (values.length === 3) abortController.abort();
    }
    await flush();

    expect(values.slice(0, 3)).toEqual([1, 2, 3]);
    expect(isCancelled()).toBe(true);
  });

  it("closes immediately when the signal is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const { stream: source, isCancelled } = tickingSource();

    const stream = createAsyncIterableReadable(source, identity, abortController.signal);

    expect(await collect(stream)).toEqual([]);
    expect(isCancelled()).toBe(true);
  });

  it("calls onCancel when the consumer breaks without aborting", async () => {
    let cancels = 0;
    const onCancel = () => cancels++;
    const { stream: source, isCancelled } = tickingSource();

    const stream = createAsyncIterableReadable(
      source,
      identity,
      new AbortController().signal,
      onCancel
    );

    for await (const _ of stream) {
      break;
    }
    await flush();

    expect(cancels).toBe(1);
    expect(isCancelled()).toBe(true);
  });
});
