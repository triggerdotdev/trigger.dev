import { ClickHouse } from "@internal/clickhouse";
import { EventEmitter } from "node:events";
import { prisma } from "~/db.server";
import { singleton } from "~/utils/singleton";
import { engine } from "~/v3/runEngine.server";
import { logger } from "./logger.server";
import {
  RunDashboardEventBus,
  RunDashboardEvents,
  RunsDashboardService,
} from "./runsDashboardService.server";
import { tryCatch } from "@trigger.dev/core/utils";

const runDashboardEventBus: RunDashboardEventBus = new EventEmitter<RunDashboardEvents>();

export function emitRunStatusUpdate(runId: string) {
  runDashboardEventBus.emit("runStatusUpdate", {
    time: new Date(),
    runId,
  });
}

export const runsDashboard = singleton("runsDashboard", () => {
  const clickhouse = ClickHouse.fromEnv();

  const service = new RunsDashboardService(clickhouse);

  runDashboardEventBus.on("runStatusUpdate", async (event) => {
    const [upsertError] = await tryCatch(upsertRun(event.time, event.runId, service));

    if (upsertError) {
      logger.error("RunDashboard: runStatusUpdate: upsertRun error", {
        runId: event.runId,
        error: upsertError,
      });
    }
  });

  engine.eventBus.on("runStatusChanged", async (event) => {
    const [upsertError] = await tryCatch(upsertRun(event.time, event.runId, service));

    if (upsertError) {
      logger.error("RunDashboard: runStatusChanged: upsertRun error", {
        runId: event.runId,
        error: upsertError,
      });
    }
  });

  return service;
});

async function upsertRun(time: Date, runId: string, service: RunsDashboardService) {
  const run = await prisma.taskRun.findFirst({
    where: {
      id: runId,
    },
  });

  if (!run) {
    logger.error("RunDashboard: upsertRun: run not found", {
      runId,
    });

    return;
  }

  if (!run.environmentType) {
    logger.error("RunDashboard: upsertRun: run environment type not found", {
      runId,
    });

    return;
  }

  if (!run.organizationId) {
    logger.error("RunDashboard: upsertRun: run organization id not found", {
      runId,
    });

    return;
  }

  await service.upsertRun(time, run, run.environmentType, run.organizationId);
}
