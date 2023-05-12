import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";

export default function Page() {
  const currentOrganization = useCurrentOrganization();
  const currentEnv = useDevEnvironment();

  return <div>You have no projects</div>;

  if (currentOrganization === undefined) {
    return <></>;
  }

  if (currentEnv === undefined) {
    return <></>;
  }

  return <div>You have no projects</div>;
}
