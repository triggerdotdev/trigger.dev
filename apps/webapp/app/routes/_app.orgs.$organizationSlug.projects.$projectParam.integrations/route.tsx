import { PlusIcon } from "@heroicons/react/24/outline";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { ConnectButton } from "~/components/integrations/ConnectButton";
import { PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { NamedIcon, NamedIconInBox } from "~/components/primitives/NamedIcon";
import { PageBody } from "~/components/primitives/PageBody";
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
  PopoverTrigger,
} from "~/components/primitives/Popover";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getOrganizationFromSlug } from "~/models/organization.server";
import { apiAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import { integrationCatalog } from "~/services/externalApis/integrationCatalog.server";
import { Integration } from "~/services/externalApis/types";
import { requireUser } from "~/services/session.server";
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
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");

  const orderedIntegrations = Object.values(integrations).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

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
        <div className="grid grid-cols-2">
          <div>
            <Header2>Connect an Integration</Header2>
            <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
              {orderedIntegrations.map((integration) => {
                const authMethods = Object.entries(
                  integration.authenticationMethods
                );
                if (authMethods.length === 1) {
                  return (
                    <ConnectButton
                      key={integration.identifier}
                      api={integration}
                      authMethodKey={
                        Object.keys(integration.authenticationMethods)[0]
                      }
                      organizationId={organization.id}
                    >
                      <AddIntegrationConnection integration={integration} />
                    </ConnectButton>
                  );
                }

                return (
                  <Popover key={integration.identifier}>
                    <PopoverTrigger>
                      <AddIntegrationConnection integration={integration} />
                    </PopoverTrigger>
                    <PopoverContent className="w-80">
                      <div className="grid gap-4">
                        <div className="space-y-2">
                          <h4 className="font-medium leading-none">
                            Select your authentication method
                          </h4>
                        </div>
                        <div className="grid gap-2">
                          {authMethods.map(([key, method]) => (
                            <ConnectButton
                              key={key}
                              api={integration}
                              authMethodKey={key}
                              organizationId={organization.id}
                              className={
                                "overflow-hidden bg-indigo-500 text-white hover:opacity-90"
                              }
                            >
                              {method.name}
                            </ConnectButton>
                          ))}
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                );
              })}
            </div>
          </div>
          {/* <div>
            {connections.length === 0 ? (
              <></>
            ) : (
              <>
                <Header3>
                  {connections.length} connected API
                  {connections.length > 1 ? "s" : ""}
                </Header3>
                <div>
                  {connections.map((connection) => {
                    return (
                      <li key={connection.id}>
                        <div className="flex items-start gap-2 px-3 py-3">
                          <NamedIcon
                            name={connection.apiIdentifier}
                            className="h-6 w-6"
                          />
                          <div className="flex-grow">
                            <div className="flex flex-col gap-0.5">
                              <Header3 className="flex gap-2">
                                <span>{connection.title}</span>
                                <Badge>
                                  {connection.authenticationMethod.name}
                                </Badge>
                              </Header3>

                              {connection.metadata.account && (
                                <Paragraph className="text-slate-400">
                                  Account: {connection.metadata.account}
                                </Paragraph>
                              )}
                              {connection.scopes && (
                                <Paragraph className="text-slate-400">
                                  <span>Scopes:</span>{" "}
                                  {connection.scopes.join(", ")}
                                </Paragraph>
                              )}
                              <Paragraph className="text-slate-400">
                                Added: {formatDateTime(connection.createdAt)}
                              </Paragraph>
                            </div>
                          </div>
                          <div></div>
                        </div>
                      </li>
                    );
                  })}
                </div>
              </>
            )}
          </div> */}
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
        className="flex-0 h-5 w-5 text-slate-600 group-hover:text-bright"
      />
    </div>
  );
}
