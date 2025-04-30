import { ClickHouse } from "@internal/clickhouse";
import { EventEmitter } from "node:events";
import { prisma } from "~/db.server";
import { singleton } from "~/utils/singleton";
import { engine } from "~/v3/runEngine.server";
import { logger } from "./logger.server";
import {
  RunDashboardEventBus,
  RunDashboardEventRunAttemptStarted,
  RunDashboardEventRunCancelled,
  RunDashboardEventRunDelayRescheduled,
  RunDashboardEventRunEnqueuedAfterDelay,
  RunDashboardEventRunExpired,
  RunDashboardEventRunFailed,
  RunDashboardEventRunLocked,
  RunDashboardEventRunRetryScheduled,
  RunDashboardEventRunStatusChanged,
  RunDashboardEventRunSucceeded,
  RunDashboardEventRunTagsUpdated,
  RunDashboardEvents,
  RunsDashboardService,
} from "./runsDashboardService.server";
import { tryCatch } from "@trigger.dev/core/utils";

const runDashboardEventBus: RunDashboardEventBus = new EventEmitter<RunDashboardEvents>();

export function emitRunStatusChanged(event: RunDashboardEventRunStatusChanged) {
  runDashboardEventBus.emit("runStatusChanged", event);
}

export function emitRunCreated(time: Date, runId: string) {
  runDashboardEventBus.emit("runCreated", {
    time,
    runId,
  });
}

export function emitRunAttemptStarted(event: RunDashboardEventRunAttemptStarted) {
  runDashboardEventBus.emit("runAttemptStarted", event);
}

export function emitRunFailed(event: RunDashboardEventRunFailed) {
  runDashboardEventBus.emit("runFailed", event);
}

export function emitRunSucceeded(event: RunDashboardEventRunSucceeded) {
  runDashboardEventBus.emit("runSucceeded", event);
}

export function emitRunCancelled(event: RunDashboardEventRunCancelled) {
  runDashboardEventBus.emit("runCancelled", event);
}

export function emitRunRetryScheduled(event: RunDashboardEventRunRetryScheduled) {
  runDashboardEventBus.emit("runRetryScheduled", event);
}

export function emitRunDelayRescheduled(event: RunDashboardEventRunDelayRescheduled) {
  runDashboardEventBus.emit("runDelayRescheduled", event);
}

export function emitRunLocked(event: RunDashboardEventRunLocked) {
  runDashboardEventBus.emit("runLocked", event);
}

export function emitRunExpired(event: RunDashboardEventRunExpired) {
  runDashboardEventBus.emit("runExpired", event);
}

export function emitRunTagsUpdated(event: RunDashboardEventRunTagsUpdated) {
  runDashboardEventBus.emit("runTagsUpdated", event);
}

export function emitRunEnqueuedAfterDelay(event: RunDashboardEventRunEnqueuedAfterDelay) {
  runDashboardEventBus.emit("runEnqueuedAfterDelay", event);
}

