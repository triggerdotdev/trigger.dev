import { Outlet } from "@remix-run/react";
import { AppLayoutThreeCol } from "~/components/layout/AppLayout";
import {
  CurrentOrganizationSideMenu,
  OrganizationSideMenuCollapsed,
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
        <AppLayoutThreeCol>
          <CurrentOrganizationSideMenu />
          <Outlet />
        </AppLayoutThreeCol>
      )}
    </>
  );
}
