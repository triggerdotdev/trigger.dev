import { redirect, type ActionFunction, type LoaderFunction } from "@remix-run/node";
import { authenticator } from "~/services/auth.server";
import {
  clearCurrentProjectId,
  commitCurrentProjectSession,
  getCurrentProjectId,
} from "~/services/currentProject.server";
import { logoutPath } from "~/utils/pathBuilder";

export const action: ActionFunction = async ({ request }) => {
  const projectId = await getCurrentProjectId(request);
  if (projectId) {
    const removeProjectIdSession = await clearCurrentProjectId(request);
    return redirect(logoutPath(), {
      headers: {
        "Set-Cookie": await commitCurrentProjectSession(removeProjectIdSession),
      },
    });
  }

  return await authenticator.logout(request, { redirectTo: "/" });
};

export const loader: LoaderFunction = async ({ request }) => {
  const projectId = await getCurrentProjectId(request);
  if (projectId) {
    const removeProjectIdSession = await clearCurrentProjectId(request);
    return redirect(logoutPath(), {
      headers: {
        "Set-Cookie": await commitCurrentProjectSession(removeProjectIdSession),
      },
    });
  }

  return await authenticator.logout(request, { redirectTo: "/" });
};
