import { isTest } from "std-env";
import { SimpleStructuredLogger } from "../utils/structuredLogger.js";
import { singleton } from "./singleton.js";

type ShutdownHandler = NodeJS.SignalsListener;
// We intentionally keep these limited to avoid unexpected issues with signal handling
type ShutdownSignal = Extract<NodeJS.Signals, "SIGTERM" | "SIGINT">;

export class ShutdownManager {
  private isShuttingDown = false;
  private signalNumbers: Record<ShutdownSignal, number> = {
    SIGINT: 2,
    SIGTERM: 15,
  };

  private logger = new SimpleStructuredLogger("shutdownManager");
  private handlers: Map<string, { handler: ShutdownHandler; signals: ShutdownSignal[] }> =
    new Map();

  constructor(private disableForTesting = true) {
    if (disableForTesting) return;

    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("SIGINT", () => this.shutdown("SIGINT"));
  }

  register(
    name: string,
    handler: ShutdownHandler,
    signals: ShutdownSignal[] = ["SIGTERM", "SIGINT"]
  ) {
    if (!this.isEnabled()) return;

    if (this.handlers.has(name)) {
      throw new Error(`Shutdown handler "${name}" already registered`);
    }
    this.handlers.set(name, { handler, signals });
  }

  unregister(name: string) {
    if (!this.isEnabled()) return;

    if (!this.handlers.has(name)) {
      throw new Error(`Shutdown handler "${name}" not registered`);
    }

    this.handlers.delete(name);
  }

  async shutdown(signal: ShutdownSignal) {
    if (!this.isEnabled()) return;

    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.info(`Received ${signal}. Starting graceful shutdown...`);

    // Get handlers that are registered for this signal
    const handlersToRun = Array.from(this.handlers.entries()).filter(([_, { signals }]) =>
      signals.includes(signal)
    );

    try {
      const results = await Promise.allSettled(
        handlersToRun.map(async ([name, { handler }]) => {
          try {
            this.logger.info(`Running shutdown handler: ${name}`);
            await handler(signal);
            this.logger.info(`Shutdown handler completed: ${name}`);
          } catch (error) {
            this.logger.error(`Shutdown handler failed: ${name}`, { error });
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
            this.logger.error(`Shutdown handler "${name}" failed:`, { reason: result.reason });
          }
        }
      });
    } catch (error) {
      this.logger.error("Error during shutdown:", { error });
    } finally {
      // Exit with the correct signal number
      process.exit(128 + this.signalNumbers[signal]);
    }
  }

  private isEnabled() {
    if (!this.disableForTesting) {
      return true;
    }

    return !isTest;
  }

  // Only for testing
  public _getHandlersForTesting(): ReadonlyMap<
    string,
    { handler: ShutdownHandler; signals: ShutdownSignal[] }
  > {
    return new Map(this.handlers);
  }
}

export const shutdownManager = singleton("shutdownManager", () => new ShutdownManager());
