import { BulkActionId } from "@trigger.dev/core/v3/isomorphic";
import { BulkActionType, type PrismaClient } from "@trigger.dev/database";
import { getRunFiltersFromRequest } from "~/presenters/RunFilters.server";
import { type CreateBulkActionPayload } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.bulkaction";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { parseRunListInputOptions, RunsRepository } from "~/services/runsRepository.server";
import { BaseService } from "../baseService.server";
import { commonWorker } from "~/v3/commonWorker.server";
import { env } from "~/env.server";

export class BulkActionService extends BaseService {
  public async create(
    organizationId: string,
    projectId: string,
    environmentId: string,
    userId: string,
    payload: CreateBulkActionPayload,
    request: Request
  ) {
    const filters = await getFilters(payload, request);

    if (!clickhouseClient) {
      throw new Error("Clickhouse client not found");
    }

    // Count the runs that will be affected by the bulk action
    const runsRepository = new RunsRepository({
      clickhouse: clickhouseClient,
      prisma: this._replica as PrismaClient,
    });
    const count = await runsRepository.countRuns({
      organizationId,
      projectId,
      environmentId,
      ...filters,
    });

    // Create the bulk action group
    const { id, friendlyId } = BulkActionId.generate();
    const group = await this._prisma.bulkActionGroup.create({
      data: {
        id,
        friendlyId,
        projectId,
        environmentId,
        userId,
        name: payload.title,
        type: payload.action === "cancel" ? BulkActionType.CANCEL : BulkActionType.REPLAY,
        params: filters,
        queryName: "bulk_action_v1",
        totalCount: count,
      },
    });

    // Queue the bulk action group for immediate processing
    await commonWorker.enqueue({
      id: `processBulkAction-${group.id}`,
      job: "processBulkAction",
      payload: {
        bulkActionId: group.id,
      },
    });

    return {
      bulkActionId: group.friendlyId,
    };
  }

  public async process(bulkActionId: string) {
    // 1. Get the bulk action group
    const group = await this._prisma.bulkActionGroup.findUnique({
      where: { id: bulkActionId },
      select: {
        projectId: true,
        environmentId: true,
        project: {
          select: {
            organizationId: true,
          },
        },
        type: true,
        queryName: true,
        params: true,
        cursor: true,
      },
    });

    if (!group) {
      throw new Error(`Bulk action group not found: ${bulkActionId}`);
    }

    if (!group.environmentId) {
      throw new Error(`Bulk action group has no environment: ${bulkActionId}`);
    }

    // 2. Parse the params
    const filters = parseRunListInputOptions({
      organizationId: group.project.organizationId,
      projectId: group.projectId,
      environmentId: group.environmentId,
      ...(group.params && typeof group.params === "object" ? group.params : {}),
    });

    if (!clickhouseClient) {
      throw new Error("Clickhouse client not found");
    }

    // Count the runs that will be affected by the bulk action
    const runsRepository = new RunsRepository({
      clickhouse: clickhouseClient,
      prisma: this._replica as PrismaClient,
    });

    // In the future we can support multiple query names, when we make changes
    if (group.queryName !== "bulk_action_v1") {
      throw new Error(`Bulk action group has invalid query name: ${group.queryName}`);
    }

    // 2. Get the runs to process in this batch
    const runs = await runsRepository.listRunIds({
      ...filters,
      page: {
        size: env.BULK_ACTION_BATCH_SIZE,
        cursor:
          typeof group.cursor === "string" && group.cursor !== null ? group.cursor : undefined,
      },
    });

    // 3. Process the runs

    // 4. Update the bulk action group

    // 5. If there are more runs to process, queue the next batch
  }
}

async function getFilters(payload: CreateBulkActionPayload, request: Request) {
  if (payload.mode === "selected") {
    return {
      runIds: payload.selectedRunIds,
    };
  }

  const filters = await getRunFiltersFromRequest(request);
  filters.cursor = undefined;

  // If there isn't a time period or to date, we set the to date to now
  // Otherwise this could run forever if lots of new runs are being created
  if (!filters.period && !filters.to) {
    filters.to = Date.now();
  }

  return filters;
}
