import { Outlet } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { connectionType } from "~/components/integrations/connectionType";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTabs,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { IntegrationClientPresenter } from "~/presenters/IntegrationClientPresenter.server";
import { requireUser } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import { Handle } from "~/utils/handle";
import {
  IntegrationClientParamSchema,
  integrationClientConnectionsPath,
  integrationClientPath,
  integrationClientScopesPath,
  projectIntegrationsPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, clientParam, projectParam } =
    IntegrationClientParamSchema.parse(params);

  const presenter = new IntegrationClientPresenter();
  const client = await presenter.call({
    userId: user.id,
    organizationSlug,
    projectSlug: projectParam,
    clientSlug: clientParam,
  });

  if (!client) {
    throw new Response("Not found", { status: 404 });
  }

  return typedjson({ client });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "integration",
  },
};

export default function Integrations() {
  const { client } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  let tabs = [
    {
      label: "Jobs",
      to: integrationClientPath(organization, project, client),
    },
  ];

  if (client.authMethod.type !== "local") {
    tabs.push({
      label: "Connections",
      to: integrationClientConnectionsPath(organization, project, client),
    });
    tabs.push({
      label: "Scopes",
      to: integrationClientScopesPath(organization, project, client),
    });
  }

  return (
    <PageContainer>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle
            title={client.title}
            backButton={{
              to: projectIntegrationsPath(organization, project),
              text: "Integrations",
            }}
          />
        </PageTitleRow>
        <PageInfoRow>
          <PageInfoGroup>
            <PageInfoProperty
              label="ID"
              value={
                <ClipboardField value={client.slug} variant="tertiary/small" />
              }
            />
            <PageInfoProperty
              icon={client.integration.identifier}
              label="API"
              value={client.integration.name}
            />
            <PageInfoProperty label="Method" value={client.authMethod.name} />
            <PageInfoProperty
              label="Type"
              value={connectionType(client.type)}
            />
            <PageInfoProperty icon="job" label="Jobs" value={client.jobCount} />
            <PageInfoProperty
              icon="key"
              label="Client id"
              value={client.customClientId ? client.customClientId : "Auto"}
            />
            <PageInfoProperty
              icon="calendar"
              label="Added"
              value={formatDateTime(client.createdAt)}
            />
          </PageInfoGroup>
        </PageInfoRow>
        <PageTabs tabs={tabs} />
      </PageHeader>

      <PageBody scrollable={true}>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}
