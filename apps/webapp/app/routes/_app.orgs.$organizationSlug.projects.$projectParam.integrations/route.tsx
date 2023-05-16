import { PlusIcon } from "@heroicons/react/24/outline";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { ConnectButton } from "~/components/integrations/ConnectButton";
import { Badge } from "~/components/primitives/Badge";
import { NamedIcon, NamedIconInBox } from "~/components/primitives/NamedIcon";
import { Header1, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getOrganizationFromSlug } from "~/models/organization.server";
import { apiAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import { requireUser } from "~/services/session.server";
import { formatDateTime } from "~/utils";
import { integrationCatalog } from "~/services/externalApis/integrationCatalog.server";
import { Handle } from "~/utils/handle";
import { Integration } from "~/services/externalApis/types";

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
    <div>
      {/* <OrganizationsSideMenu /> */}
      <div>
        {/* <Header context="workflows" /> */}
        <div>
          <div className="flex items-start justify-between">
            <Header1>API Integrations</Header1>
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
          <div className="mt-8">
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
      </div>
    </div>
  );
}

function AddIntegrationConnection({
  integration,
}: {
  integration: Integration;
}) {
  return (
    <div className="flex h-20 w-full items-center justify-between gap-2 px-10">
      <NamedIconInBox
        name={integration.identifier}
        className="h-9 w-9 transition group-hover:opacity-80"
      />
      <span className="text-base text-slate-200">{integration.name}</span>
      <PlusIcon className="h-4 w-4 text-slate-600" />
    </div>
  );
}
