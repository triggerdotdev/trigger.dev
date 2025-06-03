import { Outlet } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { VERSION as coreVersion } from "@trigger.dev/core";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AppContainer, MainBody } from "~/components/layout/AppLayout";
import {
  type BuildInfo,
  OrganizationSettingsSideMenu,
} from "~/components/navigation/OrganizationSettingsSideMenu";
import { useOrganization } from "~/hooks/useOrganizations";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  return typedjson({
    buildInfo: {
      appVersion: process.env.BUILD_APP_VERSION,
      packageVersion: coreVersion,
      gitSha: process.env.BUILD_GIT_SHA,
      gitRefName: process.env.BUILD_GIT_REF_NAME,
      buildTimestampSeonds: process.env.BUILD_TIMESTAMP_SECONDS,
    } satisfies BuildInfo,
  });
};

export default function Page() {
  const { buildInfo } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();

  return (
    <AppContainer>
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
        <OrganizationSettingsSideMenu organization={organization} buildInfo={buildInfo} />
        <MainBody>
          <Outlet />
        </MainBody>
      </div>
    </AppContainer>
  );
}
