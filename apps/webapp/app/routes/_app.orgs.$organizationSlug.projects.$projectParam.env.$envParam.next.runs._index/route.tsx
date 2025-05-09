import { ArrowPathIcon, StopCircleIcon } from "@heroicons/react/20/solid";
import { BeakerIcon, BookOpenIcon } from "@heroicons/react/24/solid";
import { Form, type MetaFunction, useNavigation } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { IconCircleX } from "@tabler/icons-react";
import { AnimatePresence, motion } from "framer-motion";
import { ListChecks, ListX } from "lucide-react";
import { Suspense, useState } from "react";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { DevDisconnectedBanner, useDevPresence } from "~/components/DevPresence";
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
import { Header1, Header2 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  SelectedItemsProvider,
  useSelectedItems,
} from "~/components/primitives/SelectedItemsProvider";
import { Spinner, SpinnerWhite } from "~/components/primitives/Spinner";
import { StepNumber } from "~/components/primitives/StepNumber";
import { TextLink } from "~/components/primitives/TextLink";
import { RunsFilters, TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { BULK_ACTION_RUN_LIMIT } from "~/consts";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { RunListPresenter } from "~/presenters/v3/RunListPresenter.server";
import {
  getRootOnlyFilterPreference,
  setRootOnlyFilterPreference,
  uiPreferencesStorage,
} from "~/services/preferences/uiPreferences.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  docsPath,
  EnvironmentParamSchema,
  v3ProjectPath,
  v3RunsNextPath,
  v3TestPath,
} from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Runs | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const url = new URL(request.url);

  let rootOnlyValue = false;
  if (url.searchParams.has("rootOnly")) {
    rootOnlyValue = url.searchParams.get("rootOnly") === "true";
  } else {
    rootOnlyValue = await getRootOnlyFilterPreference(request);
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Error("Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Error("Environment not found");
  }

  const s = {
    cursor: url.searchParams.get("cursor") ?? undefined,
    direction: url.searchParams.get("direction") ?? undefined,
    statuses: url.searchParams.getAll("statuses"),
    environments: [environment.id],
    tasks: url.searchParams.getAll("tasks"),
    period: url.searchParams.get("period") ?? undefined,
    bulkId: url.searchParams.get("bulkId") ?? undefined,
    tags: url.searchParams.getAll("tags").map((t) => decodeURIComponent(t)),
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    rootOnly: rootOnlyValue,
    runId: url.searchParams.get("runId") ?? undefined,
    batchId: url.searchParams.get("batchId") ?? undefined,
    scheduleId: url.searchParams.get("scheduleId") ?? undefined,
  };
  const {
    tasks,
    versions,
    statuses,
    environments,
    tags,
    period,
    bulkId,
    from,
    to,
    cursor,
    direction,
    rootOnly,
    runId,
    batchId,
    scheduleId,
  } = TaskRunListSearchFilters.parse(s);

  const presenter = new RunListPresenter();
  const list = presenter.call({
    userId,
    projectId: project.id,
    tasks,
    versions,
    statuses,
    environments,
    tags,
    period,
    bulkId,
    from,
    to,
    batchId,
    runIds: runId ? [runId] : undefined,
    scheduleId,
    rootOnly,
    direction: direction,
    cursor: cursor,
  });

  const session = await setRootOnlyFilterPreference(rootOnlyValue, request);
  const cookieValue = await uiPreferencesStorage.commitSession(session);

  return typeddefer(
    {
      data: list,
      rootOnlyDefault: rootOnlyValue,
    },
    {
      headers: {
        "Set-Cookie": cookieValue,
      },
    }
  );
};

