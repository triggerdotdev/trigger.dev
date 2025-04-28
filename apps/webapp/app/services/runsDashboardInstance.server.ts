import { singleton } from "~/utils/singleton";
import { ClickHouse } from "@internal/clickhouse";
import {
  RunDashboardEventBus,
  RunDashboardEvents,
  RunsDashboardService,
} from "./runsDashboardService.server";
import { EventEmitter } from "node:events";
import { RuntimeEnvironmentType, TaskRun } from "@trigger.dev/database";
import { engine } from "~/v3/runEngine.server";
import { logger } from "./logger.server";

const runDashboardEventBus: RunDashboardEventBus = new EventEmitter<RunDashboardEvents>();

export type TaskRunStatusUpdateEnvironment = {
  type: RuntimeEnvironmentType;
  organizationId: string;
};

export function emitRunStatusUpdate(run: TaskRun, environment: TaskRunStatusUpdateEnvironment) {
  runDashboardEventBus.emit("runStatusUpdate", {
    run,
    environment,
    organization: { id: environment.organizationId },
  });
}

export const runsDashboard = singleton("runsDashboard", () => {
  const clickhouse = ClickHouse.fromEnv();

  const service = new RunsDashboardService(clickhouse);

  runDashboardEventBus.on("runStatusUpdate", async (event) => {
    await service.upsertRun(event.run, event.environment.type, event.organization.id);
  });

  engine.eventBus.on("runStatusChanged", async (event) => {
    logger.debug("RunDashboard: runStatusChanged", {
      event,
    });

    await service.upsertRun(event.run, event.environment.type, event.environment.organization.id);
  });

  return service;
});
