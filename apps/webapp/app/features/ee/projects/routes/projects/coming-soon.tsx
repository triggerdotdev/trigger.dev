import { AppBody } from "~/components/layout/AppLayout";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";

export default function ComingSoonPage() {
  return (
    <AppBody>
      <Header context="projects" />
      <Container>
        <div className="flex h-full flex-col items-center justify-center">
          <h1 className="text-2xl font-bold">Coming Soon</h1>
          <p className="text-gray-500">This feature is not yet available.</p>
        </div>
      </Container>
    </AppBody>
  );
}
