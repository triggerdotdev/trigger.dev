import { Outlet } from "@remix-run/react";
import { AppBody, AppLayoutTwoCol } from "~/components/layout/AppLayout";
import { OrganizationsSideMenu } from "~/components/navigation/SideMenu";
import { LoaderArgs } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { requireUser } from "~/services/session.server";

export async function loader({ request, params }: LoaderArgs) {
  const user = await requireUser(request);
  const organizationSlug = params.organizationSlug as string;

  if (!user.featureCloud) {
    const url = new URL(request.url);

    if (!url.pathname.endsWith("/coming-soon")) {
      return redirect(`/orgs/${organizationSlug}/projects/coming-soon`, {
        status: 302,
      });
    }
  }

  return {};
}

export default function ProjectsLayout() {
  return (
    <AppLayoutTwoCol>
      <OrganizationsSideMenu />
      <AppBody>
        <Outlet />
      </AppBody>
    </AppLayoutTwoCol>
  );
}
