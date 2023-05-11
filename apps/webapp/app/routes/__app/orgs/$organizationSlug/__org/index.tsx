import { AppBody, AppLayoutTwoCol } from "~/components/layout/AppLayout";
import { OrganizationsSideMenu } from "~/components/navigation/SideMenu";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";

export default function Page() {
  const currentOrganization = useCurrentOrganization();
  const currentEnv = useDevEnvironment();

  if (currentOrganization === undefined) {
    return <></>;
  }

  if (currentEnv === undefined) {
    return <></>;
  }

  return (
    <AppLayoutTwoCol>
      <OrganizationsSideMenu />
      <AppBody>{/*TODO show new project button  */}</AppBody>
    </AppLayoutTwoCol>
  );
}
