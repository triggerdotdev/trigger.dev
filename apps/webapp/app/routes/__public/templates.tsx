import { Outlet } from "@remix-run/react";
import { Container } from "~/components/layout/Container";
import { Header2 } from "~/components/primitives/text/Headers";

export default function TemplatesLayout() {
  return (
    <Container className="mx-auto mt-12 lg:mt-18 flex w-full max-w-5xl flex-col items-center justify-center">
      <h1 className="mb-6 text-center font-title text-5xl font-semibold text-slate-200">
        Placeholder logged out templates
      </h1>
      <Header2 size="small" className="mb-4 text-slate-400">
        Placeholder template sub-heading
      </Header2>
        <Outlet />
    </Container>
  );
}
