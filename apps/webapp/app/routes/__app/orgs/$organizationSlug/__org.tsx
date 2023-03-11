import { Outlet, useMatches } from "@remix-run/react";
import {
  AppLayoutThreeCol,
  AppLayoutTwoCol,
} from "~/components/layout/AppLayout";
import {
  OrganizationsSideMenu,
  OrganizationSideMenuCollapsed,
} from "~/components/navigation/SideMenu";

export default function OrganizationLayout() {
  const matchesData = useMatches();

  const isThreeColLayout = matchesData.some((matchData) => {
    return (
      matchData.id.startsWith(
        "routes/__app/orgs/$organizationSlug/__org/workflows/$workflowSlug"
      ) ||
      matchData.id.startsWith(
        "routes/__app/orgs/$organizationSlug/__org/projects/$projectP"
      )
    );
  });

  return (
    <>
      {isThreeColLayout ? (
        <AppLayoutThreeCol>
          <OrganizationSideMenuCollapsed />
          <Outlet />
        </AppLayoutThreeCol>
      ) : (
        <AppLayoutTwoCol>
          <OrganizationsSideMenu />
          <Outlet />
        </AppLayoutTwoCol>
      )}
    </>
  );
}
