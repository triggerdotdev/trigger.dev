import { Logger } from "@trigger.dev/core/logger";

export type ReplicationErrorRecoveryStrategy =
  | {
      type: "reconnect";
      initialDelayMs?: number;
      maxDelayMs?: number;
      maxAttempts?: number;
    }
  | {
      type: "exit";
      exitDelayMs?: number;
      exitCode?: number;
    }
  | { type: "log" };

export type ReplicationErrorRecoveryDeps = {
  strategy: ReplicationErrorRecoveryStrategy;
  logger: Logger;
  reconnect: () => Promise<void>;
  isShuttingDown: () => boolean;
};

export type ReplicationErrorRecovery = {
  handle(error: unknown): void;
  notifyStreamStarted(): void;
  notifyLeaderElectionLost(error: unknown): void;
  dispose(): void;
};

export function createReplicationErrorRecovery(
  deps: ReplicationErrorRecoveryDeps
): ReplicationErrorRecovery {
  const { strategy, logger, reconnect, isShuttingDown } = deps;
  let attempt = 0;
  let pendingReconnect: NodeJS.Timeout | null = null;
  let pendingExit: NodeJS.Timeout | null = null;

  function scheduleReconnect(error: unknown): void {
    if (strategy.type !== "reconnect") return;
    if (pendingReconnect) return;

    attempt += 1;
    const maxAttempts = strategy.maxAttempts ?? 0;
    if (maxAttempts > 0 && attempt > maxAttempts) {
      logger.error("Replication reconnect exceeded maxAttempts; giving up", {
        attempt,
        maxAttempts,
        error,
      });
      return;
    }

    const initialDelay = strategy.initialDelayMs ?? 1_000;
    const maxDelay = strategy.maxDelayMs ?? 60_000;
    const delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);

    logger.error("Replication stream lost — scheduling reconnect", {
      attempt,
      delayMs: delay,
      error,
    });

    pendingReconnect = setTimeout(async () => {
      pendingReconnect = null;

      if (isShuttingDown()) {
        logger.info("Replication reconnect skipped — shutting down");
        return;
      }

      try {
        await reconnect();
      } catch (err) {
        logger.error("Replication reconnect failed", { error: err });
        scheduleReconnect(err);
      }
    }, delay);
  }

  function scheduleExit(): void {
    if (strategy.type !== "exit") return;
    if (pendingExit) return;

    const delay = strategy.exitDelayMs ?? 5_000;
    const exitCode = strategy.exitCode ?? 1;

    logger.error("Replication stream lost — exiting", { delayMs: delay, exitCode });

    pendingExit = setTimeout(() => {
      process.exit(exitCode);
    }, delay);
  }

  return {
    handle(error: unknown) {
      if (isShuttingDown()) return;

      switch (strategy.type) {
        case "log":
          return;
        case "exit":
          return scheduleExit();
        case "reconnect":
          return scheduleReconnect(error);
      }
    },
    notifyStreamStarted() {
      if (attempt > 0) {
        logger.info("Replication reconnect succeeded", { attempt });
        attempt = 0;
      }
    },
    notifyLeaderElectionLost(error: unknown) {
      if (isShuttingDown()) return;
      if (strategy.type !== "reconnect") return;
      scheduleReconnect(error);
    },
    dispose() {
      if (pendingReconnect) {
        clearTimeout(pendingReconnect);
        pendingReconnect = null;
      }
      if (pendingExit) {
        clearTimeout(pendingExit);
        pendingExit = null;
      }
    },
  };
}

export type ReplicationErrorRecoveryEnv = {
  strategy: "reconnect" | "exit" | "log";
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectMaxAttempts?: number;
  exitDelayMs?: number;
  exitCode?: number;
};

export function strategyFromEnv(
  env: ReplicationErrorRecoveryEnv
): ReplicationErrorRecoveryStrategy {
  switch (env.strategy) {
    case "exit":
      return {
        type: "exit",
        exitDelayMs: env.exitDelayMs,
        exitCode: env.exitCode,
      };
    case "log":
      return { type: "log" };
    case "reconnect":
    default:
      return {
        type: "reconnect",
        initialDelayMs: env.reconnectInitialDelayMs,
        maxDelayMs: env.reconnectMaxDelayMs,
        maxAttempts: env.reconnectMaxAttempts,
      };
  }
}