export const runsDashboard = singleton("runsDashboard", () => {
  const clickhouse = ClickHouse.fromEnv();

  const service = new RunsDashboardService(clickhouse);

  runDashboardEventBus.on("runCreated", async (event) => {
    const [runCreatedError] = await tryCatch(runCreated(event.time, event.runId, service));

    if (runCreatedError) {
      logger.error("RunDashboard: runCreated: runCreated error", {
        runId: event.runId,
        error: runCreatedError,
      });
    }
  });

  runDashboardEventBus.on("runAttemptStarted", async (event) => {
    const [runAttemptStartedError] = await tryCatch(service.runAttemptStarted(event));

    if (runAttemptStartedError) {
      logger.error("RunDashboard: runAttemptStarted: runAttemptStarted error", {
        runId: event.run.id,
        error: runAttemptStartedError,
      });
    }
  });

  runDashboardEventBus.on("runStatusChanged", async (event) => {
    const [runStatusChangedError] = await tryCatch(service.runStatusChanged(event));

    if (runStatusChangedError) {
      logger.error("RunDashboard: runStatusChanged: runStatusChanged error", {
        runId: event.run.id,
        error: runStatusChangedError,
      });
    }
  });

  runDashboardEventBus.on("runFailed", async (event) => {
    const [runFailedError] = await tryCatch(service.runFailed(event));

    if (runFailedError) {
      logger.error("RunDashboard: runFailed: runFailed error", {
        runId: event.run.id,
        error: runFailedError,
      });
    }
  });

  runDashboardEventBus.on("runSucceeded", async (event) => {
    const [runSucceededError] = await tryCatch(service.runSucceeded(event));

    if (runSucceededError) {
      logger.error("RunDashboard: runSucceeded: runSucceeded error", {
        runId: event.run.id,
        error: runSucceededError,
      });
    }
  });

  runDashboardEventBus.on("runCancelled", async (event) => {
    const [runCancelledError] = await tryCatch(service.runCancelled(event));

    if (runCancelledError) {
      logger.error("RunDashboard: runCancelled: runCancelled error", {
        runId: event.run.id,
        error: runCancelledError,
      });
    }
  });

  runDashboardEventBus.on("runRetryScheduled", async (event) => {
    const [runRetryScheduledError] = await tryCatch(service.runRetryScheduled(event));

    if (runRetryScheduledError) {
      logger.error("RunDashboard: runRetryScheduled: runRetryScheduled error", {
        runId: event.run.id,
        error: runRetryScheduledError,
      });
    }
  });

  runDashboardEventBus.on("runDelayRescheduled", async (event) => {
    const [runDelayRescheduledError] = await tryCatch(service.runDelayRescheduled(event));

    if (runDelayRescheduledError) {
      logger.error("RunDashboard: runDelayRescheduled: runDelayRescheduled error", {
        runId: event.run.id,
        error: runDelayRescheduledError,
      });
    }
  });

  runDashboardEventBus.on("runLocked", async (event) => {
    const [runLockedError] = await tryCatch(service.runLocked(event));

    if (runLockedError) {
      logger.error("RunDashboard: runLocked: runLocked error", {
        runId: event.run.id,
        error: runLockedError,
      });
    }
  });

  runDashboardEventBus.on("runExpired", async (event) => {
    const [runExpiredError] = await tryCatch(service.runExpired(event));

    if (runExpiredError) {
      logger.error("RunDashboard: runExpired: runExpired error", {
        runId: event.run.id,
        error: runExpiredError,
      });
    }
  });

  engine.eventBus.on("runCreated", async (event) => {
    runDashboardEventBus.emit("runCreated", event);
  });

  engine.eventBus.on("runAttemptStarted", async (event) => {
    runDashboardEventBus.emit("runAttemptStarted", event);
  });

  engine.eventBus.on("runStatusChanged", async (event) => {
    runDashboardEventBus.emit("runStatusChanged", event);
  });

  engine.eventBus.on("runFailed", async (event) => {
    runDashboardEventBus.emit("runFailed", event);
  });

  engine.eventBus.on("runSucceeded", async (event) => {
    runDashboardEventBus.emit("runSucceeded", event);
  });

  engine.eventBus.on("runCancelled", async (event) => {
    runDashboardEventBus.emit("runCancelled", event);
  });

  engine.eventBus.on("runRetryScheduled", async (event) => {
    runDashboardEventBus.emit("runRetryScheduled", event);
  });

  engine.eventBus.on("runDelayRescheduled", async (event) => {
    runDashboardEventBus.emit("runDelayRescheduled", event);
  });

  engine.eventBus.on("runLocked", async (event) => {
    runDashboardEventBus.emit("runLocked", event);
  });

  engine.eventBus.on("runExpired", async (event) => {
    runDashboardEventBus.emit("runExpired", event);
  });

  return service;
});

async function runCreated(time: Date, runId: string, service: RunsDashboardService) {
  const run = await prisma.taskRun.findFirst({
    where: {
      id: runId,
    },
  });

  if (!run) {
    logger.error("RunDashboard: runCreated: run not found", {
      runId,
    });

    return;
  }

  if (!run.environmentType) {
    logger.error("RunDashboard: runCreated: run environment type not found", {
      runId,
    });

    return;
  }

  if (!run.organizationId) {
    logger.error("RunDashboard: runCreated: run organization id not found", {
      runId,
    });

    return;
  }

  await service.runCreated(time, run, run.environmentType, run.organizationId);
}
