import invariant from "tiny-invariant";
import { Container } from "~/components/layout/Container";
import { Title } from "~/components/primitives/text/Title";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";

export default function NewWorkflowPage() {
  const environment = useCurrentEnvironment();
  const currentOrganization = useCurrentOrganization();
  invariant(currentOrganization, "Organization must be defined");
  invariant(environment, "Environment must be defined");

  return (
    <Container>
      <Title>Deploy a new workflow</Title>
    </Container>
  );
}
