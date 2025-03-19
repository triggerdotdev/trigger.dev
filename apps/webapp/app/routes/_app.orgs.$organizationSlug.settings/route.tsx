import { Outlet } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { VERSION } from "@trigger.dev/core";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AppContainer, MainBody } from "~/components/layout/AppLayout";
import { OrganizationSettingsSideMenu } from "~/components/navigation/OrganizationSettingsSideMenu";
import { useOrganization } from "~/hooks/useOrganizations";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  return typedjson({
    version: VERSION,
  });
};

export default function Page() {
  const { version } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();

  return (
    <AppContainer>
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
        <OrganizationSettingsSideMenu organization={organization} version={version} />
        <MainBody>
          <Outlet />
        </MainBody>
      </div>
    </AppContainer>
  );
}
