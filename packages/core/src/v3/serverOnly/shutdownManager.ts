import { singleton } from "./singleton.js";

type ShutdownHandler = NodeJS.SignalsListener;
// We intentionally keep these limited to avoid unexpected issues with signal handling
type ShutdownSignal = Extract<NodeJS.Signals, "SIGTERM" | "SIGINT">;

class ShutdownManager {
  private isShuttingDown = false;
  private signalNumbers: Record<ShutdownSignal, number> = {
    SIGINT: 2,
    SIGTERM: 15,
  };

  private handlers: Map<string, { handler: ShutdownHandler; signals: ShutdownSignal[] }> =
    new Map();

  constructor() {
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("SIGINT", () => this.shutdown("SIGINT"));
  }

  register(
    name: string,
    handler: ShutdownHandler,
    signals: ShutdownSignal[] = ["SIGTERM", "SIGINT"]
  ) {
    if (this.handlers.has(name)) {
      throw new Error(`Shutdown handler "${name}" already registered`);
    }
    this.handlers.set(name, { handler, signals });
  }

  unregister(name: string) {
    this.handlers.delete(name);
  }

  async shutdown(signal: ShutdownSignal) {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

    // Get handlers that are registered for this signal
    const handlersToRun = Array.from(this.handlers.entries()).filter(([_, { signals }]) =>
      signals.includes(signal)
    );

    try {
      const results = await Promise.allSettled(
        handlersToRun.map(async ([name, { handler }]) => {
          try {
            console.log(`Running shutdown handler: ${name}`);
            await handler(signal);
            console.log(`Shutdown handler completed: ${name}`);
          } catch (error) {
            console.error(`Shutdown handler failed: ${name}`, error);
            throw error;
          }
        })
      );

      // Log any failures
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          const handlerEntry = handlersToRun[index];
          if (handlerEntry) {
            const [name] = handlerEntry;
            console.error(`Shutdown handler "${name}" failed:`, result.reason);
          }
        }
      });
    } catch (error) {
      console.error("Error during shutdown:", error);
    } finally {
      // Exit with the correct signal number
      process.exit(128 + this.signalNumbers[signal]);
    }
  }

  // For testing purposes only - keep this
  private _reset() {
    this.isShuttingDown = false;
    this.handlers.clear();
  }
}

export const shutdownManager = singleton("shutdownManager", () => new ShutdownManager());
