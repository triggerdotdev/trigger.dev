import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Container } from "~/components/layout/Container";
import { Body } from "~/components/primitives/text/Body";
import { Header1, Header2 } from "~/components/primitives/text/Headers";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { getConnectedApiConnectionsForOrganizationSlug } from "~/models/apiConnection.server";
import {
  ConnectButton,
  integrations,
} from "~/routes/resources/integration/connect";
import { requireUserId } from "~/services/session.server";

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
      <Header1>Integrations</Header1>
      <div>
        <Header2>Existing integrations</Header2>
        {connections.map((connection) => (
          <div key={connection.id}>
            <Body>{connection.title}</Body>
          </div>
        ))}
      </div>

      <div>
        <Header2>Add integration</Header2>
        {integrations.map((integration) => (
          <ConnectButton
            key={integration.key}
            integration={integration}
            organizationId={organization.id}
          />
        ))}
      </div>
    </Container>
  );
}
