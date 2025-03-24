import { describe, test, expect, vi, beforeEach } from "vitest";
import { ShutdownManager } from "./shutdownManager.js";

describe("ShutdownManager", { concurrent: false }, () => {
  // Mock process.exit to prevent actual exit
  const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("should successfully register a new handler", () => {
    const manager = new ShutdownManager(false);

    const handler = vi.fn();
    manager.register("test-handler", handler);

    expect(manager._getHandlersForTesting().has("test-handler")).toBe(true);
    const registeredHandler = manager._getHandlersForTesting().get("test-handler");
    expect(registeredHandler?.handler).toBe(handler);
    expect(registeredHandler?.signals).toEqual(["SIGTERM", "SIGINT"]);
  });

  test("should throw error when registering duplicate handler name", () => {
    const manager = new ShutdownManager(false);

    const handler = vi.fn();
    manager.register("duplicate-handler", handler);

    expect(() => {
      manager.register("duplicate-handler", handler);
    }).toThrow('Shutdown handler "duplicate-handler" already registered');
  });

  test("should register handler with custom signals", () => {
    const manager = new ShutdownManager(false);

    const handler = vi.fn();
    manager.register("custom-signals", handler, ["SIGTERM"]);

    const registeredHandler = manager._getHandlersForTesting().get("custom-signals");
    expect(registeredHandler?.signals).toEqual(["SIGTERM"]);
  });

  test("should call registered handlers when shutdown is triggered", async () => {
    const manager = new ShutdownManager(false);

    const handler1 = vi.fn();
    const handler2 = vi.fn();

    manager.register("handler1", handler1);
    manager.register("handler2", handler2);

    await manager.shutdown("SIGTERM");

    expect(handler1).toHaveBeenCalledWith("SIGTERM");
    expect(handler2).toHaveBeenCalledWith("SIGTERM");
    expect(mockExit).toHaveBeenCalledWith(128 + 15); // SIGTERM number
  });

  test("should only call handlers registered for specific signal", async () => {
    const manager = new ShutdownManager(false);

    const handler1 = vi.fn();
    const handler2 = vi.fn();

    manager.register("handler1", handler1, ["SIGTERM"]);
    manager.register("handler2", handler2, ["SIGINT"]);

    await manager.shutdown("SIGTERM");

    expect(handler1).toHaveBeenCalledWith("SIGTERM");
    expect(handler2).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(128 + 15);
  });

  test("should handle errors in shutdown handlers gracefully", async () => {
    const manager = new ShutdownManager(false);

    const successHandler = vi.fn();
    const errorHandler = vi.fn().mockRejectedValue(new Error("Handler failed"));

    manager.register("success-handler", successHandler);
    manager.register("error-handler", errorHandler);

    await manager.shutdown("SIGTERM");

    expect(successHandler).toHaveBeenCalledWith("SIGTERM");
    expect(errorHandler).toHaveBeenCalledWith("SIGTERM");
    expect(mockExit).toHaveBeenCalledWith(128 + 15);
  });

  test("should only run shutdown sequence once even if called multiple times", async () => {
    const manager = new ShutdownManager(false);

    const handler = vi.fn();
    manager.register("test-handler", handler);

    await Promise.all([manager.shutdown("SIGTERM"), manager.shutdown("SIGTERM")]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(128 + 15);
  });

  test("should exit with correct signal number on SIGINT", async () => {
    const manager = new ShutdownManager(false);

    manager.register("test-handler", vi.fn());

    await manager.shutdown("SIGINT");
    expect(mockExit).toHaveBeenCalledWith(128 + 2); // SIGINT number
  });

  test("should exit with correct signal number on SIGTERM", async () => {
    const manager = new ShutdownManager(false);

    manager.register("test-handler", vi.fn());

    await manager.shutdown("SIGTERM");
    expect(mockExit).toHaveBeenCalledWith(128 + 15); // SIGTERM number
  });

  test("should only exit after all handlers have finished", async () => {
    const sequence: string[] = [];
    const manager = new ShutdownManager(false);

    const handler1 = vi.fn().mockImplementation(async () => {
      sequence.push("handler1 start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      sequence.push("handler1 end");
    });

    const handler2 = vi.fn().mockImplementation(async () => {
      sequence.push("handler2 start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      sequence.push("handler2 end");
    });

    const handler3 = vi.fn().mockImplementation(async () => {
      sequence.push("handler3 start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      sequence.push("handler3 end");
    });

    // Store the current mock implementation
    const currentExit = mockExit.getMockImplementation();

    // Override with our sequence-tracking implementation
    mockExit.mockImplementation((code?: number | string | null) => {
      sequence.push("exit");
      return undefined as never;
    });

    manager.register("handler1", handler1);
    manager.register("handler2", handler2);
    manager.register("handler3", handler3);

    await manager.shutdown("SIGTERM");

    // Verify the execution order
    expect(sequence).toEqual([
      "handler1 start",
      "handler2 start",
      "handler3 start",
      "handler3 end",
      "handler1 end",
      "handler2 end",
      "exit",
    ]);

    // Verify the handlers were called with correct arguments
    expect(handler1).toHaveBeenCalledWith("SIGTERM");
    expect(handler2).toHaveBeenCalledWith("SIGTERM");
    expect(handler3).toHaveBeenCalledWith("SIGTERM");
    expect(mockExit).toHaveBeenCalledWith(128 + 15);

    // Restore original mock implementation
    if (currentExit) {
      mockExit.mockImplementation(currentExit);
    }
  });
});
