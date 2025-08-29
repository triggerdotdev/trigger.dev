import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { QueueListPresenter } from "~/presenters/v3/QueueListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const SearchParamsSchema = z.object({
  query: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  per_page: z.coerce.number().min(1).default(20),
  type: z.enum(["task", "custom"]).optional(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const url = new URL(request.url);
  const { page, per_page, query, type } = SearchParamsSchema.parse(
    Object.fromEntries(url.searchParams)
  );

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

  const presenter = new QueueListPresenter(per_page);

  const result = await presenter.call({
    environment: environment,
    query,
    page,
    type,
  });

  if (!result.success) {
    return {
      queues: [],
      currentPage: 1,
      hasMore: false,
      hasFilters: Boolean(query?.trim()) || Boolean(type),
    };
  }

  return {
    queues: result.queues.map((queue) => ({
      id: queue.id,
      name: queue.name,
      type: queue.type,
      paused: queue.paused,
    })),
    currentPage: result.pagination.currentPage,
    hasMore: result.pagination.currentPage < result.pagination.totalPages,
    hasFilters: result.hasFilters,
  };
}
