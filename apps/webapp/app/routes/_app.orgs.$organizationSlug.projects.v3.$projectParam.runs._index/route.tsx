import { ArrowPathIcon, StopCircleIcon } from "@heroicons/react/20/solid";
import { BeakerIcon, BookOpenIcon } from "@heroicons/react/24/solid";
import { Form, useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { AnimatePresence, motion } from "framer-motion";
import { Suspense, useState } from "react";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { BlankstateInstructions } from "~/components/BlankstateInstructions";
import { StepContentContainer } from "~/components/StepContentContainer";
import { MainCenteredContainer, PageBody } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Header1 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  SelectedItemsProvider,
  useSelectedItems,
} from "~/components/primitives/SelectedItemsProvider";
import { Spinner } from "~/components/primitives/Spinner";
import { StepNumber } from "~/components/primitives/StepNumber";
import { TextLink } from "~/components/primitives/TextLink";
import { RunsFilters, TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunListPresenter } from "~/presenters/v3/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3ProjectPath, v3RunsPath, v3TestPath } from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";
import { BULK_ACTION_RUN_LIMIT } from "~/consts";
import { findProjectBySlug } from "~/models/project.server";
import { InfoPanel } from "~/components/primitives/InfoPanel";

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
    bulkId: url.searchParams.get("bulkId") ?? undefined,
  };
  const { tasks, versions, statuses, environments, period, bulkId, from, to, cursor, direction } =
    TaskRunListSearchFilters.parse(s);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    throw new Error("Project not found");
  }

  const presenter = new RunListPresenter();
  const list = presenter.call({
    userId,
    projectId: project.id,
    tasks,
    versions,
    statuses,
    environments,
    period,
    bulkId,
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
      <PageBody scrollable={false}>
        <SelectedItemsProvider
          initialSelectedItems={[]}
          maxSelectedItemCount={BULK_ACTION_RUN_LIMIT}
        >
          {({ selectedItems }) => (
            <div
              className={cn(
                "grid h-full max-h-full overflow-hidden",
                selectedItems.size === 0 ? "grid-rows-1" : "grid-rows-[1fr_2.5rem]"
              )}
            >
              <div className="overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
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
                                  bulkActions={list.bulkActions}
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
                                allowSelection
                              />
                              <ListPagination list={list} className="mt-2 justify-end" />
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </TypedAwait>
                </Suspense>
              </div>
              <BulkActionBar />
            </div>
          )}
        </SelectedItemsProvider>
      </PageBody>
    </>
  );
}

