import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { Link, Outlet } from "@remix-run/react";
import { Container } from "~/components/layout/Container";
import { Header2 } from "~/components/primitives/text/Headers";

export default function TemplatesLayout() {
  return (
    <Container className="mx-auto mt-4 flex w-full max-w-6xl flex-col lg:mt-6">
      <Outlet />
    </Container>
  );
}
