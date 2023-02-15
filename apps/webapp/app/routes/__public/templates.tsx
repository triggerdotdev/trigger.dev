import { Outlet } from "@remix-run/react";
import { Container } from "~/components/layout/Container";
import { Header2 } from "~/components/primitives/text/Headers";

export default function TemplatesLayout() {
  return (
    <Container className="lg:mt-18 mx-auto mt-12 flex w-full max-w-5xl flex-col items-center justify-center">
      <h1 className="mb-6 text-center font-title text-5xl font-semibold text-slate-200">
        Choose your Template
      </h1>
      <Header2 size="small" className="mb-8 text-slate-400">
        Quickly get started with your workflow by using a pre-built example.
      </Header2>
      <Outlet />
    </Container>
  );
}
