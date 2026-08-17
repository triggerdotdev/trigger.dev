import { Outlet, useRouteLoaderData } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { VERSION as coreVersion } from "@trigger.dev/core";
import { type ReactNode } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { AppContainer, MainBody } from "~/components/layout/AppLayout";
import {
  type BuildInfo,
  OrganizationSettingsSideMenu,
} from "~/components/navigation/OrganizationSettingsSideMenu";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { rbac } from "~/services/rbac.server";
import { getUserId } from "~/services/session.server";
import { ssoController } from "~/services/sso.server";
import { isSupportChannelEnabled } from "~/services/supportChannelFlag.server";

const SETTINGS_ROUTE_ID = "routes/_app.orgs.$organizationSlug.settings";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await getUserId(request);
  const organization = userId
    ? await prisma.organization.findFirst({
        where: { slug: params.organizationSlug ?? "", members: { some: { userId } } },
        select: { id: true },
      })
    : null;

  const [isUsingPlugin, isSsoUsingPlugin, supportChannelEnabled] = await Promise.all([
    rbac.isUsingPlugin(),
    ssoController.isUsingPlugin(),
    organization ? isSupportChannelEnabled(organization.id) : Promise.resolve(false),
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
    supportChannelEnabled,
  });
};

function SettingsChrome({
  buildInfo,
  isUsingPlugin,
  isSsoUsingPlugin,
  supportChannelEnabled,
  children,
}: {
  buildInfo: BuildInfo;
  isUsingPlugin: boolean;
  isSsoUsingPlugin: boolean;
  supportChannelEnabled: boolean;
  children: ReactNode;
}) {
  const organization = useOrganization();

  return (
    <AppContainer>
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
        <OrganizationSettingsSideMenu
          organization={organization}
          buildInfo={buildInfo}
          isUsingPlugin={isUsingPlugin}
          isSsoUsingPlugin={isSsoUsingPlugin}
          supportChannelEnabled={supportChannelEnabled}
        />
        <MainBody>{children}</MainBody>
      </div>
    </AppContainer>
  );
}

export default function Page() {
  const { buildInfo, isUsingPlugin, isSsoUsingPlugin, supportChannelEnabled } =
    useTypedLoaderData<typeof loader>();

  return (
    <SettingsChrome
      buildInfo={buildInfo}
      isUsingPlugin={isUsingPlugin}
      isSsoUsingPlugin={isSsoUsingPlugin}
      supportChannelEnabled={supportChannelEnabled}
    >
      <Outlet />
    </SettingsChrome>
  );
}

// Reconstruct the settings chrome so a permission denial or error on a settings
// page renders in the content pane with the settings nav intact. This route's
// loader has already run (the error comes from a child route), so its data is
// available via useRouteLoaderData.
export function ErrorBoundary() {
  const data = useRouteLoaderData(SETTINGS_ROUTE_ID) as
    | {
        buildInfo: BuildInfo;
        isUsingPlugin: boolean;
        isSsoUsingPlugin: boolean;
        supportChannelEnabled: boolean;
      }
    | undefined;

  if (!data) {
    return <RouteErrorDisplay />;
  }

  return (
    <SettingsChrome
      buildInfo={data.buildInfo}
      isUsingPlugin={data.isUsingPlugin}
      isSsoUsingPlugin={data.isSsoUsingPlugin}
      supportChannelEnabled={data.supportChannelEnabled}
    >
      <RouteErrorDisplay />
    </SettingsChrome>
  );
}
