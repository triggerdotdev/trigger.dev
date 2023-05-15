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
import { apiConnectionRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import { apiCatalog } from "~/services/externalApis/apiCatalog.server";
import type { ExternalApi } from "~/services/externalApis/types";
import { requireUser } from "~/services/session.server";
import { formatDateTime } from "~/utils";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");
  const organization = await getOrganizationFromSlug({
    userId: user.id,
    slug: organizationSlug,
  });
  invariant(organization, "Organization not found");

  const connections = await apiConnectionRepository.getAllConnections(
    organization.id
  );

  return typedjson({
    connections,
    apis: apiCatalog.getApis(),
  });
};

export default function Integrations() {
  const { connections, apis } = useTypedLoaderData<typeof loader>();
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");

  const orderedApis = Object.values(apis).sort((a, b) =>
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
          <div>
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
          </div>
          <div className="mt-8">
            {orderedApis.map((api) => {
              const authMethods = Object.entries(api.authenticationMethods);
              if (authMethods.length === 1) {
                return (
                  <ConnectButton
                    key={api.identifier}
                    api={api}
                    authMethodKey={Object.keys(api.authenticationMethods)[0]}
                    organizationId={organization.id}
                  >
                    <AddApiConnection api={api} />
                  </ConnectButton>
                );
              }

              return (
                <Popover key={api.identifier}>
                  <PopoverTrigger>
                    <AddApiConnection api={api} />
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
                            api={api}
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

function AddApiConnection({ api }: { api: ExternalApi }) {
  return (
    <div className="flex h-20 w-full items-center justify-between gap-2 px-10">
      <NamedIconInBox
        name={api.identifier}
        className="h-9 w-9 transition group-hover:opacity-80"
      />
      <span className="text-base text-slate-200">{api.name}</span>
      <PlusIcon className="h-4 w-4 text-slate-600" />
    </div>
  );
}
