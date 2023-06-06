import type { LoaderArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import simplur from "simplur";
import invariant from "tiny-invariant";
import { OAuthConnectSheet } from "~/components/integrations/OAuthConnectSheet";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
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
import { useOrganization } from "~/hooks/useOrganizations";
import { IntegrationsPresenter } from "~/presenters/IntegrationsPresenter.server";
import { Integration } from "~/services/externalApis/types";
import { requireUser } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import { Handle } from "~/utils/handle";
import { docsPath } from "~/utils/pathBuilder";

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
  const [integrationFilterText, setIntegrationFilterText] = useState("");

  const visibleIntegrations = useMemo(() => {
    if (integrationFilterText === "") {
      return integrations;
    }

    return integrations.filter((integration) => {
      if (
        integration.name
          .toLowerCase()
          .includes(integrationFilterText.toLowerCase())
      )
        return true;

      return false;
    });
  }, [integrations, integrationFilterText]);

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
        <div className="grid h-full grid-cols-2">
          <div>
            <Header2>Connect an Integration</Header2>
            <Input
              placeholder="Search integrations"
              className="mb-2"
              variant="medium"
              icon="search"
              fullWidth={true}
              value={integrationFilterText}
              onChange={(e) => setIntegrationFilterText(e.target.value)}
            />
            <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
              {visibleIntegrations.map((integration) => {
                const authMethods = Object.entries(
                  integration.authenticationMethods
                );
                if (authMethods.length === 1) {
                  return (
                    <OAuthConnectSheet
                      key={integration.identifier}
                      integration={integration}
                      authMethodKey={
                        Object.keys(integration.authenticationMethods)[0]
                      }
                      organizationId={organization.id}
                      className="min-w-[15rem] flex-shrink-0"
                      button={
                        <AddIntegrationConnection integration={integration} />
                      }
                    />
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
                          <OAuthConnectSheet
                            key={key}
                            integration={integration}
                            authMethodKey={key}
                            organizationId={organization.id}
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
                            <NamedIconInBox
                              name={client.integrationIdentifier}
                              className="flex-0 h-9 w-9 transition group-hover:border-slate-750"
                            />
                            <div className="flex-grow">
                              <div className="flex flex-col gap-0.5">
                                <Paragraph
                                  variant="base"
                                  className="m-0 mt-1 flex flex-1 items-center gap-2 text-left transition group-hover:text-bright"
                                >
                                  {client.integration.name}
                                  <Badge>{client.authMethod.name}</Badge>
                                </Paragraph>
                                <Header3 className="flex gap-2">
                                  <span>{client.title}</span>
                                </Header3>

                                {client.description && (
                                  <Paragraph>{client.description}</Paragraph>
                                )}
                                <Paragraph className="text-slate-400">
                                  {simplur`${client.scopesCount} scope[|s]`}
                                </Paragraph>
                                <Paragraph className="text-slate-400">
                                  {simplur`${client.jobCount} job[|s]`}
                                </Paragraph>
                                {client.customClientId && (
                                  <Paragraph className="text-slate-400">
                                    Custom client id: {client.customClientId}
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
