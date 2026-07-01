import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { BulkActionService } from "~/v3/services/bulk/BulkActionV2.server";

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
      // Read from primary so create -> abort doesn't 404 on replica lag.
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
      return json(
        { error: error instanceof Error ? error.message : "Failed to abort bulk action" },
        { status: 400 }
      );
    }
  }
);

export { action };
