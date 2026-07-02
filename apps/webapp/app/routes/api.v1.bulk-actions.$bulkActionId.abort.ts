import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
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
    // Existence/auth gate. Reads from primary so create -> abort doesn't 404 on
    // replica lag; the abort write path re-reads and mutates on primary.
    findResource: async (params, auth) => {
      return prisma.bulkActionGroup.findFirst({
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
