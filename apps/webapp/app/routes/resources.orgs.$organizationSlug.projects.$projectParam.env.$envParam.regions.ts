import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { findProjectBySlug } from "~/models/project.server";
import { RegionsPresenter } from "~/presenters/v3/RegionsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }

  try {
    const presenter = new RegionsPresenter();
    const { regions } = await presenter.call({ userId, projectSlug: project.slug });

    return {
      regions: regions.map((r) => ({
        id: r.id,
        name: r.name,
        masterQueue: r.masterQueue,
        cloudProvider: r.cloudProvider,
        location: r.location,
        description: r.description,
      })),
    };
  } catch {
    return {
      regions: [] as {
        id: string;
        name: string;
        masterQueue: string;
        cloudProvider?: string;
        location?: string;
        description?: string;
      }[],
    };
  }
}
