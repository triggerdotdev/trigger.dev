import { Outlet } from "@remix-run/react";
import { AppBody } from "~/components/layout/AppLayout";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import { Title } from "~/components/primitives/text/Title";

export default function NewWorkflowPage() {
  return (
    <AppBody>
      <Header />
      <Container>
        <Title>Create a new workflow</Title>
        <Outlet />
      </Container>
    </AppBody>
  );
}
