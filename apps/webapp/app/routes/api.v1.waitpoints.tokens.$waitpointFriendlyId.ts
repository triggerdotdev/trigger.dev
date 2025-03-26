import { json } from "@remix-run/server-runtime";
import { type WaitpointRetrieveTokenResponse } from "@trigger.dev/core/v3";
import { z } from "zod";
import { ApiWaitpointPresenter } from "~/presenters/v3/ApiWaitpointPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    params: z.object({
      waitpointFriendlyId: z.string(),
    }),
    findResource: async () => 1, // This is a dummy function, we don't need to find a resource
  },
  async ({ params, authentication }) => {
    const presenter = new ApiWaitpointPresenter();
    const result: WaitpointRetrieveTokenResponse = await presenter.call(
      authentication.environment,
      params.waitpointFriendlyId
    );
    return json(result);
  }
);
