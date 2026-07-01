import { json } from "@remix-run/server-runtime";
import { CreateBulkActionRequestBody, type QueueTypeName } from "@trigger.dev/core/v3";
import { z } from "zod";
import {
  ApiBulkActionListSearchParams,
  ApiBulkActionPresenter,
} from "~/presenters/v3/ApiBulkActionPresenter.server";
import { ApiRunListPresenter } from "~/presenters/v3/ApiRunListPresenter.server";
import { logger } from "~/services/logger.server";
import type { RunListInputFilters } from "~/services/runsRepository/runsRepository.server";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { BulkActionService } from "~/v3/services/bulk/BulkActionV2.server";
import { ServiceValidationError } from "~/v3/services/common.server";

const MAX_CREATE_BODY_SIZE = 1024 * 1024;

const { action } = createActionApiRoute(
  {
    body: CreateBulkActionRequestBody,
    maxContentLength: MAX_CREATE_BODY_SIZE,
    corsStrategy: "none",
    authorization: {
      action: "write",
      resource: () => ({ type: "runs" }),
    },
  },
  async ({ body, authentication }) => {
    if (!body) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const service = new BulkActionService();

    try {
      const result = await service.create({
        organizationId: authentication.environment.organizationId,
        projectId: authentication.environment.projectId,
        environmentId: authentication.environment.id,
        userId: authentication.actor?.sub ?? null,
        action: body.action,
        title: body.name,
        region: body.region,
        emailNotification: body.emailNotification,
        filters: body.runIds
          ? { runId: body.runIds }
          : bulkActionFilterToRunListFilters(body.filter),
        triggerSource: "api",
      });

      return json({ id: result.bulkActionId }, { status: 202 });
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 400 });
      }

      logger.error("Failed to create API bulk action", { error });
      return json(
        { error: error instanceof Error ? error.message : "Failed to create bulk action" },
        { status: 500 }
      );
    }
  }
);

const loader = createLoaderApiRoute(
  {
    searchParams: ApiBulkActionListSearchParams,
    corsStrategy: "none",
    authorization: {
      action: "read",
      resource: () => ({ type: "runs" }),
    },
    findResource: async () => 1,
  },
  async ({ searchParams, authentication }) => {
    const presenter = new ApiBulkActionPresenter();
    const result = await presenter.list(authentication.environment.id, searchParams);
    return json(result);
  }
);

export { action, loader };

function bulkActionFilterToRunListFilters(
  filter: z.infer<typeof CreateBulkActionRequestBody>["filter"]
): RunListInputFilters {
  if (!filter) {
    return {};
  }

  const filters: RunListInputFilters = {};

  if (filter.status) {
    filters.statuses = asArray(filter.status).flatMap((status) =>
      ApiRunListPresenter.apiStatusToRunStatuses(status)
    );
  }

  if (filter.taskIdentifier) filters.tasks = asArray(filter.taskIdentifier);
  if (filter.version) filters.versions = asArray(filter.version);
  if (filter.tag) filters.tags = asArray(filter.tag);
  if (filter.bulkAction) filters.bulkId = filter.bulkAction;
  if (filter.schedule) filters.scheduleId = filter.schedule;
  if (filter.isTest !== undefined) filters.isTest = filter.isTest;
  if (filter.from !== undefined) filters.from = dateOrNumberToMs(filter.from);
  if (filter.to !== undefined) filters.to = dateOrNumberToMs(filter.to);
  if (filter.period) filters.period = filter.period;
  if (filter.batch) filters.batchId = filter.batch;
  if (filter.queue) filters.queues = asArray(filter.queue).map(queueNameFromQueueTypeName);
  if (filter.machine) filters.machines = asArray(filter.machine);
  if (filter.region) filters.regions = asArray(filter.region);

  return filters;
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

function dateOrNumberToMs(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

function queueNameFromQueueTypeName(queue: QueueTypeName): string {
  if (queue.type === "task") {
    return `task/${queue.name}`;
  }

  return queue.name;
}
