import { type ShouldRevalidateFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typeddefer, useTypedLoaderData } from "remix-typedjson";
import { taskAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DetailPageTitle } from "~/components/primitives/detail/DetailPage";
import { NavBar } from "~/components/primitives/PageHeader";
import { TaskDetailView } from "~/components/tasks/TaskDetailView";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { loadTaskDetailPage, taskQueueAction } from "~/presenters/v3/TaskDetailPage.server";
import { onlyDetailTabChanged } from "~/utils/detailTabRevalidation";
import type { Handle } from "~/utils/handle";
import { pageMeta } from "~/utils/pageTitle";
import { v3EnvironmentPath } from "~/utils/pathBuilder";

export const handle: Handle = {
  agentPageContext: (data) => taskAgentPageContext(data),
};

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.task?.slug ?? params.taskParam ?? "Task",
  "Tasks",
]);

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { page } = await loadTaskDetailPage({ request, params, triggerSource: "STANDARD" });
  return typeddefer(page);
};

/** The Queue tab's pause, resume and override buttons post here. */
export const action = taskQueueAction;

/** Every tab's data is already loaded: switching tabs doesn't run the loader again. */
export const shouldRevalidate: ShouldRevalidateFunction = (args) =>
  onlyDetailTabChanged(args) ? false : args.defaultShouldRevalidate;

export default function Page() {
  const data = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <PageContainer>
      <NavBar>
        <DetailPageTitle
          title={data.task.slug}
          backButton={{ to: v3EnvironmentPath(organization, project, environment), text: "Tasks" }}
        />
      </NavBar>
      <PageBody scrollable={false}>
        <TaskDetailView data={data} />
      </PageBody>
    </PageContainer>
  );
}
