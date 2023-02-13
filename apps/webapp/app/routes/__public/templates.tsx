import { Container } from "~/components/layout/Container";
import { Header1 } from "~/components/primitives/text/Headers";

export default function TemplatesLayout() {
  return (
    <Container className="mx-auto flex w-full max-w-5xl flex-col">
      <Header1 className="mb-6">Placeholder logged out templates</Header1>
    </Container>
  );
}
