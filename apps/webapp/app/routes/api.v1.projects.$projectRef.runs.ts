import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { findProjectByRef } from "~/models/project.server";
import {
  ApiRunListPresenter,
  ApiRunListSearchParams,
} from "~/presenters/v3/ApiRunListPresenter.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { resolveUserActorEnvironmentScope } from "~/services/userActorEnvironment.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export const loader = createLoaderPATApiRoute(
  {
    params: ParamsSchema,
    searchParams: ApiRunListSearchParams,
    corsStrategy: "all",
    // Resolve projectRef → org so the PAT plugin can ground its
    // role-floor calculation. We deliberately don't filter by user
    // membership here — that's the plugin's job (`authenticatePat`
    // checks OrgMember in the target org and rejects if the user
    // isn't a member). Keeps the contract clean: context is "what
    // org does this URL target?" and auth is "is this user allowed?"
    context: async (params) => {
      const project = await $replica.project.findFirst({
        where: { externalRef: params.projectRef },
        select: { organizationId: true },
      });
      return project ? { organizationId: project.organizationId } : {};
    },
    authorization: { action: "read", resource: () => ({ type: "runs" }) },
  },
  async ({ searchParams, params, authentication, apiVersion }) => {
    const project = await findProjectByRef(params.projectRef, authentication.userId);

    if (!project) {
      return json({ error: "Project not found" }, { status: 404 });
    }

    // A delegated token signed for one environment only ever lists that environment's runs, and a
    // request filter naming another one is refused rather than overridden.
    const scope = await resolveUserActorEnvironmentScope(authentication.userActor, {
      projectId: project.id,
      requestedEnvironmentSlugs: searchParams["filter[env]"],
    });

    const presenter = new ApiRunListPresenter();
    const result = await presenter.call(
      project,
      searchParams,
      apiVersion,
      scope.scoped ? { id: scope.environmentId, organizationId: scope.organizationId } : undefined
    );

    if (!result) {
      return json({ data: [] });
    }

    return json(result);
  }
);
