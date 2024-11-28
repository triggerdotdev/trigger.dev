import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkersCreateRequestBody,
  WorkersCreateResponseBody,
  WorkersListResponseBody,
} from "@trigger.dev/core/v3";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { WorkerGroupService } from "~/v3/services/worker/workerGroupService.server";

export const loader = createLoaderApiRoute(
  {
    corsStrategy: "all",
  },
  async ({ authentication }): Promise<TypedResponse<WorkersListResponseBody>> => {
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

export const action = createActionApiRoute(
  {
    corsStrategy: "all",
    body: WorkersCreateRequestBody,
  },
  async ({ authentication, body }): Promise<TypedResponse<WorkersCreateResponseBody>> => {
    const service = new WorkerGroupService();
    const { workerGroup, token } = await service.createWorkerGroup({
      projectId: authentication.environment.projectId,
      organizationId: authentication.environment.organizationId,
      name: body.name,
      description: body.description,
    });

    return json({
      token: {
        plaintext: token.plaintext,
      },
      workerGroup: {
        name: workerGroup.name,
        description: workerGroup.description,
      },
    });
  }
);
