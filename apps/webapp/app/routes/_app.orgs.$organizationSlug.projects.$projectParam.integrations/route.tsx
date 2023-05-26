import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { ConnectButton } from "~/components/integrations/ConnectButton";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
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
import { useOrganization } from "~/hooks/useOrganizations";
import { getOrganizationFromSlug } from "~/models/organization.server";
import { apiAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import { integrationCatalog } from "~/services/externalApis/integrationCatalog.server";
import { Integration } from "~/services/externalApis/types";
import { requireUser } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import { Handle } from "~/utils/handle";
import { docsPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");
  const organization = await getOrganizationFromSlug({
    userId: user.id,
    slug: organizationSlug,
  });
  invariant(organization, "Organization not found");

  const clients = await apiAuthenticationRepository.getAllClients(
    organization.id
  );

  return typedjson({
    clients,
    integrations: integrationCatalog.getIntegrations(),
  });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "integrations",
  },
};

export default function Integrations() {
  const { clients, integrations } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();

  const orderedIntegrations = Object.values(integrations).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <PageContainer fullHeight>
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

      <PageBody fullHeight>
        <div className="grid h-full grid-cols-2">
          <div>
            <Header2>Connect an Integration</Header2>
            <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
              {orderedIntegrations.map((integration) => {
                const authMethods = Object.entries(
                  integration.authenticationMethods
                );
                if (authMethods.length === 1) {
                  return (
                    <ConnectButton
                      key={integration.identifier}
                      integration={integration}
                      authMethodKey={
                        Object.keys(integration.authenticationMethods)[0]
                      }
                      organizationId={organization.id}
                      className="min-w-[15rem] flex-shrink-0"
                    >
                      <AddIntegrationConnection integration={integration} />
                    </ConnectButton>
                  );
                }

                return (
                  <Popover key={integration.identifier}>
                    <PopoverTrigger className="min-w-[15rem] flex-shrink-0">
                      <AddIntegrationConnection integration={integration} />
                    </PopoverTrigger>
                    <PopoverContent
                      className="w-80 p-0"
                      side="bottom"
                      align="start"
                    >
                      <PopoverSectionHeader title="Select your authentication method" />

                      <div className="flex flex-col p-1">
                        {authMethods.map(([key, method]) => (
                          <ConnectButton
                            key={key}
                            integration={integration}
                            authMethodKey={key}
                            organizationId={organization.id}
                          >
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
                          </ConnectButton>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                );
              })}
            </div>
          </div>
          <div className="ml-2 h-full border-l border-slate-900 pl-4">
            <Help>
              <HelpContent title="How to connect an integration">
                <Paragraph>This is some help content</Paragraph>
              </HelpContent>
              <div className="flex items-center justify-between">
                <Header2 className="m-0">Your connected Integrations</Header2>
                <HelpTrigger title="How do I connect an Integration?" />
              </div>
              <div>
                {clients.length === 0 ? (
                  <></>
                ) : (
                  <>
                    <div>
                      {clients.map((client) => {
                        return (
                          <div
                            key={client.id}
                            className="flex items-start gap-2 px-3 py-3"
                          >
                            <NamedIcon
                              name={client.integrationIdentifier}
                              className="h-6 w-6"
                            />
                            <div className="flex-grow">
                              <div className="flex flex-col gap-0.5">
                                <Header3 className="flex gap-2">
                                  <span>{client.title}</span>
                                  <Badge>{client.authMethod.name}</Badge>
                                </Header3>

                                {client.description && (
                                  <Paragraph>{client.description}</Paragraph>
                                )}
                                {client.scopes && (
                                  <Paragraph className="text-slate-400">
                                    <span>Scopes:</span>{" "}
                                    {client.scopes.join(", ")}
                                  </Paragraph>
                                )}
                                <Paragraph className="text-slate-400">
                                  Added: {formatDateTime(client.createdAt)}
                                </Paragraph>
                              </div>
                            </div>
                            <div></div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </Help>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function AddIntegrationConnection({
  integration,
}: {
  integration: Integration;
}) {
  return (
    <div className="flex h-10 w-full items-center gap-3 rounded-md p-1 hover:bg-slate-800">
      <NamedIconInBox
        name={integration.identifier}
        className="flex-0 h-9 w-9 transition group-hover:opacity-80"
      />
      <Paragraph
        variant="base"
        className="m-0 flex-1 text-left group-hover:text-bright"
      >
        {integration.name}
      </Paragraph>
      <NamedIcon
        name="plus"
        className="h-5 w-5 flex-none text-slate-600 group-hover:text-bright"
      />
    </div>
  );
}
