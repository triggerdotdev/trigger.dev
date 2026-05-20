import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { findProjectByRef } from "~/models/project.server";
import {
  ApiRunListPresenter,
  ApiRunListSearchParams,
} from "~/presenters/v3/ApiRunListPresenter.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

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

    const presenter = new ApiRunListPresenter();
    const result = await presenter.call(project, searchParams, apiVersion);

    if (!result) {
      return json({ data: [] });
    }

    return json(result);
  }
);
