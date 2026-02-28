import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { DeadLetterManagementService } from "~/v3/services/events/deadLetterManagement.server";

const BodySchema = z
  .object({
    eventType: z.string().optional(),
  })
  .optional();

const { action, loader } = createActionApiRoute(
  {
    body: BodySchema,
    corsStrategy: "all",
    authorization: {
      action: "trigger",
      resource: () => ({ tasks: "*" }),
      superScopes: ["write:tasks", "admin"],
    },
  },
  async ({ body, authentication }) => {
    const service = new DeadLetterManagementService();

    const result = await service.retryAll({
      projectId: authentication.environment.projectId,
      environmentId: authentication.environment.id,
      eventType: body?.eventType,
      environment: authentication.environment,
    });

    return json(result, { status: 200 });
  }
);

export { action, loader };
