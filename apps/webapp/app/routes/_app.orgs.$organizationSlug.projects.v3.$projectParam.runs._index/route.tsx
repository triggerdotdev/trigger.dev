import { useNavigation } from "@remix-run/react";
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
import { PageBody } from "~/components/layout/AppLayout";
import { PageHeader, PageTitleRow, PageTitle } from "~/components/primitives/PageHeader";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const { tasks, versions, statuses, environments, from, to, cursor, direction } =
    TaskRunListSearchFilters.parse(s);

  const presenter = new RunListPresenter();
  const list = await presenter.call({
    userId,
    projectSlug: projectParam,
    tasks,
    versions,
    statuses,
    environments,
    from,
    to,
    direction: direction,
    cursor: cursor,
  });

  return typedjson({
    list,
  });
};

export default function Page() {
  const { list } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const project = useProject();
  const user = useUser();

  return (
    <>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title="Runs" />
        </PageTitleRow>
      </PageHeader>
      <PageBody>
        <div className={cn("grid h-fit grid-cols-1 gap-4")}>
          <div>
            <div className="mb-2 flex items-center justify-between gap-x-2">
              <RunsFilters
                possibleEnvironments={project.environments}
                possibleTasks={list.possibleTasks}
              />
              <div className="flex items-center justify-end gap-x-2">
                <ListPagination list={list} />
              </div>
            </div>

            <TaskRunsTable
              total={list.runs.length}
              hasFilters={false}
              runs={list.runs}
              isLoading={isLoading}
              currentUser={user}
            />
            <ListPagination list={list} className="mt-2 justify-end" />
          </div>
        </div>
      </PageBody>
    </>
  );
}