function BulkActionBar() {
  const { selectedItems, deselectAll } = useSelectedItems();
  const [barState, setBarState] = useState<"none" | "replay" | "cancel">("none");

  const hasSelectedMaximum = selectedItems.size >= BULK_ACTION_RUN_LIMIT;

  return (
    <AnimatePresence>
      {selectedItems.size > 0 && (
        <motion.div
          initial={{ translateY: "100%" }}
          animate={{ translateY: 0 }}
          exit={{ translateY: "100%" }}
          className="flex items-center justify-between gap-2 border-t border-grid-bright bg-background-bright px-3"
        >
          <div className="flex items-center gap-1.5 text-sm text-text-bright">
            <span className="font-medium">Bulk actions:</span>
            {hasSelectedMaximum ? (
              <span className="text-warning">Maximum of {selectedItems.size} runs selected</span>
            ) : (
              <span>{selectedItems.size} runs selected</span>
            )}
          </div>
          <div className="flex items-center gap-1 divide-x divide-charcoal-700">
            <CancelRuns
              onOpen={(o) => {
                if (o) {
                  setBarState("cancel");
                } else {
                  setBarState("none");
                }
              }}
            />
            <ReplayRuns
              onOpen={(o) => {
                if (o) {
                  setBarState("replay");
                } else {
                  setBarState("none");
                }
              }}
            />
            <Button
              variant="minimal/medium"
              shortcut={{ key: "esc", enabledOnInputElements: true }}
              onClick={() => {
                if (barState !== "none") return;
                deselectAll();
              }}
            >
              Clear selection
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CancelRuns({ onOpen }: { onOpen: (open: boolean) => void }) {
  const { selectedItems } = useSelectedItems();

  const organization = useOrganization();
  const project = useProject();
  const failedRedirect = v3RunsPath(organization, project);

  const formAction = `/resources/taskruns/bulk/cancel`;

  const navigation = useNavigation();
  const isLoading = navigation.formAction === formAction;

  return (
    <Dialog onOpenChange={(o) => onOpen(o)}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="minimal/medium"
          shortcut={{ key: "c", enabledOnInputElements: true }}
          LeadingIcon={StopCircleIcon}
        >
          Cancel runs
        </Button>
      </DialogTrigger>
      <DialogContent key="replay">
        <DialogHeader>Cancel {selectedItems.size} runs?</DialogHeader>
        <DialogDescription>
          Canceling these runs will stop them from running. Only runs that are not already finished
          will be canceled, the others will remain in their existing state.
        </DialogDescription>
        <DialogFooter>
          <Form action={formAction} method="post" reloadDocument>
            <input type="hidden" name="failedRedirect" value={failedRedirect} />
            <input type="hidden" name="organizationSlug" value={organization.slug} />
            <input type="hidden" name="projectSlug" value={project.slug} />
            {[...selectedItems].map((runId) => (
              <input key={runId} type="hidden" name="runIds" value={runId} />
            ))}
            <Button
              type="submit"
              variant="danger/small"
              LeadingIcon={isLoading ? "spinner-white" : StopCircleIcon}
              disabled={isLoading}
              shortcut={{ modifiers: ["meta"], key: "enter" }}
            >
              {isLoading ? "Canceling..." : `Cancel ${selectedItems.size} runs`}
            </Button>
          </Form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReplayRuns({ onOpen }: { onOpen: (open: boolean) => void }) {
  const { selectedItems } = useSelectedItems();

  const organization = useOrganization();
  const project = useProject();
  const failedRedirect = v3RunsPath(organization, project);

  const formAction = `/resources/taskruns/bulk/replay`;

  const navigation = useNavigation();
  const isLoading = navigation.formAction === formAction;

  return (
    <Dialog onOpenChange={(o) => onOpen(o)}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="minimal/medium"
          shortcut={{ key: "r", enabledOnInputElements: true }}
          LeadingIcon={ArrowPathIcon}
        >
          Replay {selectedItems.size} runs
        </Button>
      </DialogTrigger>
      <DialogContent key="replay">
        <DialogHeader>Replay runs?</DialogHeader>
        <DialogDescription>
          Replaying these runs will create a new run for each with the same payload and environment
          as the original. It will use the latest version of the code for each task.
        </DialogDescription>
        <DialogFooter>
          <Form action={formAction} method="post" reloadDocument>
            <input type="hidden" name="failedRedirect" value={failedRedirect} />
            <input type="hidden" name="organizationSlug" value={organization.slug} />
            <input type="hidden" name="projectSlug" value={project.slug} />
            {[...selectedItems].map((runId) => (
              <input key={runId} type="hidden" name="runIds" value={runId} />
            ))}
            <Button
              type="submit"
              variant="primary/small"
              LeadingIcon={isLoading ? "spinner-white" : ArrowPathIcon}
              disabled={isLoading}
              shortcut={{ modifiers: ["meta"], key: "enter" }}
            >
              {isLoading ? "Replaying..." : `Replay ${selectedItems.size} runs`}
            </Button>
          </Form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateFirstTaskInstructions() {
  const organization = useOrganization();
  const project = useProject();
  return (
    <MainCenteredContainer className="max-w-md">
      <InfoPanel
        icon={TaskIcon}
        iconClassName="text-blue-500"
        panelClassName="max-full"
        title="Create your first task"
        to={v3ProjectPath(organization, project)}
        buttonLabel="Create a task"
      >
        <Paragraph variant="small">
          Before running a task, you must first create one. Follow the instructions on the{" "}
          <TextLink to={v3ProjectPath(organization, project)}>Tasks</TextLink> page to create a
          task, then return here to run it.
        </Paragraph>
      </InfoPanel>
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
