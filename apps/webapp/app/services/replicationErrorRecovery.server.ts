import { Logger } from "@trigger.dev/core/logger";

// When the LogicalReplicationClient's WAL stream errors (e.g. after a
// Postgres failover) it calls stop() on itself and stays stopped. The host
// service has to decide how to recover. Three strategies are available:
//
// - "reconnect" — re-subscribe in-process with exponential backoff. Default;
//   works without a process supervisor.
// - "exit"      — exit the process so an external supervisor (Docker
//   restart=always, ECS, systemd, k8s, ...) replaces it. Recommended when a
//   supervisor is present because it gets a clean slate every time.
// - "log"       — preserve the historical no-op behaviour. Useful for
//   debugging or in test environments where you want to observe the
//   silent-death failure mode.
export type ReplicationErrorRecoveryStrategy =
  | {
      type: "reconnect";
      initialDelayMs?: number;
      maxDelayMs?: number;
      // 0 (or undefined) means retry forever.
      maxAttempts?: number;
    }
  | {
      type: "exit";
      exitDelayMs?: number;
      exitCode?: number;
    }
  | { type: "log" };

export interface ReplicationErrorRecoveryDeps {
  strategy: ReplicationErrorRecoveryStrategy;
  logger: Logger;
  // Re-subscribe the underlying replication client. Implementations should
  // call client.subscribe(lastAcknowledgedLsn) and resolve once that returns.
  reconnect: () => Promise<void>;
  // True once the host service has begun graceful shutdown — recovery
  // suppresses all work in that state.
  isShuttingDown: () => boolean;
}

export interface ReplicationErrorRecovery {
  // Called from the replication client's "error" event handler.
  handle(error: unknown): void;
  // Called from the replication client's "start" event handler. Resets the
  // reconnect attempt counter so the next failure starts from initialDelayMs.
  notifyStreamStarted(): void;
  // Cancel any pending reconnect/exit timer. Called from shutdown().
  dispose(): void;
}

export function createReplicationErrorRecovery(
  deps: ReplicationErrorRecoveryDeps
): ReplicationErrorRecovery {
  const { strategy, logger, reconnect, isShuttingDown } = deps;
  let attempt = 0;
  let pendingReconnect: NodeJS.Timeout | null = null;
  let pendingExit: NodeJS.Timeout | null = null;
  let exiting = false;

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
      if (isShuttingDown()) return;

      try {
        await reconnect();
        // Success path is handled by notifyStreamStarted, which fires from
        // the replication client's "start" event after the stream is live.
      } catch (err) {
        // subscribe() emits an "error" event of its own on failure, so the
        // next attempt is scheduled by handle(). Log here anyway so reconnect
        // failures stay visible even if the error event is suppressed.
        logger.error("Replication reconnect attempt failed", {
          attempt,
          error: err,
        });
      }
    }, delay);
  }

  function scheduleExit(): void {
    if (strategy.type !== "exit") return;
    if (exiting) return;
    exiting = true;

    const delay = strategy.exitDelayMs ?? 5_000;
    const code = strategy.exitCode ?? 1;

    logger.error("Fatal replication error — exiting to let process supervisor restart", {
      exitCode: code,
      exitDelayMs: delay,
    });

    pendingExit = setTimeout(() => {
      // eslint-disable-next-line no-process-exit
      process.exit(code);
    }, delay);
    // Don't hold a clean shutdown back on this timer.
    pendingExit.unref();
  }

  return {
    handle(error) {
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

// Shape of the env-driven configuration object the instance bootstrap files
// build from process.env. Kept separate from the strategy union above so the
// instance code can pass a single object regardless of which strategy is set.
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
