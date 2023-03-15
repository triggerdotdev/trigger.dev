import { CloudIcon } from "@heroicons/react/24/outline";
import { AppBody, AppLayoutTwoCol } from "~/components/layout/AppLayout";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import { OrganizationsSideMenu } from "~/components/navigation/SideMenu";
import { Body } from "~/components/primitives/text/Body";
import { Header1 } from "~/components/primitives/text/Headers";

export default function ComingSoonPage() {
  return (
    <AppLayoutTwoCol>
      <OrganizationsSideMenu />
      <AppBody>
        <Header context="projects" />
        <Container className="h-full">
          <main className="-mt-20 flex h-full w-full items-center justify-center">
            <div className="flex max-w-xl flex-col items-center gap-y-3.5 rounded-md border border-slate-800 bg-slate-800 p-10 text-center shadow-md">
              <CloudIcon className="h-10 w-10 text-indigo-500" />
              <Header1 size="large">Repositories are coming soon</Header1>
              <Body className="text-slate-400">
                We're working hard to bring you Repositories. You'll be able to
                add workflows to a repo that will be deployed to the Trigger.dev
                Cloud.
              </Body>
            </div>
          </main>
        </Container>
      </AppBody>
    </AppLayoutTwoCol>
  );
}
