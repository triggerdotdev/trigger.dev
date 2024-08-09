import { ArrowUpCircleIcon, BookOpenIcon } from "@heroicons/react/20/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typeddefer, typedjson, UseDataFunctionReturn, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import {
  taskTriggerSourceDescription,
  TaskTriggerSourceIcon,
} from "~/components/runs/v3/TaskTriggerSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useTextFilter } from "~/hooks/useTextFilter";
import {
  ConcurrencyPresenter,
  Environment,
  Task,
} from "~/presenters/v3/ConcurrencyPresenter.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema, docsPath, v3BillingPath } from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { Feedback } from "~/components/Feedback";
import { Suspense } from "react";
import { Await } from "@remix-run/react";
import { Spinner } from "~/components/primitives/Spinner";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new ConcurrencyPresenter();
    const result = await presenter.call({
      userId,
      projectSlug: projectParam,
    });

    return typeddefer(result);
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const { environments, tasks, limit } = useTypedLoaderData<typeof loader>();

  const organization = useOrganization();
  const plan = useCurrentPlan();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Concurrency" />
        <PageAccessories>
          <AdminDebugTooltip />
          <LinkButton
            variant={"minimal/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/queue-concurrency")}
          >
            Concurrency docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className="flex flex-col gap-4">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <Header2>Environments</Header2>
              {plan ? (
                plan?.v3Subscription?.plan?.limits.concurrentRuns.canExceed ? (
                  <Feedback
                    button={
                      <Button LeadingIcon={ArrowUpCircleIcon} variant="tertiary/small">
                        Request more concurrency
                      </Button>
                    }
                    defaultValue="help"
                  />
                ) : (
                  <LinkButton
                    LeadingIcon={ArrowUpCircleIcon}
                    to={v3BillingPath(organization)}
                    variant="tertiary/small"
                  >
                    Upgrade for more concurrency
                  </LinkButton>
                )
              ) : null}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Environment</TableHeaderCell>
                  <TableHeaderCell alignment="right">Queued</TableHeaderCell>
                  <TableHeaderCell alignment="right">Running</TableHeaderCell>
                  <TableHeaderCell alignment="right">Concurrency limit</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                <Suspense fallback={<Spinner />}>
                  <Await resolve={environments} errorElement={<p>Error loading environments</p>}>
                    {(environments) => <EnvironmentsTable environments={environments} />}
                  </Await>
                </Suspense>
              </TableBody>
            </Table>
          </div>
          <div>
            <Header2 spacing>Tasks</Header2>
            <Suspense fallback={<Spinner />}>
              <Await resolve={tasks} errorElement={<p>Error loading tasks</p>}>
                {(tasks) => <TaskTable tasks={tasks} />}
              </Await>
            </Suspense>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function EnvironmentsTable({ environments }: { environments: Environment[] }) {
  return (
    <>
      {environments.map((environment) => (
        <TableRow key={environment.id}>
          <TableCell>
            <EnvironmentLabel environment={environment} userName={environment.userName} />
          </TableCell>
          <TableCell alignment="right">–</TableCell>
          <TableCell alignment="right">{environment.concurrency}</TableCell>
          <TableCell alignment="right">{environment.concurrencyLimit}</TableCell>
        </TableRow>
      ))}
    </>
  );
}

function TaskTable({ tasks }: { tasks: Task[] }) {
  const { filterText, setFilterText, filteredItems } = useTextFilter<Task>({
    items: tasks,
    filter: (task, text) => {
      if (task.identifier.toLowerCase().includes(text.toLowerCase())) {
        return true;
      }

      if (task.triggerSource === "SCHEDULED" && "scheduled".includes(text.toLowerCase())) {
        return true;
      }

      return false;
    },
  });

  return (
    <>
      <div className="h-8">
        <Input
          placeholder="Search tasks"
          variant="small"
          icon="search"
          fullWidth={true}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          autoFocus
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Task ID</TableHeaderCell>
            <TableHeaderCell alignment="right">Queued</TableHeaderCell>
            <TableHeaderCell alignment="right">Running</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredItems.length > 0 ? (
            filteredItems.map((task) => (
              <TableRow key={task.identifier}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <SimpleTooltip
                      button={<TaskTriggerSourceIcon source={task.triggerSource} />}
                      content={taskTriggerSourceDescription(task.triggerSource)}
                    />
                    <span>{task.identifier}</span>
                  </div>
                </TableCell>
                <TableCell alignment="right">{task.queued}</TableCell>
                <TableCell alignment="right">{task.concurrency}</TableCell>
              </TableRow>
            ))
          ) : (
            <TableBlankRow colSpan={3}>
              <Paragraph variant="small" className="flex items-center justify-center">
                {tasks.length > 0 ? "No tasks match your filters" : "No tasks"}
              </Paragraph>
            </TableBlankRow>
          )}
        </TableBody>
      </Table>
    </>
  );
}
