import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { findProjectByRef } from "~/models/project.server";
import {
  ApiRunListPresenter,
  ApiRunListSearchParams,
} from "~/presenters/v3/ApiRunListPresenter.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { callRunListWithBufferMerge } from "~/v3/mollifier/listingMerge.server";

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

    // For PAT-scoped lookups the environment isn't supplied by auth;
    // it's resolved from `filter[env]`. The presenter already does this
    // lookup internally and errors if no env can be resolved. We mirror
    // that resolution here so the mollifier-buffer merge has the env
    // context it needs (envId + slug for synthesised list items).
    const envFilter = searchParams["filter[env]"];
    let envForMerge:
      | { id: string; organizationId: string; slug: string }
      | undefined;
    if (envFilter && envFilter.length > 0) {
      const env = await $replica.runtimeEnvironment.findFirst({
        where: { projectId: project.id, slug: { in: envFilter } },
        select: { id: true, organizationId: true, slug: true },
      });
      if (env) envForMerge = env;
    }

    if (envForMerge) {
      const result = await callRunListWithBufferMerge({
        project,
        searchParams,
        apiVersion,
        environment: envForMerge,
      });
      return json(result);
    }

    // No env resolvable — let the presenter throw its existing
    // ServiceValidationError, preserving the legacy behaviour.
    const presenter = new ApiRunListPresenter();
    const result = await presenter.call(project, searchParams, apiVersion);

    if (!result) {
      return json({ data: [] });
    }

    return json(result);
  }
);
