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
import { rbac } from "~/services/rbac.server";
import { ssoController } from "~/services/sso.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const [isUsingPlugin, isSsoUsingPlugin] = await Promise.all([
    rbac.isUsingPlugin(),
    ssoController.isUsingPlugin(),
  ]);
  return typedjson({
    buildInfo: {
      appVersion: process.env.BUILD_APP_VERSION,
      packageVersion: coreVersion,
      gitSha: process.env.BUILD_GIT_SHA,
      gitRefName: process.env.BUILD_GIT_REF_NAME,
      buildTimestampSeconds: process.env.BUILD_TIMESTAMP_SECONDS,
    } satisfies BuildInfo,
    isUsingPlugin,
    isSsoUsingPlugin,
  });
};

export default function Page() {
  const { buildInfo, isUsingPlugin, isSsoUsingPlugin } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();

  return (
    <AppContainer>
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
        <OrganizationSettingsSideMenu
          organization={organization}
          buildInfo={buildInfo}
          isUsingPlugin={isUsingPlugin}
          isSsoUsingPlugin={isSsoUsingPlugin}
        />
        <MainBody>
          <Outlet />
        </MainBody>
      </div>
    </AppContainer>
  );
}
