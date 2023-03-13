import { Outlet } from "@remix-run/react";
import { AppBody, AppLayoutTwoCol } from "~/components/layout/AppLayout";
import { OrganizationsSideMenu } from "~/components/navigation/SideMenu";

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
