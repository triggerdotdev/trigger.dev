import { Outlet } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { connectionType } from "~/components/integrations/connectionType";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DateTime } from "~/components/primitives/DateTime";
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
import { useTypedMatchData } from "~/hooks/useTypedMatchData";
import { IntegrationClientPresenter } from "~/presenters/IntegrationClientPresenter.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import {
  IntegrationClientParamSchema,
  integrationClientConnectionsPath,
  integrationClientPath,
  integrationClientScopesPath,
  organizationIntegrationsPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, clientParam } = IntegrationClientParamSchema.parse(params);

  const presenter = new IntegrationClientPresenter();
  const client = await presenter.call({
    userId,
    organizationSlug,
    clientSlug: clientParam,
  });

  if (!client) {
    throw new Response("Not found", { status: 404 });
  }

  return typedjson({ client });
};

export const handle: Handle = {
  breadcrumb: (match) => {
    const data = useTypedMatchData<typeof loader>(match);
    return <BreadcrumbLink to={match.pathname} title={data?.client.title ?? "Integration"} />;
  },
};

export default function Integrations() {
  const { client } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();

  let tabs = [
    {
      label: "Jobs",
      to: integrationClientPath(organization, client),
    },
  ];

  if (client.authMethod.type !== "local") {
    tabs.push({
      label: "Connections",
      to: integrationClientConnectionsPath(organization, client),
    });
    tabs.push({
      label: "Scopes",
      to: integrationClientScopesPath(organization, client),
    });
  }

  return (
    <PageContainer>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle
            title={client.title}
            backButton={{
              to: organizationIntegrationsPath(organization),
              text: "Integrations",
            }}
          />
        </PageTitleRow>
        <PageInfoRow>
          <PageInfoGroup>
            <PageInfoProperty
              label="ID"
              value={<ClipboardField value={client.slug} variant="tertiary/small" />}
            />
            <PageInfoProperty
              icon={client.integration.icon ?? client.integration.identifier}
              label="API"
              value={client.integration.name}
            />
            <PageInfoProperty label="Method" value={client.authMethod.name} />
            <PageInfoProperty label="Type" value={connectionType(client.type)} />
            <PageInfoProperty icon="job" label="Jobs" value={client.jobCount} />
            <PageInfoProperty
              icon="key"
              label="Client id"
              value={client.customClientId ? client.customClientId : "Auto"}
            />
            <PageInfoProperty
              icon="calendar"
              label="Added"
              value={<DateTime date={client.createdAt} />}
            />
          </PageInfoGroup>
        </PageInfoRow>
        <PageTabs layoutId="integrations" tabs={tabs} />
      </PageHeader>

      <PageBody scrollable={true}>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}
