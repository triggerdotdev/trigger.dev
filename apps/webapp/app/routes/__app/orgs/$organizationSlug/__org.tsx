import { Outlet } from "@remix-run/react";
import {
  AppLayoutThreeCol,
  AppLayoutTwoCol,
} from "~/components/layout/AppLayout";
import {
  OrganizationSideMenuCollapsed,
  OrganizationsSideMenu,
} from "~/components/navigation/SideMenu";
import { useIsOrgChildPage } from "~/hooks/useIsOrgChildPage";

export default function OrganizationLayout() {
  const isOrgChildPage = useIsOrgChildPage();

  return (
    <>
      {isOrgChildPage ? (
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
