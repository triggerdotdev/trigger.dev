import { AppBody } from "~/components/layout/AppLayout";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";

export default function Page() {
  const currentOrganization = useCurrentOrganization();
  const currentEnv = useDevEnvironment();

  return <AppBody>You have no projects</AppBody>;

  if (currentOrganization === undefined) {
    return <></>;
  }

  if (currentEnv === undefined) {
    return <></>;
  }

  return <AppBody>You have no projects</AppBody>;
}
