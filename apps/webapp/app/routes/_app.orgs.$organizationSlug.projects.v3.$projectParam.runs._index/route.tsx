import { BeakerIcon, BookOpenIcon } from "@heroicons/react/24/solid";
import { useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { TypedAwait, typeddefer, typedjson, useTypedLoaderData } from "remix-typedjson";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { BlankstateInstructions } from "~/components/BlankstateInstructions";
import { StepContentContainer } from "~/components/StepContentContainer";
import { MainCenteredContainer, PageBody } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import { RunsFilters, TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunListPresenter } from "~/presenters/v3/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3ProjectPath, v3TestPath } from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";
import { TextLink } from "~/components/primitives/TextLink";
import { Spinner } from "~/components/primitives/Spinner";
import { Suspense } from "react";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const url = new URL(request.url);
  const s = {
    cursor: url.searchParams.get("cursor") ?? undefined,
    direction: url.searchParams.get("direction") ?? undefined,
    statuses: url.searchParams.getAll("statuses"),
    environments: url.searchParams.getAll("environments"),
    tasks: url.searchParams.getAll("tasks"),
    period: url.searchParams.get("period") ?? undefined,
  };
  const { tasks, versions, statuses, environments, period, from, to, cursor, direction } =
    TaskRunListSearchFilters.parse(s);

  const presenter = new RunListPresenter();
  const list = presenter.call({
    userId,
    projectSlug: projectParam,
    tasks,
    versions,
    statuses,
    environments,
    period,
    from,
    to,
    direction: direction,
    cursor: cursor,
  });

  return typeddefer({
    data: list,
  });
};

export default function Page() {
  const { data } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const project = useProject();
  const user = useUser();

  return (
    <>
      <NavBar>
        <PageTitle title="Runs" />
      </NavBar>
      <PageBody>
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-2">
              <div className="mx-auto flex items-center gap-2">
                <Spinner />
                <Paragraph variant="small">Loading runs</Paragraph>
              </div>
            </div>
          }
        >
          <TypedAwait resolve={data}>
            {(list) => (
              <>
                {list.runs.length === 0 && !list.hasFilters ? (
                  list.possibleTasks.length === 0 ? (
                    <CreateFirstTaskInstructions />
                  ) : (
                    <RunTaskInstructions />
                  )
                ) : (
                  <div className={cn("grid h-fit grid-cols-1 gap-4")}>
                    <div>
                      <div className="mb-2 flex items-start justify-between gap-x-2">
                        <RunsFilters
                          possibleEnvironments={project.environments}
                          possibleTasks={list.possibleTasks}
                          hasFilters={list.hasFilters}
                        />
                        <div className="flex items-center justify-end gap-x-2">
                          <ListPagination list={list} />
                        </div>
                      </div>

                      <TaskRunsTable
                        total={list.runs.length}
                        hasFilters={list.hasFilters}
                        filters={list.filters}
                        runs={list.runs}
                        isLoading={isLoading}
                      />
                      <ListPagination list={list} className="mt-2 justify-end" />
                    </div>
                  </div>
                )}
              </>
            )}
          </TypedAwait>
        </Suspense>
      </PageBody>
    </>
  );
}

function CreateFirstTaskInstructions() {
  const organization = useOrganization();
  const project = useProject();
  return (
    <MainCenteredContainer className="max-w-prose">
      <BlankstateInstructions title="Create your first task">
        <Paragraph spacing>
          Before running a task, you must first create one. Follow the instructions on the{" "}
          <TextLink to={v3ProjectPath(organization, project)}>Tasks</TextLink> page to create a
          task, then return here to run it.
        </Paragraph>
        <LinkButton
          to={v3ProjectPath(organization, project)}
          variant="primary/medium"
          LeadingIcon={TaskIcon}
          className="inline-flex"
        >
          Create your first task
        </LinkButton>
      </BlankstateInstructions>
    </MainCenteredContainer>
  );
}

function RunTaskInstructions() {
  const organization = useOrganization();
  const project = useProject();
  return (
    <MainCenteredContainer className="max-w-prose">
      <Header1 className="mb-6 border-b py-2">How to run your tasks</Header1>
      <StepNumber stepNumber="A" title="Trigger a test run" />
      <StepContentContainer>
        <Paragraph spacing>
          You can perform a Run with any payload you want, or use one of our examples on the test
          page.
        </Paragraph>
        <LinkButton
          to={v3TestPath(organization, project)}
          variant="primary/medium"
          LeadingIcon={BeakerIcon}
          className="inline-flex"
        >
          Test
        </LinkButton>
        <div className="mt-6 flex items-center gap-2">
          <hr className="w-full" />
          <Paragraph variant="extra-extra-small/dimmed/caps">OR</Paragraph>
          <hr className="w-full" />
        </div>
      </StepContentContainer>

      <StepNumber stepNumber="B" title="Trigger your task for real" />
      <StepContentContainer>
        <Paragraph spacing>
          Performing a real run depends on the type of Trigger your Task is using.
        </Paragraph>
        <LinkButton
          to="https://trigger.dev/docs"
          variant="primary/medium"
          LeadingIcon={BookOpenIcon}
          className="inline-flex"
        >
          How to run a task
        </LinkButton>
      </StepContentContainer>
    </MainCenteredContainer>
  );
}
