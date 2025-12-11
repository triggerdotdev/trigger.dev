import { BeakerIcon, BookOpenIcon } from "@heroicons/react/24/solid";
import { type MetaFunction, useNavigation } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense } from "react";
import {
  TypedAwait,
  typeddefer,
  type UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { DevDisconnectedBanner, useDevPresence } from "~/components/DevPresence";
import { StepContentContainer } from "~/components/StepContentContainer";
import { MainCenteredContainer, PageBody } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { SelectedItemsProvider } from "~/components/primitives/SelectedItemsProvider";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { Spinner } from "~/components/primitives/Spinner";
import { StepNumber } from "~/components/primitives/StepNumber";
import { TextLink } from "~/components/primitives/TextLink";
import { RunsFilters, type TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { BULK_ACTION_RUN_LIMIT } from "~/consts";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getRunFiltersFromRequest } from "~/presenters/RunFilters.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import {
  setRootOnlyFilterPreference,
  uiPreferencesStorage,
} from "~/services/preferences/uiPreferences.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  docsPath,
  EnvironmentParamSchema,
  v3CreateBulkActionPath,
  v3ProjectPath,
  v3TestPath,
  v3TestTaskPath,
} from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";
import { CreateBulkActionInspector } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.bulkaction";
import { Callout } from "~/components/primitives/Callout";

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

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Error("Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Error("Environment not found");
  }

  const filters = await getRunFiltersFromRequest(request);

  const presenter = new NextRunListPresenter($replica, clickhouseClient);
  const list = presenter.call(project.organizationId, environment.id, {
    userId,
    projectId: project.id,
    ...filters,
  });

  const session = await setRootOnlyFilterPreference(filters.rootOnly, request);
  const cookieValue = await uiPreferencesStorage.commitSession(session);

  return typeddefer(
    {
      data: list,
      rootOnlyDefault: filters.rootOnly,
      filters,
    },
    {
      headers: {
        "Set-Cookie": cookieValue,
      },
    }
  );
};

export default function Page() {
  const { data, rootOnlyDefault, filters } = useTypedLoaderData<typeof loader>();
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
            <Suspense
              fallback={
                <div className="grid h-full max-h-full grid-rows-[2.5rem_auto] overflow-hidden">
                  <div className="border-b border-grid-bright" />
                  <div className="my-2 flex items-center justify-center">
                    <div className="mx-auto flex items-center gap-2">
                      <Spinner />
                      <Paragraph variant="small">Loading runs</Paragraph>
                    </div>
                  </div>
                </div>
              }
            >
              <TypedAwait
                resolve={data}
                errorElement={
                  <div className="flex items-center justify-center px-3 py-12">
                    <Callout variant="error" className="max-w-fit">
                      Unable to load your task runs. Please refresh the page or try again in a
                      moment.
                    </Callout>
                  </div>
                }
              >
                {(list) => {
                  return (
                    <RunsList
                      list={list}
                      selectedItems={selectedItems}
                      rootOnlyDefault={rootOnlyDefault}
                      filters={filters}
                    />
                  );
                }}
              </TypedAwait>
            </Suspense>
          )}
        </SelectedItemsProvider>
      </PageBody>
    </>
  );
}

function RunsList({
  list,
  selectedItems,
  rootOnlyDefault,
  filters,
}: {
  list: Awaited<UseDataFunctionReturn<typeof loader>["data"]>;
  selectedItems: Set<string>;
  rootOnlyDefault: boolean;
  filters: TaskRunListSearchFilters;
}) {
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { has, replace } = useSearchParams();

  // Shortcut keys for bulk actions
  useShortcutKeys({
    shortcut: { key: "r" },
    action: (e) => {
      replace({
        bulkInspector: "true",
        action: "replay",
        mode: selectedItems.size > 0 ? "selected" : undefined,
      });
    },
  });
  useShortcutKeys({
    shortcut: { key: "c" },
    action: (e) => {
      replace({
        bulkInspector: "true",
        action: "cancel",
        mode: selectedItems.size > 0 ? "selected" : undefined,
      });
    },
  });

  const isShowingBulkActionInspector = has("bulkInspector") && list.hasAnyRuns;
  return (
    <ResizablePanelGroup orientation="horizontal" className="max-h-full">
      <ResizablePanel id="runs-main" min={"100px"}>
        <div
          className={cn(
            "grid h-full max-h-full overflow-hidden",
            selectedItems.size === 0 ? "grid-rows-1" : "grid-rows-[1fr_auto]"
          )}
        >
          <>
            {list.runs.length === 0 && !list.hasAnyRuns ? (
              list.possibleTasks.length === 0 ? (
                <CreateFirstTaskInstructions />
              ) : (
                <RunTaskInstructions
                  task={
                    list.filters.tasks.length === 1
                      ? list.possibleTasks.find((t) => t.slug === list.filters.tasks[0])
                      : undefined
                  }
                />
              )
            ) : (
              <div className={cn("grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden")}>
                <div className="flex items-start justify-between gap-x-2 p-2">
                  <RunsFilters
                    possibleTasks={list.possibleTasks}
                    bulkActions={list.bulkActions}
                    hasFilters={list.hasFilters}
                    rootOnlyDefault={rootOnlyDefault}
                  />
                  <div className="flex items-center justify-end gap-x-2">
                    {!isShowingBulkActionInspector && (
                      <LinkButton
                        variant="secondary/small"
                        to={v3CreateBulkActionPath(
                          organization,
                          project,
                          environment,
                          filters,
                          selectedItems.size > 0 ? "selected" : undefined
                        )}
                        LeadingIcon={ListCheckedIcon}
                        className={selectedItems.size > 0 ? "pr-1" : undefined}
                        tooltip={
                          <div className="-mr-1 flex items-center gap-3 text-xs text-text-dimmed">
                            <div className="flex items-center gap-0.5">
                              <span>Replay</span>
                              <ShortcutKey shortcut={{ key: "r" }} variant={"small"} />
                            </div>
                            <div className="flex items-center gap-0.5">
                              <span>Cancel</span>
                              <ShortcutKey shortcut={{ key: "c" }} variant={"small"} />
                            </div>
                          </div>
                        }
                      >
                        <span className="flex items-center gap-x-1 whitespace-nowrap text-text-bright">
                          <span>Bulk action</span>
                          {selectedItems.size > 0 && (
                            <Badge variant="rounded">{selectedItems.size}</Badge>
                          )}
                        </span>
                      </LinkButton>
                    )}
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
        </div>
      </ResizablePanel>
      {isShowingBulkActionInspector && (
        <>
          <ResizableHandle id="runs-handle" />
          <ResizablePanel id="bulk-action-inspector" min="300px" default="400px" max="600px">
            <CreateBulkActionInspector
              filters={filters}
              selectedItems={selectedItems}
              hasBulkActions={list.bulkActions.length > 0}
            />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
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

function RunTaskInstructions({ task }: { task?: { slug: string } }) {
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
          to={
            task
              ? v3TestTaskPath(organization, project, environment, { taskIdentifier: task.slug })
              : v3TestPath(organization, project, environment)
          }
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
