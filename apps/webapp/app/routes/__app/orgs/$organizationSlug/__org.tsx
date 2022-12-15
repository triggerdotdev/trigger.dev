import { Outlet } from "@remix-run/react";
import {
  SideMenuContainer,
  OrganizationsSideMenu,
} from "~/components/navigation/SideMenu";

export default function Layout() {
  return (
    <>
      <SideMenuContainer>
        <OrganizationsSideMenu />
        <Outlet />
      </SideMenuContainer>
    </>
  );
}
