import { Container } from "~/components/layout/Container";
import { TertiaryLink } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/text/Headers";
import { TemplatesGrid } from "~/components/templates/TemplatesGrid";

export default function TemplatesLayout() {
  return (
    <Container className="mx-auto flex w-full max-w-5xl flex-col">
      <div className="flex w-full items-center justify-between">
        <Header1>Choose a template</Header1>
        <TertiaryLink to="/">Self-host instead</TertiaryLink>
      </div>
      <TemplatesGrid />
    </Container>
  );
}
