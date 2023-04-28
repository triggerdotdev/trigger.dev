import {
  CursorArrowRaysIcon,
  PlusCircleIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { SliderButton } from "@typeform/embed-react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { NamedIcon, NamedIconInBox } from "~/components/Icon";
import { ConnectButton } from "~/components/integrations/ConnectButton";
import { AppBody, AppLayoutTwoCol } from "~/components/layout/AppLayout";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import { List } from "~/components/layout/List";
import { OrganizationsSideMenu } from "~/components/navigation/SideMenu";
import {
  SecondaryButton,
  primaryClasses,
  secondaryClasses,
} from "~/components/primitives/Buttons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import { Body } from "~/components/primitives/text/Body";
import { Header3 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getOrganizationFromSlug } from "~/models/organization.server";
import { apiConnectionRepository } from "~/services/externalApis/apiAuthenticationRepository.server";
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

  const connections = await apiConnectionRepository.getAllConnections(
    organization.id
  );

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

  const orderedApis = Object.values(apis).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

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
                                {connection.title} - {connection.slug}
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
                            className={secondaryClasses}
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
        </Container>
      </AppBody>
    </AppLayoutTwoCol>
  );
}

function AddApiConnection({ api }: { api: ExternalAPI }) {
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
