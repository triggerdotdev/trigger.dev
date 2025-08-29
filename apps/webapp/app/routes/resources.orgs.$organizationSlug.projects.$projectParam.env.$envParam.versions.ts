import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { VersionListPresenter } from "~/presenters/v3/VersionListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const SearchParamsSchema = z.object({
  query: z.string().optional(),
  per_page: z.coerce.number().min(1).default(25),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const url = new URL(request.url);
  const { per_page, query } = SearchParamsSchema.parse(Object.fromEntries(url.searchParams));

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const presenter = new VersionListPresenter(per_page);

  const result = await presenter.call({
    environment: environment,
    query,
  });

  if (!result.success) {
    return {
      versions: [],
      hasFilters: query !== undefined && query.length > 0,
    };
  }

  return {
    versions: result.versions,
    hasFilters: result.hasFilters,
  };
}
