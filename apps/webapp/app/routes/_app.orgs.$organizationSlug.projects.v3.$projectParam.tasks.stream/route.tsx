import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { TasksStreamPresenter } from "~/presenters/v3/TasksStreamPresenter.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema } from "~/utils/pathBuilder";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);

  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const presenter = new TasksStreamPresenter();
  return presenter.call({ request, projectSlug: projectParam, organizationSlug, userId });
}
