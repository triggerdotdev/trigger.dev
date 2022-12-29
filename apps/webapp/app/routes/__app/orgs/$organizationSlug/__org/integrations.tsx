import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Container } from "~/components/layout/Container";
import { Body } from "~/components/primitives/text/Body";
import {
  Header1,
  Header2,
  Header3,
} from "~/components/primitives/text/Headers";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getConnectedApiConnectionsForOrganizationSlug } from "~/models/apiConnection.server";
import {
  ConnectButton,
  integrations,
} from "~/components/integrations/ConnectButton";
import { requireUserId } from "~/services/session.server";
import logoGithub from "~/assets/images/integrations/logo-github.png";
import { ArrowsRightLeftIcon } from "@heroicons/react/24/outline";
import { List } from "~/components/layout/List";
import { PlusCircleIcon } from "@heroicons/react/24/solid";

export const loader = async ({ request, params }: LoaderArgs) => {
  await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");

  const connections = await getConnectedApiConnectionsForOrganizationSlug({
    slug: organizationSlug,
  });

  return typedjson({ connections });
};

export default function Integrations() {
  const { connections } = useTypedLoaderData<typeof loader>();
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
                      className="h-14 w-14 shadow-md"
                      src={logoGithub}
                      alt="Github integration logo"
                    />
                    <div className="flex flex-col gap-2">
                      <Header3 size="small" className="truncate font-medium">
                        {connection.title}
                      </Header3>
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
              key={integration.key}
              integration={integration}
              organizationId={organization.id}
              className="flex flex-col group max-w-[160px] rounded-md bg-slate-800 border border-slate-800 gap-4 text-sm text-slate-200 items-center overflow-hidden hover:bg-slate-800/30 transition shadow-md disabled:opacity-50"
            >
              {(status) => (
                <>
                  <div className="relative flex items-center justify-center w-full py-6 bg-black/20 border-b border-slate-800">
                    <PlusCircleIcon className="absolute h-7 w-7 top-[16px] right-[28px] z-10 text-slate-200 shadow-md" />
                    <img
                      src={integration.logo}
                      alt={integration.name}
                      className="h-20 shadow-lg group-hover:opacity-80 transition"
                    />
                  </div>

                  {status === "loading" ? (
                    <span className="px-6 pb-4">Connecting…</span>
                  ) : (
                    <span className="px-6 pb-4 leading-relaxed text-slate-400">
                      Connect to{" "}
                      <span className="text-slate-200 text-base">
                        {integration.name}
                      </span>
                    </span>
                  )}
                </>
              )}
            </ConnectButton>
          ))}
        </div>
      </div>
    </Container>
  );
}
