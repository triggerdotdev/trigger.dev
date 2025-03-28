import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { WaitpointTagListPresenter } from "~/presenters/v3/WaitpointTagListPresenter.server";
import { requireUserId } from "~/services/session.server";

const Params = z.object({
  organizationSlug: z.string(),
  projectParam: z.string(),
  envParam: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = Params.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Not Found", { status: 404 });
  }

  const search = new URL(request.url).searchParams;
  const name = search.get("name");

  const presenter = new WaitpointTagListPresenter();
  const result = await presenter.call({
    environmentId: environment.id,
    name: name ? decodeURIComponent(name) : undefined,
  });
  return result;
}
