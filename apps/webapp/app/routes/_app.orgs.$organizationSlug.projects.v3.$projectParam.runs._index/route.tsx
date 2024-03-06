import { BeakerIcon, BookOpenIcon } from "@heroicons/react/24/solid";
import { useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
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
      <NavBar>
        <PageTitle title="Runs" />
      </NavBar>
      <PageBody>
        <CreateFirstTaskInstructions />
        {list.runs.length === 0 && !list.hasFilters ? (
          <RunTaskInstructions />
        ) : (
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
                hasFilters={list.hasFilters}
                runs={list.runs}
                isLoading={isLoading}
                currentUser={user}
              />
              <ListPagination list={list} className="mt-2 justify-end" />
            </div>
          </div>
        )}
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
          Before running a task, you must first create one. Follow the instructions on the ‘Tasks’
          page to create a task, then return here to run it.
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
