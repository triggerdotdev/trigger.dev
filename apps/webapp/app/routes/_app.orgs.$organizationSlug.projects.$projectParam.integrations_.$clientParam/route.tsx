import { Outlet } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import simplur from "simplur";
import invariant from "tiny-invariant";
import { PageContainer, PageBody } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { PageInfoRow } from "~/components/primitives/PageHeader";
import { PageInfoProperty } from "~/components/primitives/PageHeader";
import { PageTabs } from "~/components/primitives/PageHeader";
import {
  PageHeader,
  PageTitleRow,
  PageTitle,
  PageButtons,
  PageDescription,
  PageInfoGroup,
} from "~/components/primitives/PageHeader";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { IntegrationClientPresenter } from "~/presenters/IntegrationClientPresenter.server";
import { IntegrationsPresenter } from "~/presenters/IntegrationsPresenter.server";
import { requireUser } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import { Handle } from "~/utils/handle";
import {
  docsPath,
  integrationClientConnectionsPath,
  integrationClientPath,
  integrationClientScopesPath,
  projectIntegrationsPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, clientParam } = params;
  invariant(organizationSlug, "Organization slug must be defined");
  invariant(clientParam, "Client param must be defined");

  const presenter = new IntegrationClientPresenter();
  const client = await presenter.call({
    userId: user.id,
    organizationSlug,
    clientSlug: clientParam,
  });

  if (!client) {
    throw new Response("Not found", { status: 404 });
  }

  return typedjson({ client });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "integrations",
  },
};

export default function Integrations() {
  const { client } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

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
              icon="calendar"
              label="Created"
              value={formatDateTime(client.createdAt)}
            />
            <PageInfoProperty icon="job" label="Jobs" value={client.jobCount} />
            <PageInfoProperty
              icon="key"
              label="Client id"
              value={client.customClientId ? client.customClientId : "Auto"}
            />
          </PageInfoGroup>
        </PageInfoRow>
        <PageTabs
          tabs={[
            {
              label: "Jobs",
              to: integrationClientPath(organization, project, client),
            },
            {
              label: "Connections",
              to: integrationClientConnectionsPath(
                organization,
                project,
                client
              ),
            },
            {
              label: "Scopes",
              to: integrationClientScopesPath(organization, project, client),
            },
          ]}
        />
      </PageHeader>

      <PageBody scrollable={true}>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}
