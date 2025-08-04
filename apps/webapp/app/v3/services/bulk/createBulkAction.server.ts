import { type BulkActionType } from "@trigger.dev/database";
import { bulkActionVerb } from "~/components/runs/v3/BulkAction";
import { BULK_ACTION_RUN_LIMIT } from "~/consts";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../../friendlyIdentifiers";
import { BaseService } from "../baseService.server";
import { PerformBulkActionService } from "./performBulkAction.server";

type BulkAction = {
  projectId: string;
  action: BulkActionType;
  runIds: string[];
};

export class CreateBulkActionService extends BaseService {
  public async call({ projectId, action, runIds }: BulkAction) {
    const group = await this._prisma.bulkActionGroup.create({
      data: {
        friendlyId: generateFriendlyId("bulk"),
        projectId,
        type: action,
      },
    });

    //limit to the first X runs
    const passedTooManyRuns = runIds.length > BULK_ACTION_RUN_LIMIT;
    runIds = runIds.slice(0, BULK_ACTION_RUN_LIMIT);

    const items = await this._prisma.bulkActionItem.createMany({
      data: runIds.map((runId) => ({
        friendlyId: generateFriendlyId("bulkitem"),
        type: action,
        groupId: group.id,
        sourceRunId: runId,
      })),
    });

    logger.debug("Created bulk action group", {
      groupId: group.id,
      action,
      runIds,
    });

    await PerformBulkActionService.enqueue(group.id, this._prisma);

    let message = bulkActionVerb(action);
    if (passedTooManyRuns) {
      message += ` the first ${BULK_ACTION_RUN_LIMIT} runs`;
    } else {
      message += ` ${runIds.length} runs`;
    }

    return {
      id: group.id,
      friendlyId: group.friendlyId,
      runCount: runIds.length,
      message,
    };
  }
}
