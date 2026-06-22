import { json } from "@remix-run/server-runtime";
import { IgnoreErrorRequestBody } from "@trigger.dev/core/v3";
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
    body: IgnoreErrorRequestBody,
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
  async ({ authentication, body, resource, params }) => {
    if (!resource) {
      return json({ error: "Not found" }, { status: 404 });
    }

    const environment = authentication.environment;

    await new ErrorGroupActions().ignoreError(
      {
        organizationId: environment.organizationId,
        projectId: environment.project.id,
        environmentId: environment.id,
        taskIdentifier: resource.taskIdentifier,
        errorFingerprint: resource.fingerprint,
      },
      {
        userId: authentication.actor?.sub ?? null,
        duration: body.duration,
        occurrenceRateThreshold: body.occurrenceRate,
        totalOccurrencesThreshold: body.totalOccurrences,
        // The "re-surface after N more occurrences" threshold is relative to
        // the count at ignore time. The resolved resource's `count` is the
        // group's current global occurrence count (same source the dashboard
        // uses), so reuse it instead of issuing a second query.
        occurrenceCountAtIgnoreTime: body.totalOccurrences ? resource.count : undefined,
        reason: body.reason,
      }
    );

    const updated = await findErrorGroupResource(authentication, params.errorId);
    return json(updated);
  }
);
