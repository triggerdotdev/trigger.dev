import {
  CursorArrowRaysIcon,
  PlusCircleIcon,
} from "@heroicons/react/24/outline";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { SliderButton } from "@typeform/embed-react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { NamedIcon } from "~/components/Icon";
import { ApiLogoIcon } from "~/components/code/ApiLogoIcon";
import { ConnectButton } from "~/components/integrations/ConnectButton";
import { AppBody, AppLayoutTwoCol } from "~/components/layout/AppLayout";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import { List } from "~/components/layout/List";
import { OrganizationsSideMenu } from "~/components/navigation/SideMenu";
import {
  primaryClasses,
  secondaryClasses,
} from "~/components/primitives/Buttons";
import { Body } from "~/components/primitives/text/Body";
import { Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getOrganizationFromSlug } from "~/models/organization.server";
import { APIAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
import { apiStore } from "~/services/externalApis/apiStore";
import type { ExternalAPI } from "~/services/externalApis/types";
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

  const authRepository = new APIAuthenticationRepository(organization.id);
  const connections = await authRepository.getAllConnections();

  const apis = apiStore.getApis();

  return typedjson({
    connections,
    apis,
  });
};

export default function Integrations() {
  const { connections, apis } = useTypedLoaderData<typeof loader>();
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");

  return (
    <AppLayoutTwoCol>
      <OrganizationsSideMenu />
      <AppBody>
        <Header context="workflows" />
        <Container>
          <div className="flex items-start justify-between">
            <Title>API Integrations</Title>
            <div className="flex items-center gap-2">
              {/* these caused a lot of React hydration errors in the console
               <TypeformRequestWorkflow />
              <TypeformRequestIntegration /> */}
            </div>
          </div>
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
                        <div className="flex items-start gap-2 px-3 py-3">
                          <NamedIcon
                            name={connection.apiIdentifier}
                            className="h-6 w-6"
                          />
                          <div className="flex-grow">
                            <div className="flex flex-col gap-0.5">
                              <Header3 size="small" className="truncate">
                                {connection.title}
                              </Header3>
                              {connection.metadata.account && (
                                <Body size="small" className="text-slate-400">
                                  Account: {connection.metadata.account}
                                </Body>
                              )}
                              {connection.scopes && (
                                <Body size="small" className="text-slate-400">
                                  <span>Scopes:</span>{" "}
                                  {connection.scopes.join(", ")}
                                </Body>
                              )}
                              <Body size="small" className="text-slate-400">
                                Added: {formatDateTime(connection.createdAt)}
                              </Body>
                            </div>
                          </div>
                          <div></div>
                        </div>
                      </li>
                    );
                  })}
                </List>
              </>
            )}
          </div>
          <div className="mt-8">
            {Object.values(apis).map((api) => (
              <ConnectButton
                key={api.identifier}
                api={api}
                organizationId={organization.id}
              >
                <AddApiConnection api={api} />
              </ConnectButton>
            ))}
          </div>
        </Container>
      </AppBody>
    </AppLayoutTwoCol>
  );
}

function AddApiConnection({ api }: { api: ExternalAPI }) {
  return (
    <>
      <div className="relative flex w-full items-center justify-center border-b border-slate-800 bg-black/20 py-6 px-10">
        <PlusCircleIcon className="absolute top-[6px] right-[6px] z-10 h-7 w-7 text-green-600 shadow-md" />
        <NamedIcon
          name={api.identifier}
          className="h-20 transition group-hover:opacity-80"
        />
      </div>

      <div className="flex flex-col px-3 pb-4">
        <span className="text-slate-400">Connect to</span>
        <span className="text-base text-slate-200">{api.name}</span>
      </div>
    </>
  );
}

const TypeformRequestWorkflow = () => {
  return (
    <SliderButton id="Rffdj2Ma" className={secondaryClasses}>
      <CursorArrowRaysIcon className="-ml-1 h-5 w-5" />
      Request a Workflow
    </SliderButton>
  );
};

const TypeformRequestIntegration = () => {
  return (
    <SliderButton id="VwblgGDZ" className={primaryClasses}>
      <CursorArrowRaysIcon className="-ml-1 h-5 w-5" />
      Request an Integration
    </SliderButton>
  );
};
