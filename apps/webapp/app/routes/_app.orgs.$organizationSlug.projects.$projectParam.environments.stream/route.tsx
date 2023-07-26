import { LoaderArgs } from "@remix-run/server-runtime";
import { EnvironmentsStreamPresenter } from "~/presenters/EnvironmentsStreamPresenter.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  const presenter = new EnvironmentsStreamPresenter();
  return await presenter.call({
    request,
    userId,
    projectSlug: projectParam,
  });
};
