import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { getUsersInvites } from "~/models/member.server";
import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { requireUser } from "~/services/session.server";
import { invitesPath, newOrganizationPath, newProjectPath } from "~/utils/pathBuilder";

//this loader chooses the best project to redirect you to, ideally based on the cookie
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const url = new URL(request.url);

  const presenter = new SelectBestEnvironmentPresenter();

  try {
    const { organization } = await presenter.call({ user: user });
    //redirect them to the most appropriate project
    return redirect(`${newProjectPath(organization)}${url.search}`);
  } catch (e) {
    const invites = await getUsersInvites({ email: user.email });

    if (invites.length > 0) {
      return redirect(invitesPath());
    }

    //this should only happen if the user has no projects, and no invites
    return redirect(newOrganizationPath());
  }
};
