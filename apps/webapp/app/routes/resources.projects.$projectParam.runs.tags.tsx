import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { RunTagListPresenter } from "~/presenters/v3/RunTagListPresenter.server";
import { requireUserId } from "~/services/session.server";

const Params = z.object({
  projectParam: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { projectParam } = Params.parse(params);

  const project = await $replica.project.findFirst({
    where: { slug: projectParam, deletedAt: null, organization: { members: { some: { userId } } } },
  });

  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const search = new URL(request.url).searchParams;
  const name = search.get("name");

  const presenter = new RunTagListPresenter();
  const result = await presenter.call({
    projectId: project.id,
    name: name ? decodeURIComponent(name) : undefined,
  });
  return result;
}
