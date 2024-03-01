import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { TaskRunAttemptStatus } from "@trigger.dev/database";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DateTime } from "~/components/primitives/DateTime";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TaskPath } from "~/components/runs/v3/TaskPath";
import { TaskRunStatus } from "~/components/runs/v3/TaskRunStatus";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { TaskListPresenter } from "~/presenters/v3/TaskListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3RunsPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new TaskListPresenter();
    const tasks = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
    });

    return typedjson({
      tasks,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const user = useUser();
  const { tasks } = useTypedLoaderData<typeof loader>();
  const hasTasks = tasks.length > 0;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Tasks" />
      </NavBar>
      <PageBody>
        <div className={cn("grid h-full grid-cols-1 gap-4")}>
          <div className="h-full">
            {hasTasks ? (
              <div className="flex flex-col gap-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Task ID</TableHeaderCell>
                      <TableHeaderCell>Task</TableHeaderCell>
                      <TableHeaderCell>Environment</TableHeaderCell>
                      <TableHeaderCell>Last run</TableHeaderCell>
                      <TableHeaderCell>Created at</TableHeaderCell>
                      <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.length > 0 ? (
                      tasks.map((task) => {
                        const usernameForEnv =
                          user.id !== task.environment.userId
                            ? task.environment.userName
                            : undefined;
                        const path = v3RunsPath(organization, project, {
                          tasks: [task.slug],
                          environments: [task.environment.id],
                        });
                        return (
                          <TableRow key={task.id} className="group">
                            <TableCell to={path}>{task.slug}</TableCell>
                            <TableCell to={path}>
                              <TaskPath
                                filePath={task.filePath}
                                functionName={`${task.exportName}()`}
                              />
                            </TableCell>
                            <TableCell to={path}>
                              <EnvironmentLabel
                                environment={task.environment}
                                userName={usernameForEnv}
                              />
                            </TableCell>
                            <TableCell to={path}>
                              {task.latestRun ? (
                                <div
                                  className={cn(
                                    "flex items-center gap-2",
                                    classForTaskAttemptStatus(task.latestRun.status)
                                  )}
                                >
                                  <DateTime date={task.latestRun.updatedAt} />
                                  <TaskRunStatus status={task.latestRun.status} />
                                </div>
                              ) : (
                                "Never run"
                              )}
                            </TableCell>
                            <TableCell to={path}>
                              <DateTime date={task.createdAt} />
                            </TableCell>
                            <TableCellChevron to={path} />
                          </TableRow>
                        );
                      })
                    ) : (
                      <TableBlankRow colSpan={6}>
                        <Paragraph variant="small" className="flex items-center justify-center">
                          No tasks match your filters
                        </Paragraph>
                      </TableBlankRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <Paragraph>You have no background workers… yet</Paragraph>
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function classForTaskAttemptStatus(status: TaskRunAttemptStatus) {
  switch (status) {
    case "FAILED":
      return "text-red-500";
    default:
      return "";
  }
}
