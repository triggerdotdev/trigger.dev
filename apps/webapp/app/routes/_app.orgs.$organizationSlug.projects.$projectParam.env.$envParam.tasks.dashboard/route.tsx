import { type MetaFunction } from "@remix-run/react";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";

export const meta: MetaFunction = () => {
  return [{ title: "Tasks | Trigger.dev" }];
};

export default function TasksDashboardPage() {
  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Tasks" />
      </NavBar>
      <PageBody>
        <MainCenteredContainer>
          <div className="flex h-full items-center justify-center py-20">
            <Header2 className="text-text-dimmed">New Tasks dashboard here</Header2>
          </div>
        </MainCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
