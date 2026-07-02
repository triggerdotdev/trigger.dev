import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { BulkActionService } from "~/v3/services/bulk/BulkActionV2.server";
import { ServiceValidationError } from "~/v3/services/common.server";

const ParamsSchema = z.object({
  bulkActionId: z.string(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    corsStrategy: "none",
    authorization: {
      action: "write",
      resource: () => ({ type: "runs" }),
    },
    findResource: async (params, auth) => {
      return $replica.bulkActionGroup.findFirst({
        select: { id: true },
        where: {
          friendlyId: params.bulkActionId,
          environmentId: auth.environment.id,
        },
      });
    },
  },
  async ({ params, authentication }) => {
    const service = new BulkActionService();

    try {
      const result = await service.abort(params.bulkActionId, authentication.environment.id);
      return json({ id: result.bulkActionId });
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 400 });
      }

      logger.error("Failed to abort API bulk action", { error });
      return json({ error: "Failed to abort bulk action" }, { status: 500 });
    }
  }
);

export { action };
