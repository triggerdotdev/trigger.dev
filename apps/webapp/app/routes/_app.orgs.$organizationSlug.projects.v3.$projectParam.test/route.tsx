import { Outlet, useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { RunsFilters, TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunListPresenter } from "~/presenters/v3/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema } from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { PageHeader, PageTitleRow, PageTitle } from "~/components/primitives/PageHeader";
import { TestPresenter } from "~/presenters/v3/TestPresenter.server";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Header2 } from "~/components/primitives/Headers";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const presenter = new TestPresenter();
  const { tasks } = await presenter.call({
    userId,
    projectSlug: projectParam,
  });

  return typedjson({
    tasks,
  });
};

export default function Page() {
  const { tasks } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const project = useProject();
  const user = useUser();

  return (
    <PageContainer>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title="Test" />
        </PageTitleRow>
      </PageHeader>
      <PageBody>
        <div className={cn("grid h-full max-h-full grid-cols-1")}>
          <ResizablePanelGroup direction="horizontal" className="h-full max-h-full">
            <ResizablePanel order={1} minSize={20} defaultSize={30}>
              <div className="flex flex-col">
                <Header2>Select a task</Header2>
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel order={2} minSize={30} defaultSize={70}>
              <Outlet />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </PageBody>
    </PageContainer>
  );
}
