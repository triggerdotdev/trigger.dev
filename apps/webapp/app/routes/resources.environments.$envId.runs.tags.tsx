import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { RunTagListPresenter } from "~/presenters/v3/RunTagListPresenter.server";
import { requireUserId } from "~/services/session.server";

const Params = z.object({
  envId: z.string(),
});

const SearchParams = z.object({
  name: z.string().optional(),
  period: z.preprocess((value) => (value === "all" ? undefined : value), z.string().optional()),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { envId } = Params.parse(params);

  const environment = await $replica.runtimeEnvironment.findFirst({
    select: {
      id: true,
      projectId: true,
      organizationId: true,
    },
    where: { id: envId, organization: { members: { some: { userId } } } },
  });

  if (!environment) {
    throw new Response("Not Found", { status: 404 });
  }

  const search = new URL(request.url).searchParams;
  const name = search.get("name");
  const period = search.get("period");
  const from = search.get("from");
  const to = search.get("to");

  const parsedSearchParams = SearchParams.safeParse({
    name: name ? decodeURIComponent(name) : undefined,
    period: search.get("period") ?? undefined,
    from: search.get("from") ?? undefined,
    to: search.get("to") ?? undefined,
  });

  if (!parsedSearchParams.success) {
    throw new Response("Invalid search params", { status: 400 });
  }

  const presenter = new RunTagListPresenter();
  const result = await presenter.call({
    environmentId: environment.id,
    projectId: environment.projectId,
    organizationId: environment.organizationId,
    name: parsedSearchParams.data.name,
    createdAfter: parsedSearchParams.data.createdAfter,
  });
  return result;
}
