import invariant from "tiny-invariant";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { Connect, integrations } from "~/routes/resources/connection";

export default function Integrations() {
  const organization = useCurrentOrganization();
  invariant(organization, "Organization not found");

  return (
    <div>
      <h1>Integrations</h1>

      <div>
        {integrations.map((integration) => (
          <Connect
            key={integration.key}
            integration={integration}
            organizationId={organization.id}
          />
        ))}
      </div>
    </div>
  );
}
