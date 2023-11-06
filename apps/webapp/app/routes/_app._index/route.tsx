import { LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { SelectBestProjectPresenter } from "~/presenters/SelectBestProjectPresenter.server";
import { requireUserId } from "~/services/session.server";
import { newOrganizationPath, projectPath } from "~/utils/pathBuilder";

//this loader chooses the best project to redirect you to, ideally based on the cookie
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);

  const presenter = new SelectBestProjectPresenter();
  try {
    const { project, organization } = await presenter.call({ userId, request });

    return redirect(projectPath(organization, project));
  } catch (e) {
    //this should only happen if the user has no projects
    return redirect(newOrganizationPath());
  }
};
