import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { findErrorGroupResource } from "~/presenters/v3/ApiErrorGroupPresenter.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ErrorGroupActions } from "~/v3/services/errorGroupActions.server";

const ParamsSchema = z.object({
  errorId: z.string(),
});

export const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    method: "POST",
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, authentication) =>
      findErrorGroupResource(authentication, params.errorId),
    authorization: {
      action: "write",
      resource: (params) => ({ type: "errors", id: params.errorId }),
    },
  },
  async ({ authentication, resource, params }) => {
    if (!resource) {
      return json({ error: "Not found" }, { status: 404 });
    }

    const environment = authentication.environment;

    await new ErrorGroupActions().unresolveError({
      organizationId: environment.organizationId,
      projectId: environment.project.id,
      environmentId: environment.id,
      taskIdentifier: resource.taskIdentifier,
      errorFingerprint: resource.fingerprint,
    });

    const updated = await findErrorGroupResource(authentication, params.errorId);
    return json(updated);
  }
);
