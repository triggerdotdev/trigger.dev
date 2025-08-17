import { json } from "@remix-run/server-runtime";
import { z } from "zod";
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
