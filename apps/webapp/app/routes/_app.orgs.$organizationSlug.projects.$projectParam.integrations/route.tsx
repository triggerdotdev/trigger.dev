import type { LoaderArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import {
  UseDataFunctionReturn,
  typedjson,
  useTypedLoaderData,
} from "remix-typedjson";
import simplur from "simplur";
import invariant from "tiny-invariant";
import { OAuthConnectSheet } from "~/components/integrations/OAuthConnectSheet";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Input } from "~/components/primitives/Input";
import { NamedIcon, NamedIconInBox } from "~/components/primitives/NamedIcon";
import {
  PageButtons,
  PageDescription,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Popover,
  PopoverContent,
  PopoverSectionHeader,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { IntegrationsPresenter } from "~/presenters/IntegrationsPresenter.server";
import { Integration } from "~/services/externalApis/types";
import { requireUser } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import { Handle } from "~/utils/handle";
import { docsPath, integrationPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");

  const presenter = new IntegrationsPresenter();
  const data = await presenter.call({ userId: user.id, organizationSlug });

  return typedjson(data);
};

export const handle: Handle = {
  breadcrumb: {
    slug: "integrations",
  },
};

export default function Integrations() {
  const { clients, integrations } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Integrations" />
          <PageButtons>
            <LinkButton
              to={docsPath("/integrations/create")}
              variant="secondary/small"
              LeadingIcon="docs"
            >
              Create your own Integration
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
        <PageDescription>
          Easily use an Integration, an existing Node.js SDK or make HTTP calls
          from a Job.
        </PageDescription>
      </PageHeader>

      <PageBody>
        <div className="grid h-full max-w-full grid-cols-[1fr_2fr] overflow-hidden">
          <PossibleIntegrationsList
            integrations={integrations}
            organizationId={organization.id}
          />
          <ConnectedIntegrationsList
            clients={clients}
            organization={organization}
            project={project}
          />
        </div>
      </PageBody>
    </PageContainer>
  );
}

function PossibleIntegrationsList({
  integrations,
  organizationId,
}: {
  integrations: UseDataFunctionReturn<typeof loader>["integrations"];
  organizationId: string;
}) {
  const [filter, setFilter] = useState("");

  const visibleIntegrations = useMemo(() => {
    if (filter === "") {
      return integrations;
    }

    return integrations.filter((integration) => {
      if (integration.name.toLowerCase().includes(filter.toLowerCase()))
        return true;

      return false;
    });
  }, [integrations, filter]);

  return (
    <div>
      <Header2 className="mb-2">Connect an Integration</Header2>
      <Input
        placeholder="Search integrations"
        className="mb-2"
        variant="medium"
        icon="search"
        fullWidth={true}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
        {visibleIntegrations.map((integration) => {
          const authMethods = Object.entries(integration.authenticationMethods);
          if (authMethods.length === 1) {
            return (
              <OAuthConnectSheet
                key={integration.identifier}
                integration={integration}
                authMethodKey={
                  Object.keys(integration.authenticationMethods)[0]
                }
                organizationId={organizationId}
                className="min-w-[15rem] flex-shrink-0"
                button={<AddIntegrationConnection integration={integration} />}
              />
            );
          }

          return (
            <Popover key={integration.identifier}>
              <PopoverTrigger className="min-w-[15rem] flex-shrink-0">
                <AddIntegrationConnection integration={integration} />
              </PopoverTrigger>
              <PopoverContent className="w-80 p-0" side="bottom" align="start">
                <PopoverSectionHeader title="Select your authentication method" />

                <div className="flex flex-col p-1">
                  {authMethods.map(([key, method]) => (
                    <OAuthConnectSheet
                      key={key}
                      integration={integration}
                      authMethodKey={key}
                      organizationId={organizationId}
                      button={
                        <div className="flex gap-2 rounded-sm p-2 hover:bg-slate-800">
                          <NamedIcon name="globe" className="h-5 w-5" />
                          <div className="">
                            <Header3 className="text-left">
                              {method.name}
                            </Header3>
                            {method.description && (
                              <Paragraph variant="small" className="m-0">
                                {method.description}
                              </Paragraph>
                            )}
                          </div>
                        </div>
                      }
                    />
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          );
        })}
      </div>
    </div>
  );
}

function ConnectedIntegrationsList({
  clients,
  organization,
  project,
}: {
  clients: UseDataFunctionReturn<typeof loader>["clients"];
  organization: Organization;
  project: Project;
}) {
  return (
    <div className="ml-2 h-full overflow-hidden border-l border-slate-900 pl-4">
      <Help>
        <HelpContent title="How to connect an integration">
          <Paragraph>This is some help content</Paragraph>
        </HelpContent>
        <div className="mb-2 flex items-center justify-between">
          <Header2 className="m-0">Your connected Integrations</Header2>
          <HelpTrigger title="How do I connect an Integration?" />
        </div>
        <div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>API</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Jobs</TableHeaderCell>
                <TableHeaderCell>Scopes</TableHeaderCell>
                <TableHeaderCell>Client id</TableHeaderCell>
                <TableHeaderCell>Added</TableHeaderCell>
                <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.length === 0 ? (
                <TableBlankRow colSpan={8}>
                  <div className="flex items-center justify-center">
                    <Callout variant="warning" className="w-auto">
                      You have no connected integrations yet. To connect an
                      integration, select one from the list.
                    </Callout>
                  </div>
                </TableBlankRow>
              ) : (
                <>
                  {clients.map((client) => {
                    const path = integrationPath(organization, project, client);
                    return (
                      <TableRow key={client.id}>
                        <TableCell to={path}>{client.title}</TableCell>
                        <TableCell to={path}>
                          <span className="flex items-center gap-1">
                            <NamedIcon
                              name={client.integrationIdentifier}
                              className="h-5 w-5"
                            />
                            {client.integration.name}
                          </span>
                        </TableCell>
                        <TableCell to={path}>
                          {client.authMethod.name}
                        </TableCell>
                        <TableCell to={path}>{client.jobCount}</TableCell>
                        <TableCell to={path}>{client.scopesCount}</TableCell>
                        <TableCell to={path}>
                          <SimpleTooltip
                            button={
                              client.customClientId ? (
                                `${client.customClientId.substring(0, 8)}…`
                              ) : (
                                <span className="text-slate-600">Auto</span>
                              )
                            }
                            content={
                              client.customClientId
                                ? client.customClientId
                                : "This uses the Trigger.dev OAuth client"
                            }
                          />
                        </TableCell>
                        <TableCell to={path}>
                          {formatDateTime(client.createdAt, "medium")}
                        </TableCell>
                        <TableCellChevron to={path} />
                      </TableRow>
                    );
                  })}
                </>
              )}
            </TableBody>
          </Table>
        </div>
      </Help>
    </div>
  );
}

function AddIntegrationConnection({
  integration,
}: {
  integration: Integration;
}) {
  return (
    <div className="group flex h-11 w-full items-center gap-3 rounded-md p-1 pr-3 transition hover:bg-slate-850">
      <NamedIconInBox
        name={integration.identifier}
        className="flex-0 h-9 w-9 transition group-hover:border-slate-750"
      />
      <Paragraph
        variant="base"
        className="m-0 flex-1 text-left transition group-hover:text-bright"
      >
        {integration.name}
      </Paragraph>
      <NamedIcon
        name="plus"
        className="h-6 w-6 flex-none text-slate-700 transition group-hover:text-bright"
      />
    </div>
  );
}
