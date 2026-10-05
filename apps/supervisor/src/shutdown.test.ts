import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { installShutdown } from "./shutdown.js";

const signals = ["SIGTERM", "SIGINT"] as const;

describe("installShutdown", () => {
  const logger = new SimpleStructuredLogger("shutdown-test");
  let exit: ReturnType<typeof vi.spyOn>;
  let before: Map<string, Function[]>;

  beforeEach(() => {
    exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    before = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
  });

  afterEach(() => {
    exit.mockRestore();
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!before.get(signal)!.includes(listener)) {
          process.off(signal, listener);
        }
      }
    }
  });

  it("stops once on SIGTERM, then exits with the signal's code", async () => {
    const stop = vi.fn(async () => {});
    installShutdown({ stop, timeoutMs: 1_000, logger });

    process.emit("SIGTERM");
    process.emit("SIGINT");
    process.emit("SIGTERM");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("stops on SIGINT too", async () => {
    const stop = vi.fn(async () => {});
    installShutdown({ stop, timeoutMs: 1_000, logger });

    process.emit("SIGINT");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("exits once the timeout passes when stop hangs", async () => {
    const stop = vi.fn(() => new Promise<void>(() => {}));
    installShutdown({ stop, timeoutMs: 20, logger });

    process.emit("SIGTERM");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("exits when stop fails", async () => {
    const stop = vi.fn(async () => {
      throw new Error("redis quit failed");
    });
    installShutdown({ stop, timeoutMs: 1_000, logger });

    process.emit("SIGTERM");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
  });
});
