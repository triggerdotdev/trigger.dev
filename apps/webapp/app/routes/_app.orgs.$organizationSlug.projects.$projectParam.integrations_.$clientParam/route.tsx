import { Outlet } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ClipboardField } from "~/components/ClipboardField";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import {
  PageButtons,
  PageHeader,
  PageInfoGroup,
  PageInfoProperty,
  PageInfoRow,
  PageTabs,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
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
              label="Slug"
              value={<ClipboardField value={client.slug} variant="secondary" />}
            />
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
