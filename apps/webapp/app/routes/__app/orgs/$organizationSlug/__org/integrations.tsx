import { EnvelopeIcon } from "@heroicons/react/24/outline";
import { PlusCircleIcon } from "@heroicons/react/24/solid";
import type { LoaderArgs } from "@remix-run/server-runtime";
import type { ServiceMetadata } from "@trigger.dev/integration-sdk";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { ApiLogoIcon } from "~/components/code/ApiLogoIcon";
import type { Status } from "~/components/integrations/ConnectButton";
import { ConnectButton } from "~/components/integrations/ConnectButton";
import { AppBody } from "~/components/layout/AppLayout";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import { List } from "~/components/layout/List";
import { Body } from "~/components/primitives/text/Body";
import { Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getConnectedApiConnectionsForOrganizationSlug } from "~/models/apiConnection.server";
import { getServiceMetadatas } from "~/models/integrations.server";
import { requireUser } from "~/services/session.server";
import { formatDateTime } from "~/utils";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);

  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");

  const connections = await getConnectedApiConnectionsForOrganizationSlug({
    slug: organizationSlug,
  });

  return typedjson({
    connections,
    services: await getServiceMetadatas(user.admin),
  });
};

export default function Integrations() {
  const { connections, services } = useTypedLoaderData<typeof loader>();
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");

  return (
    <AppBody>
      <Header />
      <Container>
        <Title>API Integrations</Title>
        <div>
          {connections.length === 0 ? (
            <></>
          ) : (
            <>
              <SubTitle>
                {connections.length} connected API
                {connections.length > 1 ? "s" : ""}
              </SubTitle>
              <List>
                {connections.map((connection) => {
                  return (
                    <li key={connection.id}>
                      <div className="flex items-center gap-4 px-4 py-4">
                        <ApiLogoIcon
                          integration={services[connection.apiIdentifier]}
                          size="regular"
                        />
                        <div className="flex flex-col gap-2">
                          <div>
                            <Header3
                              size="extra-small"
                              className="truncate font-medium"
                            >
                              {connection.title}
                            </Header3>
                            <Body size="small" className="text-slate-400">
                              Added {formatDateTime(connection.createdAt)}
                            </Body>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </List>
            </>
          )}
        </div>

        <div>
          <SubTitle>Add an API integration</SubTitle>
          <div className="flex w-full flex-wrap gap-2">
            {Object.values(services)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((integration) => (
                <ConnectButton
                  key={integration.service}
                  integration={integration}
                  organizationId={organization.id}
                  className="group flex max-w-[160px] flex-col items-center gap-4 overflow-hidden rounded-md border border-slate-800 bg-slate-800 text-sm text-slate-200 shadow-md transition hover:bg-slate-800/30 disabled:opacity-50"
                >
                  {(status) => (
                    <AddButtonContent
                      integration={integration}
                      status={status}
                    />
                  )}
                </ConnectButton>
              ))}
            <a
              href="mailto:hello@trigger.dev"
              className="group flex max-w-[160px] flex-col items-center gap-4 overflow-hidden rounded-md border border-slate-800 bg-slate-800 text-sm text-slate-200 shadow-md transition hover:bg-slate-800/30 disabled:opacity-50"
            >
              <div className="relative flex w-full items-center justify-center border-b border-slate-800 bg-black/20 py-6">
                <EnvelopeIcon className="h-20 w-20 text-slate-400" />
              </div>
              <div className="flex flex-col items-center justify-center text-center leading-relaxed text-slate-400">
                <span className="px-2.5">Need an integration?</span>
                <span className="mb-4 px-6 text-base text-slate-200">
                  Let us know!
                </span>
              </div>
            </a>
          </div>
        </div>
      </Container>
    </AppBody>
  );
}

function AddButtonContent({
  integration,
  status,
}: {
  integration: ServiceMetadata;
  status: Status;
}) {
  return (
    <>
      <div className="relative flex w-full items-center justify-center border-b border-slate-800 bg-black/20 py-6 px-10">
        <PlusCircleIcon className="absolute top-[6px] right-[6px] z-10 h-7 w-7 text-green-600 shadow-md" />
        <img
          src={integration.icon}
          alt={integration.name}
          className="h-20 transition group-hover:opacity-80"
        />
      </div>

      {status === "loading" ? (
        <div className="flex animate-pulse flex-col px-3 pb-4 leading-relaxed text-green-500">
          <span>Connecting to</span>
          <span className="text-base text-slate-200">{integration.name}</span>
        </div>
      ) : (
        <div className="flex flex-col px-3 pb-4">
          <span className="text-slate-400">Connect to</span>
          <span className="text-base text-slate-200">{integration.name}</span>
        </div>
      )}
    </>
  );
}
