import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { TasksStreamPresenter } from "~/presenters/v3/TasksStreamPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);

  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const presenter = new TasksStreamPresenter();
  return presenter.call({
    request,
    projectSlug: projectParam,
    environmentSlug: envParam,
    organizationSlug,
    userId,
  });
}
