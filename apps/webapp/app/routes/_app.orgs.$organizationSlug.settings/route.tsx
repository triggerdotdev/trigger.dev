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
import { useOrganization } from "~/hooks/useOrganizations";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { organizationHasProjectRuntimeUpdate } from "~/services/projectRuntimeUpdates.server";
import { rbac } from "~/services/rbac.server";
import { requireUserId } from "~/services/session.server";
import { ssoController } from "~/services/sso.server";

const SETTINGS_ROUTE_ID = "routes/_app.orgs.$organizationSlug.settings";

// The side-menu dot links to the Projects settings page, which requires `read` on
// `deployments`, so gate the dot on the same ability the page checks.
async function canReadDeployments({
  request,
  userId,
  organizationSlug,
}: {
  request: Request;
  userId: string;
  organizationSlug: string;
}) {
  const organizationId = await resolveOrgIdFromSlug(organizationSlug);
  if (!organizationId) {
    return false;
  }

  const auth = await rbac.authenticateAuthorizeSession(
    request,
    { userId, organizationId },
    { action: "read", resource: { type: "deployments" } }
  );
  return auth.ok;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const organizationSlug = params.organizationSlug;

  const [isUsingPlugin, isSsoUsingPlugin, hasProjectRuntimeUpdate] = await Promise.all([
    rbac.isUsingPlugin(),
    ssoController.isUsingPlugin(),
    organizationSlug
      ? canReadDeployments({ request, userId, organizationSlug }).then((canRead) =>
          canRead ? organizationHasProjectRuntimeUpdate({ organizationSlug, userId }) : false
        )
      : Promise.resolve(false),
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
    hasProjectRuntimeUpdate,
  });
};

function SettingsChrome({
  buildInfo,
  isUsingPlugin,
  isSsoUsingPlugin,
  hasProjectRuntimeUpdate,
  children,
}: {
  buildInfo: BuildInfo;
  isUsingPlugin: boolean;
  isSsoUsingPlugin: boolean;
  hasProjectRuntimeUpdate: boolean;
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
          hasProjectRuntimeUpdate={hasProjectRuntimeUpdate}
        />
        <MainBody>{children}</MainBody>
      </div>
    </AppContainer>
  );
}

export default function Page() {
  const { buildInfo, isUsingPlugin, isSsoUsingPlugin, hasProjectRuntimeUpdate } =
    useTypedLoaderData<typeof loader>();

  return (
    <SettingsChrome
      buildInfo={buildInfo}
      isUsingPlugin={isUsingPlugin}
      isSsoUsingPlugin={isSsoUsingPlugin}
      hasProjectRuntimeUpdate={hasProjectRuntimeUpdate}
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
        hasProjectRuntimeUpdate: boolean;
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
      hasProjectRuntimeUpdate={data.hasProjectRuntimeUpdate}
    >
      <RouteErrorDisplay />
    </SettingsChrome>
  );
}
