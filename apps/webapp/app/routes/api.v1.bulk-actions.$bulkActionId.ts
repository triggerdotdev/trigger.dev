import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  apiBulkActionObject,
  bulkActionSelect,
} from "~/presenters/v3/ApiBulkActionPresenter.server";
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
    // Read from primary so create -> retrieve/poll doesn't 404 on replica lag.
    findResource: async (params, auth) => {
      return prisma.bulkActionGroup.findFirst({
        select: bulkActionSelect,
        where: {
          friendlyId: params.bulkActionId,
          environmentId: auth.environment.id,
        },
      });
    },
  },
  async ({ resource }) => {
    return json(apiBulkActionObject(resource));
  }
);
