import { Outlet } from "@remix-run/react";
import {
  AppLayoutThreeCol,
  AppLayoutTwoCol,
} from "~/components/layout/AppLayout";
import {
  OrganizationsSideMenu,
  OrganizationSideMenuCollapsed,
} from "~/components/navigation/SideMenu";

const isThreeColLayout = false;

export default function Layout() {
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
