import { Outlet } from "@remix-run/react";
import { Container } from "~/components/layout/Container";

export default function TemplatesLayout() {
  return (
    <Container>
      <Outlet />
    </Container>
  );
}
