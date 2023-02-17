import { Outlet } from "@remix-run/react";
import { Container } from "~/components/layout/Container";
import { Title } from "~/components/primitives/text/Title";

export default function NewWorkflowPage() {
  return (
    <Container>
      <Title>Create a new workflow</Title>
      <Outlet />
    </Container>
  );
}
