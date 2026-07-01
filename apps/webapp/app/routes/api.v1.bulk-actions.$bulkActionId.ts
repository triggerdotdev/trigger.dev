import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { ApiBulkActionPresenter } from "~/presenters/v3/ApiBulkActionPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  bulkActionId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    corsStrategy: "none",
    authorization: {
      action: "read",
      resource: () => ({ type: "runs" }),
    },
    findResource: async (params, auth) => {
      // Read from primary so create -> retrieve/poll doesn't 404 on replica lag.
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
    const presenter = new ApiBulkActionPresenter();
    const bulkAction = await presenter.retrieve(authentication.environment.id, params.bulkActionId);

    if (!bulkAction) {
      return json({ error: "Bulk action not found" }, { status: 404 });
    }

    return json(bulkAction);
  }
);
