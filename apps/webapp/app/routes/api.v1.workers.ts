import { json, TypedResponse } from "@remix-run/server-runtime";
import { ListWorkersResponseBody } from "@trigger.dev/core/v3";
import { createLoaderApiRoute } from "~/services/routeBuiilders/apiBuilder.server";
import { WorkerGroupService } from "~/v3/services/worker/workerGroupService.server";

export const loader = createLoaderApiRoute(
  {
    corsStrategy: "all",
  },
  async ({ authentication }): Promise<TypedResponse<ListWorkersResponseBody>> => {
    const service = new WorkerGroupService();
    const workers = await service.listWorkerGroups({
      projectId: authentication.environment.projectId,
    });

    return json(
      workers.map((w) => ({
        type: w.type,
        name: w.name,
        description: w.description,
        isDefault: w.id === authentication.environment.project.defaultWorkerGroupId,
        updatedAt: w.updatedAt,
      }))
    );
  }
);
