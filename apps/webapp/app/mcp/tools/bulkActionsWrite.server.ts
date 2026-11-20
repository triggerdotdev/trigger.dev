import type { PrismaClient } from "@trigger.dev/database";
import { $replica, prisma } from "~/db.server";
import { ApiRunListPresenter } from "~/presenters/v3/ApiRunListPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import {
  RunsRepository,
  type RunListInputFilters,
} from "~/services/runsRepository/runsRepository.server";
import { MCP_REMOTE_TRIGGER_SOURCE } from "~/utils/triggerSource";
import { v3BulkActionPath } from "~/utils/pathBuilder";
import { BulkActionService } from "~/v3/services/bulk/BulkActionV2.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import type { McpSubject } from "../gate/types";
import type { McpToolDefinition } from "../registry.server";
import { dashboardUrl, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, fencedError } from "./defineWrite.server";
import {
  abortBulkActionPreview,
  createBulkActionPreview,
  DEFAULT_RUN_PERIOD,
  renderBulkActionId,
  timeWindowOf,
  type TimeWindow,
} from "./format/bulkActions";
import {
  BulkActionIdInput,
  CreateBulkActionInput,
  type BulkActionFilter,
} from "./schemas/bulkActions";

function bulkActionSelection(
  input: { runIds?: string[]; filter?: BulkActionFilter },
  now: number
): { filters: RunListInputFilters; runIds?: string[]; window?: TimeWindow } {
  if (input.runIds) {
    const runIds = [...new Set(input.runIds)];
    return { runIds, filters: { runId: runIds } };
  }
  const f = input.filter ?? {};
  const window = timeWindowOf(f, now);
  const filters: RunListInputFilters = {
    statuses: f.status?.flatMap((s) => ApiRunListPresenter.apiStatusToRunStatuses(s)),
    tasks: f.taskIdentifier,
    versions: f.version,
    tags: f.tag,
    queues: f.queue,
    machines: f.machine,
    regions: f.region,
    batchId: f.batch,
    scheduleId: f.schedule,
    bulkId: f.bulkAction,
    errorId: f.error,
    rootOnly: f.rootOnly,
    from: window.from,
    to: window.to,
  };
  return { filters, window };
}

const COUNT_FAILED = {
  refuse:
    "The runs this bulk action would affect could not be counted, so it cannot be confirmed. Try again later.",
};

async function countSelection(subject: McpSubject | null, filters: RunListInputFilters) {
  if (!subject?.projectId || !subject.environmentId) return undefined;
  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    subject.organizationId,
    "runsList"
  );
  const repository = new RunsRepository({ clickhouse, prisma: $replica as PrismaClient });
  return repository.countRuns({
    organizationId: subject.organizationId,
    projectId: subject.projectId,
    environmentId: subject.environmentId,
    ...filters,
  });
}

function findBulkAction(friendlyId: string, environmentId: string) {
  return prisma.bulkActionGroup.findFirst({
    where: { friendlyId, environmentId },
    select: {
      friendlyId: true,
      type: true,
      status: true,
      totalCount: true,
      successCount: true,
      failureCount: true,
    },
  });
}

function serviceError(error: unknown, source: string) {
  if (error instanceof ServiceValidationError) return fencedError(error.message, source);
  throw error;
}

function invalidCreateArgs(args: Record<string, unknown> | undefined): string | undefined {
  if ((args?.runIds === undefined) === (args?.filter === undefined)) {
    return "Invalid arguments: pass either runIds or filter";
  }
  if (args?.region !== undefined && args?.action !== "replay") {
    return "Invalid arguments: region can only be set for replay";
  }
  return undefined;
}

