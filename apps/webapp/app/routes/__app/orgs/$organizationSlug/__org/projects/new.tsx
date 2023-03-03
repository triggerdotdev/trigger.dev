import { Outlet } from "@remix-run/react";
import { Container } from "~/components/layout/Container";
import { Title } from "~/components/primitives/text/Title";

export default function NewProjectPage() {
  return (
    <Container>
      <Title>Create a new project</Title>
      <Outlet />
    </Container>
  );
}
