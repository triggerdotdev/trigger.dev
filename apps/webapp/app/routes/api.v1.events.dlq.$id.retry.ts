import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { DeadLetterManagementService } from "~/v3/services/events/deadLetterManagement.server";

const ParamsSchema = z.object({
  id: z.string(),
});

const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    corsStrategy: "all",
    authorization: {
      action: "trigger",
      resource: () => ({ tasks: "*" }),
      superScopes: ["write:tasks", "admin"],
    },
  },
  async ({ params, authentication }) => {
    const service = new DeadLetterManagementService();

    try {
      const result = await service.retry(params.id, authentication.environment);
      return json(result, { status: 200 });
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 422 });
      }
      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

export { action, loader };
