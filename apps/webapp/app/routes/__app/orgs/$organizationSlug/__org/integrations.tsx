import { PlusCircleIcon } from "@heroicons/react/24/solid";
import type { LoaderArgs } from "@remix-run/server-runtime";
import type { CatalogIntegration } from "internal-catalog";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { ConnectButton, Status } from "~/components/integrations/ConnectButton";
import { Container } from "~/components/layout/Container";
import { List } from "~/components/layout/List";
import { Body } from "~/components/primitives/text/Body";
import {
  Header1,
  Header2,
  Header3,
} from "~/components/primitives/text/Headers";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getConnectedApiConnectionsForOrganizationSlug } from "~/models/apiConnection.server";
import { getIntegrations } from "~/models/integrations.server";
import { requireUserId } from "~/services/session.server";
import { formatDateTime } from "~/utils";

export const loader = async ({ request, params }: LoaderArgs) => {
  await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");

  const connections = await getConnectedApiConnectionsForOrganizationSlug({
    slug: organizationSlug,
  });

  return typedjson({ connections, integrations: getIntegrations() });
};

export default function Integrations() {
  const { connections, integrations } = useTypedLoaderData<typeof loader>();
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");

  return (
    <Container>
      <Header1 className="mb-6">API Integrations</Header1>
      <div>
        {connections.length === 0 ? (
          <></>
        ) : (
          <>
            <Header2 size="small" className="mb-2 text-slate-400">
              {connections.length} connected integration
              {connections.length > 1 ? "s" : ""}
            </Header2>
            <List>
              {connections.map((connection) => (
                <li key={connection.id}>
                  <div className="flex gap-4 items-center px-4 py-4">
                    <img
                      className="h-6 w-6"
                      src={
                        integrations.find(
                          (i) => i.slug === connection.apiIdentifier
                        )?.icon
                      }
                      alt="Github integration logo"
                    />
                    <div className="flex flex-col gap-2">
                      <div>
                        <Header3 size="small" className="truncate font-medium">
                          {connection.title}
                        </Header3>
                        <Body size="small" className="text-slate-400">
                          Added {formatDateTime(connection.createdAt)}
                        </Body>
                      </div>
                      {/* <div className="flex items-center gap-1">
                        <ArrowsRightLeftIcon
                          className="h-5 w-5 flex-shrink-0 text-slate-400"
                          aria-hidden="true"
                        />
                        <Body size="small" className="text-slate-400">
                          Active in 100,000 workflows
                        </Body>
                      </div> */}
                    </div>
                  </div>
                </li>
              ))}
            </List>
          </>
        )}
      </div>

      <div>
        <Header2 size="small" className="mb-2 text-slate-400">
          Add an integration
        </Header2>
        <div className="flex flex-wrap gap-2 w-full">
          {integrations.map((integration) => (
            <ConnectButton
              key={integration.slug}
              integration={integration}
              organizationId={organization.id}
              className="flex flex-col group max-w-[160px] rounded-md bg-slate-800 border border-slate-800 gap-4 text-sm text-slate-200 items-center overflow-hidden hover:bg-slate-800/30 transition shadow-md disabled:opacity-50"
            >
              {(status) => (
                <AddButtonContent integration={integration} status={status} />
              )}
            </ConnectButton>
          ))}
        </div>
      </div>
    </Container>
  );
}

function AddButtonContent({
  integration,
  status,
}: {
  integration: CatalogIntegration;
  status: Status;
}) {
  return (
    <>
      <div className="relative flex items-center justify-center w-full py-6 bg-black/20 border-b border-slate-800">
        <PlusCircleIcon className="absolute h-7 w-7 top-[6px] right-[6px] z-10 text-slate-500 shadow-md" />
        <img
          src={integration.icon}
          alt={integration.name}
          className="h-20 group-hover:opacity-80 transition"
        />
      </div>

      {status === "loading" ? (
        <span className="px-6 pb-4">Connecting…</span>
      ) : (
        <span className="px-6 pb-4 leading-relaxed text-slate-400">
          Connect to{" "}
          <span className="text-slate-200 text-base">{integration.name}</span>
        </span>
      )}
    </>
  );
}