export default function Page() {
  const { data, rootOnlyDefault } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const { isConnected } = useDevPresence();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <>
      <NavBar>
        <PageTitle title="Runs" />
        {environment.type === "DEVELOPMENT" && project.engine === "V2" && (
          <DevDisconnectedBanner isConnected={isConnected} />
        )}
        <PageAccessories>
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/runs-and-attempts")}
          >
            Runs docs
          </LinkButton>
        </PageAccessories>
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
                selectedItems.size === 0 ? "grid-rows-1" : "grid-rows-[1fr_auto]"
              )}
            >
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
                      {list.runs.length === 0 && !list.hasAnyRuns ? (
                        list.possibleTasks.length === 0 ? (
                          <CreateFirstTaskInstructions />
                        ) : (
                          <RunTaskInstructions />
                        )
                      ) : (
                        <div
                          className={cn(
                            "grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden"
                          )}
                        >
                          <div className="flex items-start justify-between gap-x-2 p-2">
                            <RunsFilters
                              possibleTasks={list.possibleTasks}
                              bulkActions={list.bulkActions}
                              hasFilters={list.hasFilters}
                              rootOnlyDefault={rootOnlyDefault}
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
                        </div>
                      )}
                    </>
                  )}
                </TypedAwait>
              </Suspense>
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
          className="flex items-center justify-between gap-3 border-t border-grid-bright bg-background-bright py-3 pl-4 pr-3"
        >
          <div className="flex items-center gap-1.5 text-sm text-text-bright">
            <ListChecks className="mr-1 size-7 text-indigo-400" />
            <Header2>Bulk actions:</Header2>
            {hasSelectedMaximum ? (
              <Paragraph className="text-warning">
                Maximum of {selectedItems.size} runs selected
              </Paragraph>
            ) : (
              <Paragraph className="">{selectedItems.size} runs selected</Paragraph>
            )}
          </div>
          <div className="flex items-center gap-3">
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
              variant="tertiary/medium"
              shortcut={{ key: "esc", enabledOnInputElements: true }}
              onClick={() => {
                if (barState !== "none") return;
                deselectAll();
              }}
              LeadingIcon={ListX}
              leadingIconClassName="text-indigo-400 w-6 h-6"
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
  const environment = useEnvironment();
  const failedRedirect = v3RunsNextPath(organization, project, environment);

  const formAction = `/resources/taskruns/bulk/cancel`;

  const navigation = useNavigation();
  const isLoading = navigation.formAction === formAction;

  return (
    <Dialog onOpenChange={(o) => onOpen(o)}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="tertiary/medium"
          shortcut={{ key: "c", enabledOnInputElements: true }}
          LeadingIcon={IconCircleX}
          leadingIconClassName="text-error w-[1.3rem] h-[1.3rem]"
        >
          Cancel runs
        </Button>
      </DialogTrigger>
      <DialogContent key="replay">
        <DialogHeader>Cancel {selectedItems.size} runs?</DialogHeader>
        <DialogDescription className="pt-2">
          Canceling these runs will stop them from running. Only runs that are not already finished
          will be canceled, the others will remain in their existing state.
        </DialogDescription>
        <DialogFooter>
          <Form action={formAction} method="post" reloadDocument>
            <input type="hidden" name="failedRedirect" value={failedRedirect} />
            <input type="hidden" name="organizationSlug" value={organization.slug} />
            <input type="hidden" name="projectSlug" value={project.slug} />
            <input type="hidden" name="environmentSlug" value={environment.slug} />
            {[...selectedItems].map((runId) => (
              <input key={runId} type="hidden" name="runIds" value={runId} />
            ))}
            <Button
              type="submit"
              variant="danger/medium"
              LeadingIcon={isLoading ? SpinnerWhite : StopCircleIcon}
              disabled={isLoading}
              shortcut={{ modifiers: ["mod"], key: "enter" }}
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
  const environment = useEnvironment();
  const failedRedirect = v3RunsNextPath(organization, project, environment);

  const formAction = `/resources/taskruns/bulk/replay`;

  const navigation = useNavigation();
  const isLoading = navigation.formAction === formAction;

  return (
    <Dialog onOpenChange={(o) => onOpen(o)}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="tertiary/medium"
          shortcut={{ key: "r", enabledOnInputElements: true }}
          LeadingIcon={ArrowPathIcon}
          leadingIconClassName="text-blue-400 w-[1.3rem] h-[1.3rem]"
        >
          <span className="text-text-bright">Replay {selectedItems.size} runs</span>
        </Button>
      </DialogTrigger>
      <DialogContent key="replay">
        <DialogHeader>Replay runs?</DialogHeader>
        <DialogDescription className="pt-2">
          Replaying these runs will create a new run for each with the same payload and environment
          as the original. It will use the latest version of the code for each task.
        </DialogDescription>
        <DialogFooter>
          <Form action={formAction} method="post" reloadDocument>
            <input type="hidden" name="failedRedirect" value={failedRedirect} />
            <input type="hidden" name="organizationSlug" value={organization.slug} />
            <input type="hidden" name="projectSlug" value={project.slug} />
            <input type="hidden" name="environmentSlug" value={environment.slug} />
            {[...selectedItems].map((runId) => (
              <input key={runId} type="hidden" name="runIds" value={runId} />
            ))}
            <Button
              type="submit"
              variant="primary/medium"
              LeadingIcon={isLoading ? SpinnerWhite : ArrowPathIcon}
              disabled={isLoading}
              shortcut={{ modifiers: ["mod"], key: "enter" }}
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
        accessory={
          <LinkButton to={v3ProjectPath(organization, project)} variant="primary/small">
            Create a task
          </LinkButton>
        }
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
  const environment = useEnvironment();
  return (
    <MainCenteredContainer className="max-w-prose">
      <Header1 className="mb-6 border-b py-2">How to run your tasks</Header1>
      <StepNumber stepNumber="A" title="Trigger a test run" />
      <StepContentContainer>
        <Paragraph spacing>
          Perform a test run with a payload directly from the dashboard.
        </Paragraph>
        <LinkButton
          to={v3TestPath(organization, project, environment)}
          variant="secondary/medium"
          LeadingIcon={BeakerIcon}
          leadingIconClassName="text-lime-500"
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
          Performing a real run depends on the type of trigger your task is using.
        </Paragraph>
        <LinkButton
          to={docsPath("/triggering")}
          variant="docs/medium"
          LeadingIcon={BookOpenIcon}
          className="inline-flex"
        >
          How to trigger a task
        </LinkButton>
      </StepContentContainer>
    </MainCenteredContainer>
  );
}
