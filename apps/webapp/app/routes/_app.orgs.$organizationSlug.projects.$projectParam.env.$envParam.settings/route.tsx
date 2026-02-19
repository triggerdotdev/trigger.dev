import { Outlet, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { useProject } from "~/hooks/useProject";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3ProjectSettingsGeneralPath } from "~/utils/pathBuilder";

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

  // Redirect /settings to /settings/general
  const url = new URL(request.url);
  if (url.pathname.endsWith("/settings") || url.pathname.endsWith("/settings/")) {
    return redirect(
      v3ProjectSettingsGeneralPath(
        { slug: organizationSlug },
        { slug: projectParam },
        { slug: envParam }
      )
    );
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
                <Property.Value>{project.id}</Property.Value>
                <div className="flex items-center gap-2">
                  <Paragraph variant="extra-small/bright/mono">{project.id}</Paragraph>
                </div>
              </Property.Item>
              <Property.Item>
                <Property.Label>Org ID</Property.Label>
                <Property.Value>{project.organizationId}</Property.Value>
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
