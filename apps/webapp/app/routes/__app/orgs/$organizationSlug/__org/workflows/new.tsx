import { Outlet } from "@remix-run/react";
import { AppBody, AppLayoutTwoCol } from "~/components/layout/AppLayout";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import { OrganizationsSideMenu } from "~/components/navigation/SideMenu";
import { Title } from "~/components/primitives/text/Title";

export default function NewWorkflowPage() {
  return (
    <AppLayoutTwoCol>
      <OrganizationsSideMenu />
      <AppBody>
        <Header context="workflows" />
        <Container>
          <Title>Create a new workflow</Title>
          <Outlet />
        </Container>
      </AppBody>
    </AppLayoutTwoCol>
  );
}
