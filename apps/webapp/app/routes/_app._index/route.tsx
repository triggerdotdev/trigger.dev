import { LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { getUsersInvites } from "~/models/member.server";
import { SelectBestProjectPresenter } from "~/presenters/SelectBestProjectPresenter.server";
import { requireUser } from "~/services/session.server";
import { invitesPath, newOrganizationPath, projectPath } from "~/utils/pathBuilder";

//this loader chooses the best project to redirect you to, ideally based on the cookie
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  //if there are invites then we should redirect to the invites page
  const invites = await getUsersInvites({ email: user.email });
  if (invites.length > 0) {
    return redirect(invitesPath());
  }

  const presenter = new SelectBestProjectPresenter();
  try {
    const { project, organization } = await presenter.call({ userId: user.id, request });
    //redirect them to the most appropriate project
    return redirect(projectPath(organization, project));
  } catch (e) {
    //this should only happen if the user has no projects, and no invites
    return redirect(newOrganizationPath());
  }
};
