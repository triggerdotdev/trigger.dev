import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
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
    findResource: async (params, auth) => {
      return $replica.bulkActionGroup.findFirst({
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
