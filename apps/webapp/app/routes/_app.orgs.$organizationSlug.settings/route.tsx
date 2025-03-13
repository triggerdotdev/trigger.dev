import { Outlet } from "@remix-run/react";
import { AppContainer, MainBody } from "~/components/layout/AppLayout";
import { OrganizationSettingsSideMenu } from "~/components/navigation/OrganizationSettingsSideMenu";
import { useOrganization } from "~/hooks/useOrganizations";

export default function Page() {
  const organization = useOrganization();

  return (
    <AppContainer>
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
        <OrganizationSettingsSideMenu organization={organization} />
        <MainBody>
          <Outlet />
        </MainBody>
      </div>
    </AppContainer>
  );
}
