import { Outlet, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import * as Property from "~/components/primitives/PropertyTable";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { CopyableText } from "~/components/primitives/CopyableText";
import { useProject } from "~/hooks/useProject";
import { requireUserId } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  v3ProjectSettingsGeneralPath,
  v3ProjectSettingsIntegrationsPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Project settings | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  // Redirect /settings to /settings/general (or /settings/integrations for Vercel onboarding)
  const url = new URL(request.url);
  if (url.pathname.endsWith("/settings") || url.pathname.endsWith("/settings/")) {
    const org = { slug: organizationSlug };
    const project = { slug: projectParam };
    const env = { slug: envParam };

    const basePath = url.searchParams.has("vercelOnboarding")
      ? v3ProjectSettingsIntegrationsPath(org, project, env)
      : v3ProjectSettingsGeneralPath(org, project, env);

    return redirect(`${basePath}${url.search}`);
  }

  return null;
};

export default function SettingsLayout() {
  const project = useProject();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Project settings" />

        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              <Property.Item>
                <Property.Label>ID</Property.Label>
                <Property.Value>
                  <CopyableText value={project.id} asChild hideTooltip />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Org ID</Property.Label>
                <Property.Value>
                  <CopyableText value={project.organizationId} asChild hideTooltip />
                </Property.Value>
              </Property.Item>
            </Property.Table>
          </AdminDebugTooltip>
        </PageAccessories>
      </NavBar>

      <PageBody>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}
