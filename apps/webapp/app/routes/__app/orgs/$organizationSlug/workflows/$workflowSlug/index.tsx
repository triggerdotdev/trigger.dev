import invariant from "tiny-invariant";
import { integrations } from "~/components/integrations/ConnectButton";
import { ConnectionSelector } from "~/components/integrations/ConnectionSelector";
import { Panel } from "~/components/layout/Panel";
import { Header1, Header2 } from "~/components/primitives/text/Headers";
import { useCurrentOrganization } from "~/hooks/useOrganizations";

export default function Page() {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");

  return (
    <>
      <Header1>Overview</Header1>
      <div>Pending API integrations panel will go here </div>
      <Panel>
        <Header2 size="small">API integrations</Header2>
        <div className="flex flex-col gap-1 items-stretch w-full">
          <ConnectionSelector
            organizationId={organization.id}
            integration={integrations[0]}
            connections={[
              {
                id: "1",
                title: "GitHub #1",
              },
              {
                id: "2",
                title: "GitHub #2",
              },
            ]}
          />
          <ConnectionSelector
            organizationId={organization.id}
            integration={integrations[0]}
            connections={[]}
          />
        </div>
      </Panel>
      <div>Test functionality will go here</div>
    </>
  );
}