const createBulkAction = defineWriteTool({
  name: "create_bulk_action",
  title: "Create Bulk Action",
  description: `Cancel or replay many runs at once, selected by run IDs or by a filter. A filter selects runs created in its time window, the last ${DEFAULT_RUN_PERIOD} if none is given, and is checked again as each batch of runs is processed. Use get_bulk_action to follow its progress and abort_bulk_action to stop it.`,
  shape: CreateBulkActionInput.shape,
  approval: "required",
  auth: { action: "write", subject: "runs" },
  confirm: {
    precheck: (args, ability, subject) =>
      args.action === "replay" &&
      !ability?.can("trigger", { type: "tasks", envType: subject?.environmentType })
        ? { action: "trigger", subject: "tasks" }
        : undefined,
    preview: async (args, subject) => {
      const { filters, runIds, window } = bulkActionSelection(args, Date.now());
      const largest = createBulkActionPreview({
        ...args,
        runIds,
        window,
        count: Number.MAX_SAFE_INTEGER,
      });
      if (typeof largest !== "string") return largest;
      const count = await countSelection(subject, filters).catch(() => undefined);
      if (count === undefined) return COUNT_FAILED;
      return createBulkActionPreview({ ...args, runIds, window, count });
    },
  },
  run: async (input, ctx) => {
    const environment = await resolveToolEnvironment(ctx);
    if (!environment) return fencedError("Environment not found", "bulk-action-error");

    if (
      input.action === "replay" &&
      !ctx.ability?.can("trigger", { type: "tasks", envType: environment.type })
    ) {
      return fencedError(
        "Bulk replay needs permission to trigger every task in this environment",
        "bulk-action-error"
      );
    }

    const { filters, runIds } = bulkActionSelection(input, Date.now());
    let bulkActionId: string;
    try {
      ({ bulkActionId } = await new BulkActionService().create({
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        userId: ctx.identity.userId,
        action: input.action,
        title: input.name,
        region: input.region,
        emailNotification: input.emailNotification,
        filters,
        triggerSource: MCP_REMOTE_TRIGGER_SOURCE,
      }));
    } catch (error) {
      return serviceError(error, "bulk-action-error");
    }

    const created = await findBulkAction(bulkActionId, environment.id);
    const total = created?.totalCount ?? 0;
    const id = renderBulkActionId(bulkActionId);
    const lines = [
      runIds
        ? `Started bulk action ${id} to ${input.action} the ${runIds.length} distinct run ID${runIds.length === 1 ? "" : "s"} given: ${total} found in this environment within the last ${DEFAULT_RUN_PERIOD} when it was created. Runs not indexed yet may still be included; the others are skipped.`
        : `Started bulk action ${id} to ${input.action} about ${total} run${total === 1 ? "" : "s"} (counted when it was created; the filter is checked again as each batch is processed).`,
    ];
    lines.push(
      `Use get_bulk_action with ${id} to follow its progress.`,
      `[View in dashboard](${dashboardUrl(v3BulkActionPath(environment.organization, environment.project, environment, { friendlyId: bulkActionId }))})`
    );
    return textResult(lines.join("\n"));
  },
});

export const bulkActionsWriteTools: McpToolDefinition[] = [
  {
    ...createBulkAction,
    handler: (args, ...rest) => {
      const invalid = invalidCreateArgs(args as Record<string, unknown> | undefined);
      return invalid
        ? Promise.resolve(errorResult(invalid))
        : createBulkAction.handler(args, ...rest);
    },
  },
  defineWriteTool({
    name: "abort_bulk_action",
    title: "Abort Bulk Action",
    description:
      "Stop a bulk action that is still in progress. Runs it already cancelled or replayed are not changed back. The ID starts with bulk_",
    shape: BulkActionIdInput.shape,
    approval: "configurable",
    auth: { action: "write", subject: "runs" },
    confirm: {
      preview: async (args, subject) =>
        abortBulkActionPreview(
          args.bulkActionId,
          args.environment,
          subject?.environmentId
            ? await findBulkAction(args.bulkActionId, subject.environmentId)
            : null
        ),
    },
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return fencedError("Environment not found", "bulk-action-error");

      try {
        await new BulkActionService().abort(input.bulkActionId, environment.id);
      } catch (error) {
        return serviceError(error, "bulk-action-error");
      }

      return textResult(
        `Aborted bulk action ${renderBulkActionId(input.bulkActionId)}. No new batch of runs starts; runs it already processed are not changed back.`
      );
    },
  }),
];
