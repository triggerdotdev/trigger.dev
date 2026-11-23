import { DEV_VERSION_HINT } from "~/utils/versionLabel";
import { parseWithZod } from "~/utils/conform";
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/react/20/solid";
import { XCircleIcon } from "@heroicons/react/24/outline";
import { Form, useNavigation } from "@remix-run/react";
import { tryCatch } from "@trigger.dev/core";
import { useEffect, useRef, useState } from "react";
import { typedjson, useTypedFetcher } from "remix-typedjson";
import simplur from "simplur";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import selectRunsIndividually from "~/assets/images/select-runs-individually.png";
import selectRunsUsingFilters from "~/assets/images/select-runs-using-filters.png";
import {
  BulkActionAction,
  BulkActionFilterChips,
  BulkActionFilterSummary,
  BulkActionMode,
  hasOnlyDefaultFilters,
  EstimatedCount,
} from "~/components/BulkActionFilterSummary";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/primitives/Accordion";
import { Button } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";
import { BulkActionModeField } from "~/components/runs/v3/BulkActionModeField";
import { Select, SelectItem } from "~/components/primitives/Select";
import { type TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import {
  ignoredRunFilterMessage,
  useIgnoredRunFilters,
} from "~/components/runs/v3/IgnoredRunFilters";
import { EnvironmentCombo, environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useUser } from "~/hooks/useUser";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { findProjectBySlug } from "~/models/project.server";
import { displayableEnvironment, findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { $replica, boundedIn } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import type { Prisma, PrismaClient, RuntimeEnvironmentType } from "@trigger.dev/database";
import { sortEnvironments } from "~/utils/environmentSort";
import {
  getIgnoredRunFiltersFromRequest,
  getRunFiltersFromRequest,
} from "~/presenters/RunFilters.server";
import { CreateBulkActionPresenter } from "~/presenters/v3/CreateBulkActionPresenter.server";
import { RegionsPresenter } from "~/presenters/v3/RegionsPresenter.server";
import { RUNS_BULK_INSPECTOR_UI_SEARCH_PARAMS } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index/shouldRevalidateRunsList";
import { logger } from "~/services/logger.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { checkPermissions } from "~/services/routeBuilders/permissions.server";
import { sanitizeRedirectPath } from "~/utils";
import { cn } from "~/utils/cn";
import { EnvironmentParamSchema, v3BulkActionPath } from "~/utils/pathBuilder";
import { BulkActionService } from "~/v3/services/bulk/BulkActionV2.server";
import { findCurrentVersion } from "~/v3/models/workerDeployment.server";
import { replayVersionChoices } from "~/components/runs/v3/replayVersions";

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "runs" } },
  },
  async ({ request, params, user, ability }) => {
    const { organizationSlug, projectParam, envParam } = params;

    const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
    if (!project) {
      throw new Response("Not Found", { status: 404 });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
    if (!environment) {
      throw new Response("Not Found", { status: 404 });
    }

    // Raw impersonation, not `hasAdminDisplayAccess`: this list is the bulk
    // action's "override region" picker, so it decides which region a submitted
    // bulk replay can re-route runs to. "View as user" only changes what is
    // shown.
    const isAdmin = user.admin || user.isImpersonating;

    const replayEnvironmentId =
      new URL(request.url).searchParams.get("replayEnvironment") ?? environment.id;

    const presenter = new CreateBulkActionPresenter();
    const [data, regionsResult, replayTargets] = await Promise.all([
      presenter.call({
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
        request,
      }),
      tryCatch(
        new RegionsPresenter().call({
          userId: user.id,
          projectSlug: projectParam,
          isAdmin,
        })
      ),
      loadReplayTargets(project.id, user.id, replayEnvironmentId),
    ]);

    const replayMissing = await countReplayRunsMissingFromTarget({
      request,
      organizationId: project.organizationId,
      projectId: project.id,
      sourceEnvironmentId: environment.id,
      target: replayTargets.selected,
      filters: data.filters,
      mode: data.mode,
    });

    const [regionsError, regionsData] = regionsResult;
    const regions = regionsError ? [] : regionsData.regions;

    // Display flag for the inspector's Cancel/Replay controls — the action
    // below enforces write:runs independently.
    const { canCreateBulkAction } = checkPermissions(ability, {
      canCreateBulkAction: { action: "write", resource: { type: "runs" } },
    });

    return typedjson({
      ...data,
      ignoredFilters: getIgnoredRunFiltersFromRequest(request),
      regions,
      replayEnvironments: replayTargets.environments,
      replayVersions: replayTargets.versions,
      replayCurrentVersion: replayTargets.currentVersion,
      replayVersionsEnvironmentId: replayTargets.versionsEnvironmentId,
      replayMissing,
      canCreateBulkAction,
    });
  }
);

// The environments a user may replay into, same rules as single replay: not archived, not a
// preview parent, and only their own dev environment.
function replayTargetEnvironmentsWhere(projectId: string, userId: string) {
  return {
    projectId,
    archivedAt: null,
    OR: [
      { type: { in: ["STAGING", "PRODUCTION"] as RuntimeEnvironmentType[] } },
      { type: "PREVIEW" as const, parentEnvironmentId: { not: null } },
      { type: "DEVELOPMENT" as const, orgMember: { userId } },
    ],
  } satisfies Prisma.RuntimeEnvironmentWhereInput;
}

async function loadReplayTargets(projectId: string, userId: string, environmentId: string) {
  const environments = await $replica.runtimeEnvironment.findMany({
    where: replayTargetEnvironmentsWhere(projectId, userId),
    select: {
      id: true,
      type: true,
      slug: true,
      branchName: true,
      orgMember: { select: { user: true } },
    },
  });

  const selected = environments.find((env) => env.id === environmentId);
  // Dev only offers its current (newest) version, so it needs no list.
  const [versions, currentVersion] = selected
    ? await Promise.all([
        selected.type === "DEVELOPMENT"
          ? []
          : $replica.backgroundWorker.findMany({
              where: { runtimeEnvironmentId: selected.id },
              select: { version: true },
              orderBy: { createdAt: "desc" },
              take: 20,
            }),
        findCurrentVersion(selected, $replica),
      ])
    : [[], undefined];

  return {
    environments: sortEnvironments(
      environments.map((env) => ({
        ...displayableEnvironment(env, userId),
        branchName: env.branchName ?? undefined,
      }))
    ),
    selected,
    versionsEnvironmentId: selected?.id,
    versions: versions.map((v) => v.version),
    currentVersion,
  };
}

// Selected runs whose task the panel checks against another environment's current version.
const REPLAY_CHECK_MAX_SELECTED = 250;

// Replaying into another environment: how many of the runs have a task its current version lacks
// (they'd park in Pending version). Undefined when it doesn't apply or can't be counted.
async function countReplayRunsMissingFromTarget({
  request,
  organizationId,
  projectId,
  sourceEnvironmentId,
  target,
  filters,
  mode,
}: {
  request: Request;
  organizationId: string;
  projectId: string;
  sourceEnvironmentId: string;
  target: { id: string; type: RuntimeEnvironmentType } | undefined;
  filters: Awaited<ReturnType<CreateBulkActionPresenter["call"]>>["filters"];
  mode: BulkActionMode;
}): Promise<number | undefined> {
  if (!target || target.id === sourceEnvironmentId || target.type === "DEVELOPMENT") {
    return undefined;
  }

  const promotion = await $replica.workerDeploymentPromotion.findFirst({
    where: { environmentId: target.id, label: CURRENT_DEPLOYMENT_LABEL },
    select: {
      deployment: { select: { worker: { select: { tasks: { select: { slug: true } } } } } },
    },
  });
  const targetTasks = new Set(promotion?.deployment.worker?.tasks.map((t) => t.slug) ?? []);

  if (mode === "selected") {
    const ids = new URL(request.url).searchParams.getAll("replayRunIds");
    if (ids.length === 0 || ids.length > REPLAY_CHECK_MAX_SELECTED) return undefined;
    const runs = await runStore.findRuns({
      where: { friendlyId: { in: boundedIn(ids) }, runtimeEnvironmentId: sourceEnvironmentId },
      select: { taskIdentifier: true },
    });
    return runs.filter((run) => !targetTasks.has(run.taskIdentifier)).length;
  }

  // Filter mode: the filtered tasks, or every task this environment has had, minus the target's.
  const sourceTasks =
    filters.tasks && filters.tasks.length > 0
      ? filters.tasks
      : (
          await $replica.backgroundWorkerTask.groupBy({
            by: ["slug"],
            where: { runtimeEnvironmentId: sourceEnvironmentId },
          })
        ).map((t) => t.slug);
  const missingTasks = sourceTasks.filter((slug) => !targetTasks.has(slug));
  if (missingTasks.length === 0) return 0;

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    organizationId,
    "runsList"
  );
  const runsRepository = new RunsRepository({ clickhouse, prisma: $replica as PrismaClient });
  return runsRepository.countRuns({
    organizationId,
    projectId,
    environmentId: sourceEnvironmentId,
    ...filters,
    tasks: missingTasks,
  });
}

export const CreateBulkActionSearchParams = z.object({
  mode: BulkActionMode.default("filter"),
  action: BulkActionAction.default("cancel"),
});

// Sentinel for the "Override region" dropdown meaning "keep each run's original
// region". Normalized to `undefined` in the action so the service never sees it.
const REPLAY_REGION_NO_OVERRIDE_VALUE = "__no_override__";

// Bulk replay version choices; any other value is a specific version.
const REPLAY_VERSION_CURRENT = "latest";
const REPLAY_VERSION_ORIGINAL = "original";

export const CreateBulkActionPayload = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("selected"),
    action: BulkActionAction,
    // At least one: an empty selection would otherwise become a filter that matches every run.
    selectedRunIds: z.preprocess(
      (value) => {
        if (Array.isArray(value)) return value;
        if (typeof value === "string") return [value];
        return [];
      },
      z.array(z.string()).min(1, "Select at least one run")
    ),
    title: z.string().optional(),
    region: z.string().optional(),
    version: z.string().optional(),
    replayEnvironment: z.string().optional(),
    failedRedirect: z.string(),
    emailNotification: z.preprocess((value) => value === "on", z.boolean()),
  }),
  z.object({
    mode: z.literal("filter"),
    action: BulkActionAction,
    title: z.string().optional(),
    region: z.string().optional(),
    version: z.string().optional(),
    replayEnvironment: z.string().optional(),
    failedRedirect: z.string(),
    emailNotification: z.preprocess((value) => value === "on", z.boolean()),
  }),
]);
export type CreateBulkActionPayload = z.infer<typeof CreateBulkActionPayload>;

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "write", resource: { type: "runs" } },
  },
  async ({ request, params, user }) => {
    const { organizationSlug, projectParam, envParam } = params;

    const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
    if (!project) {
      throw new Response("Not Found", { status: 404 });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
    if (!environment) {
      throw new Response("Not Found", { status: 404 });
    }

    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: CreateBulkActionPayload });

    if (submission.status !== "success") {
      logger.error("Invalid bulk action", {
        submission,
        formData: Object.fromEntries(formData),
      });
      return redirectWithErrorMessage("/", request, "Invalid bulk action");
    }

    const failedRedirect = sanitizeRedirectPath(submission.value.failedRedirect);

    // "Don't override" keeps each run's original region — drop it so it isn't
    // stored as a real override.
    if (submission.value.region === REPLAY_REGION_NO_OVERRIDE_VALUE) {
      submission.value.region = undefined;
    }

    // Never widen a bulk action: with a filter we couldn't read, "matching your filters" would
    // cover more runs than the user sees.
    if (submission.value.mode === "filter") {
      const ignored = getIgnoredRunFiltersFromRequest(request);
      if (ignored.length > 0) {
        return redirectWithErrorMessage(
          failedRedirect,
          request,
          `Fix or remove the ignored filter first: ${ignored.map(ignoredRunFilterMessage).join("; ")}`
        );
      }
    }

    const replayEnvironmentId =
      submission.value.action === "replay" && submission.value.replayEnvironment
        ? submission.value.replayEnvironment
        : undefined;
    if (replayEnvironmentId && replayEnvironmentId !== environment.id) {
      const allowed = await $replica.runtimeEnvironment.findFirst({
        where: { id: replayEnvironmentId, ...replayTargetEnvironmentsWhere(project.id, user.id) },
        select: { id: true },
      });
      if (!allowed) {
        return redirectWithErrorMessage(failedRedirect, request, "Environment not found");
      }
    }

    const service = new BulkActionService();
    const [error, result] = await tryCatch(
      (async () => {
        const filters =
          submission.value.mode === "selected"
            ? { runId: submission.value.selectedRunIds }
            : await getRunFiltersFromRequest(request);

        return service.create({
          organizationId: project.organizationId,
          projectId: project.id,
          environmentId: environment.id,
          userId: user.id,
          action: submission.value.action,
          title: submission.value.title,
          region: submission.value.region,
          version: submission.value.version,
          replayEnvironmentId,
          emailNotification: submission.value.emailNotification,
          filters,
          triggerSource: "dashboard",
        });
      })()
    );

    if (error) {
      logger.error("Failed to create bulk action", {
        error,
      });

      return redirectWithErrorMessage(
        failedRedirect,
        request,
        `Failed to create bulk action: ${error.message}`
      );
    }

    return redirectWithSuccessMessage(
      v3BulkActionPath(
        { slug: organizationSlug },
        { slug: projectParam },
        { slug: envParam },
        { friendlyId: result.bulkActionId }
      ),
      request,
      "Bulk action started"
    );
  }
);

export function CreateBulkActionInspector({
  filters,
  selectedItems,
  hasBulkActions,
}: {
  filters: TaskRunListSearchFilters;
  selectedItems: Set<string>;
  hasBulkActions: boolean;
}) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useTypedFetcher<typeof loader>();
  const { load } = fetcher;
  const { value, replace, del } = useSearchParams();
  const action = bulkActionActionFromString(value("action"));
  const location = useOptimisticLocation();
  const user = useUser();

  const ignoredFilters = useIgnoredRunFilters();
  const [replayEnvironmentId, setReplayEnvironmentId] = useState(environment.id);
  // The chosen version belongs to the environment it was chosen in: any environment change,
  // including picking the one already selected, means the current version.
  const [replayVersionChoice, setReplayVersionChoice] = useState<{
    environmentId: string;
    version: string;
  }>({ environmentId: environment.id, version: REPLAY_VERSION_CURRENT });

  useEffect(() => {
    const search = new URLSearchParams(location.search);
    if (replayEnvironmentId !== environment.id) {
      search.set("replayEnvironment", replayEnvironmentId);
      if (selectedItems.size > 0 && selectedItems.size <= 250) {
        for (const id of selectedItems) search.append("replayRunIds", id);
      }
    }
    load(
      `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/bulkaction?${search.toString()}`
    );
  }, [
    organization.slug,
    project.slug,
    environment.slug,
    environment.id,
    location.search,
    replayEnvironmentId,
    selectedItems,
    load,
  ]);

  // One click, one bulk action: block a second submit until this one's navigation settles.
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state !== "idle" &&
    navigation.formMethod?.toLowerCase() === "post" &&
    (navigation.formAction?.includes("/runs/bulkaction") ?? false);
  const submittedRef = useRef(false);
  useEffect(() => {
    if (navigation.state === "idle") submittedRef.current = false;
  }, [navigation.state]);

  const mode = bulkActionModeFromString(value("mode"));

  const data = fetcher.data != null ? fetcher.data : undefined;

  // Permissive while the fetcher is loading; the action enforces write:runs.
  const canCreateBulkAction = data?.canCreateBulkAction ?? true;

  const impactedCountElement =
    mode === "selected" ? selectedItems.size : <EstimatedCount count={data?.count} />;

  const blockedByIgnoredFilter = mode === "filter" && ignoredFilters.length > 0;
  const confirmDisabledReason = !canCreateBulkAction
    ? "You don't have permission to create bulk actions"
    : blockedByIgnoredFilter
      ? "A filter in the URL was ignored. Fix or remove it before acting on matching runs."
      : undefined;

  const replayEnvironments = data?.replayEnvironments ?? [];
  // Only trust the version list once it has loaded for the chosen environment.
  const versionsLoaded = data?.replayVersionsEnvironmentId === replayEnvironmentId;
  const versionChoices = replayVersionChoices(
    versionsLoaded ? (data?.replayVersions ?? []) : [],
    versionsLoaded ? data?.replayCurrentVersion : undefined
  );
  const replayTargetIsDev =
    replayEnvironments.find((env) => env.id === replayEnvironmentId)?.type === "DEVELOPMENT";
  // Version strings are per environment, so a run's original version only means something in
  // its own environment.
  const replayIntoOtherEnv = replayEnvironmentId !== environment.id;
  const versionItems = [
    { value: REPLAY_VERSION_CURRENT, label: versionChoices.currentLabel },
    ...(replayIntoOtherEnv
      ? []
      : [{ value: REPLAY_VERSION_ORIGINAL, label: "Same as original run" }]),
    ...versionChoices.others,
  ];
  const effectiveReplayVersion =
    !replayTargetIsDev &&
    replayVersionChoice.environmentId === replayEnvironmentId &&
    versionItems.some((v) => v.value === replayVersionChoice.version)
      ? replayVersionChoice.version
      : REPLAY_VERSION_CURRENT;
  const replayEnvironmentLabel = replayEnvironments.find((e) => e.id === replayEnvironmentId);
  const replayMissingCount =
    action === "replay" &&
    replayIntoOtherEnv &&
    versionsLoaded &&
    effectiveReplayVersion === REPLAY_VERSION_CURRENT
      ? data?.replayMissing
      : undefined;
  const replayMissingWarning =
    replayMissingCount && replayEnvironmentLabel
      ? `${replayMissingCount.toLocaleString()} ${
          replayMissingCount === 1 ? "run's task isn't" : "runs' tasks aren't"
        } in ${environmentFullTitle(replayEnvironmentLabel)}'s current version. They'll wait until a deploy includes them.`
      : undefined;

  // Region is a replay-only override and only applies to deployed environments.
  // The default keeps each run in its original region so a bulk action spanning
  // multiple regions doesn't silently re-route runs.
  const regions = data?.regions ?? [];
  const showRegion =
    action === "replay" && environment.type !== "DEVELOPMENT" && regions.length > 1;
  const regionItems = [
    { value: REPLAY_REGION_NO_OVERRIDE_VALUE, label: "Don't override", isDefault: false },
    ...regions.map((r) => ({
      // masterQueue is the region routing key the replay resolves against
      // (WorkerGroupService matches regionOverride on masterQueue); name is display only.
      value: r.masterQueue,
      label: r.description ? `${r.name} — ${r.description}` : r.name,
      isDefault: r.isDefault,
    })),
  ];

  return (
    <Form
      method="post"
      action={`/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/bulkaction${location.search}`}
      className="h-full"
      id="bulk-action-form"
      onSubmit={(e) => {
        if (submittedRef.current || blockedByIgnoredFilter) {
          e.preventDefault();
          return;
        }
        submittedRef.current = true;
      }}
    >
      <input type="hidden" name="failedRedirect" value={`${location.pathname}${location.search}`} />
      <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden bg-background-bright">
        <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
          <Header2 className="whitespace-nowrap">Create a bulk action</Header2>
          <Button
            type="button"
            variant="minimal/small"
            onClick={() => del([...RUNS_BULK_INSPECTOR_UI_SEARCH_PARAMS])}
            TrailingIcon={ExitIcon}
            shortcut={{ key: "esc" }}
            shortcutPosition="before-trailing-icon"
            className="pl-1"
          />
        </div>
        <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
          <div className="px-3 pt-3">
            <Accordion
              type="single"
              collapsible
              defaultValue={!hasBulkActions ? "instructions" : undefined}
            >
              <AccordionItem value="instructions">
                <AccordionTrigger
                  leadingIcon={InformationCircleIcon}
                  leadingIconClassName="text-blue-500"
                >
                  How to create a bulk action
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-2">
                    <Paragraph variant="small">
                      Select runs individually using the checkboxes.
                    </Paragraph>
                    <div>
                      <img src={selectRunsIndividually} alt="Select runs individually" />
                    </div>
                    <Paragraph variant="small">
                      Or select runs using the filter menus on this page.
                    </Paragraph>
                    <div>
                      <img src={selectRunsUsingFilters} alt="Select runs using filters" />
                    </div>
                    <Paragraph variant="small">
                      Then complete the form below and click “Cancel runs” or “Replay runs”.
                    </Paragraph>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
          <Fieldset className="p-3">
            {Array.from(selectedItems).map((runId) => {
              return <input key={runId} type="hidden" name="selectedRunIds" value={runId} />;
            })}
            <InputGroup>
              <Label htmlFor="mode">Select</Label>
              <BulkActionModeField
                mode={mode}
                onModeChange={(value) => {
                  replace({ mode: value });
                }}
                filterLabel={
                  <span>
                    {data?.count === 0 ? "" : "All"} <EstimatedCount count={data?.count} /> runs
                    matching your filters
                  </span>
                }
                selectedLabel={simplur`${selectedItems.size} individually selected run[|s]`}
              />
            </InputGroup>
            <InputGroup>
              <Label htmlFor="title">Name</Label>
              <Input name="title" placeholder="A name for this bulk action" autoComplete="off" />
              <Hint>Add a name to identify this bulk action (optional).</Hint>
            </InputGroup>
            <InputGroup>
              <Label htmlFor="action">Bulk action to perform</Label>
              <RadioGroup
                name="action"
                className="flex flex-col items-start gap-2"
                value={action}
                onValueChange={(value) => {
                  replace({ action: value });
                }}
              >
                <RadioGroupItem
                  id="action-cancel"
                  label={
                    <span className="inline-flex items-center gap-1">
                      <XCircleIcon className="size-4 text-error" /> Cancel runs
                    </span>
                  }
                  description="Cancels all runs still in progress. Any finished runs won’t be canceled."
                  value={"cancel"}
                  variant="description"
                />
                <RadioGroupItem
                  id="action-replay"
                  label={
                    <span className="inline-flex items-center gap-1">
                      <ArrowPathIcon className="size-4 text-blue-400" /> Replay runs
                    </span>
                  }
                  description="Replays all selected runs, regardless of current status."
                  value={"replay"}
                  variant="description"
                />
              </RadioGroup>
            </InputGroup>
            {action === "replay" && replayEnvironments.length > 0 && (
              <>
                <InputGroup>
                  <Label htmlFor="replayEnvironment">Environment</Label>
                  <Select
                    name="replayEnvironment"
                    variant="tertiary/medium"
                    dropdownIcon
                    items={replayEnvironments}
                    value={replayEnvironmentId}
                    setValue={(value) => {
                      setReplayEnvironmentId(value as string);
                      setReplayVersionChoice({
                        environmentId: value as string,
                        version: REPLAY_VERSION_CURRENT,
                      });
                    }}
                    text={(value) => renderReplayEnvironment(replayEnvironments, value)}
                  >
                    {replayEnvironments.map((env) => (
                      <SelectItem
                        key={env.id}
                        value={env.id}
                        // The select skips setValue when the picked environment is already
                        // selected, and that pick still means the current version.
                        onClick={() =>
                          setReplayVersionChoice({
                            environmentId: env.id,
                            version: REPLAY_VERSION_CURRENT,
                          })
                        }
                      >
                        <EnvironmentCombo environment={env} />
                      </SelectItem>
                    ))}
                  </Select>
                  <Hint>Replay the runs into another environment of this project.</Hint>
                </InputGroup>
                <InputGroup>
                  <Label htmlFor="version">Version</Label>
                  <Select
                    name="version"
                    variant="tertiary/medium"
                    dropdownIcon
                    items={versionItems}
                    value={effectiveReplayVersion}
                    setValue={(value) =>
                      setReplayVersionChoice({
                        environmentId: replayEnvironmentId,
                        version: value as string,
                      })
                    }
                    disabled={replayTargetIsDev}
                    text={(value) => versionItems.find((v) => v.value === value)?.label}
                  >
                    {versionItems.map((v) => (
                      <SelectItem key={v.value} value={v.value}>
                        {v.label}
                      </SelectItem>
                    ))}
                  </Select>
                  <Hint>
                    {replayTargetIsDev
                      ? DEV_VERSION_HINT
                      : replayIntoOtherEnv
                        ? "Current version runs each replay on the version deployed now in that environment."
                        : "Current version runs each replay on the version deployed now. Same as original run keeps each run on the version it first ran on."}
                  </Hint>
                  {replayMissingWarning ? (
                    <Paragraph
                      variant="extra-small"
                      className="flex items-start gap-1 text-warning"
                    >
                      <ExclamationTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                      {replayMissingWarning}
                    </Paragraph>
                  ) : null}
                </InputGroup>
              </>
            )}
            {showRegion && (
              <InputGroup>
                <Label htmlFor="region">Override region</Label>
                {/* Our Select primitive uses Ariakit, which treats value={undefined}
                    as uncontrolled and keeps stale state when switching environments.
                    The key forces a remount so it reinitializes with the default value. */}
                <Select
                  key={`bulk-region-${environment.id}`}
                  name="region"
                  variant="tertiary/medium"
                  dropdownIcon
                  items={regionItems}
                  defaultValue={REPLAY_REGION_NO_OVERRIDE_VALUE}
                  text={(value) => regionItems.find((r) => r.value === value)?.label}
                >
                  {regionItems.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                      {r.isDefault ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </Select>
                <Hint>
                  By default each run is replayed in its original region. Select a region to run
                  them all there instead.
                </Hint>
              </InputGroup>
            )}
            <InputGroup>
              <Label>Preview</Label>
              <BulkActionFilterSummary
                selected={mode === "selected" ? selectedItems.size : data?.count}
                mode={mode}
                action={action}
                filters={filters}
              />
            </InputGroup>
          </Fieldset>
        </div>
        {blockedByIgnoredFilter && (
          <Paragraph
            variant="extra-small"
            className="border-t border-grid-dimmed px-3 pt-2 text-right"
          >
            Remove the ignored filter to continue
          </Paragraph>
        )}
        <div
          className={cn(
            "flex items-center justify-end gap-2 px-2",
            !blockedByIgnoredFilter && "border-t border-grid-dimmed"
          )}
        >
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="secondary/medium"
                LeadingIcon={action === "replay" ? ArrowPathIcon : XCircleIcon}
                leadingIconClassName={cn(
                  "w-[1.3rem] h-[1.3rem]",
                  action === "replay" ? "text-blue-400" : "text-error"
                )}
                shortcut={{
                  modifiers: ["meta"],
                  key: "enter",
                  enabledOnInputElements: true,
                }}
                disabled={
                  impactedCountElement === 0 ||
                  isDialogOpen ||
                  isSubmitting ||
                  confirmDisabledReason !== undefined
                }
                tooltip={confirmDisabledReason}
              >
                {action === "replay" ? (
                  <span className="text-text-bright">Replay {impactedCountElement} runs…</span>
                ) : (
                  <span className="text-text-bright">Cancel {impactedCountElement} runs…</span>
                )}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>{action === "replay" ? "Replay runs" : "Cancel runs"}</DialogHeader>
              <div className="flex flex-col gap-4 pt-2">
                <div className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-2 [&>*]:min-h-5 [&>*]:leading-5">
                  <Paragraph variant="small">Runs</Paragraph>
                  <div className="text-sm text-text-bright">
                    {mode === "selected" ? (
                      simplur`${selectedItems.size} selected run[|s]`
                    ) : hasOnlyDefaultFilters(filters) ? (
                      <>
                        All runs from the last 7 days (<EstimatedCount count={data?.count} />)
                      </>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <BulkActionFilterChips filters={filters} />
                        <span>
                          <EstimatedCount count={data?.count} /> runs
                        </span>
                      </div>
                    )}
                  </div>
                  {action === "replay" && (
                    <>
                      <Paragraph variant="small">Environment</Paragraph>
                      <div className="flex items-center text-sm">
                        {replayEnvironmentLabel ? (
                          <EnvironmentCombo environment={replayEnvironmentLabel} />
                        ) : (
                          <EnvironmentCombo environment={environment} />
                        )}
                      </div>
                      <Paragraph variant="small">Version</Paragraph>
                      <span className="text-sm text-text-bright">
                        {versionItems.find((v) => v.value === effectiveReplayVersion)?.label ??
                          effectiveReplayVersion}
                      </span>
                    </>
                  )}
                </div>
                {replayMissingWarning ? (
                  <Paragraph variant="small" className="text-warning">
                    {replayMissingWarning}
                  </Paragraph>
                ) : null}
                {action === "cancel" && (
                  <Paragraph variant="small">
                    Runs that are still in progress will be canceled. If a run finishes before this
                    bulk action processes it, it can’t be canceled.
                  </Paragraph>
                )}
                <CheckboxWithLabel
                  name="emailNotification"
                  variant="simple/small"
                  label={`Email me when it finishes (${user.email})`}
                  form="bulk-action-form"
                  defaultChecked={false}
                  value="on"
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="tertiary/medium"
                  onClick={() => setIsDialogOpen(false)}
                >
                  Close
                </Button>
                <Button
                  type="submit"
                  form="bulk-action-form"
                  variant={action === "replay" ? "primary/medium" : "danger/medium"}
                  disabled={impactedCountElement === 0 || blockedByIgnoredFilter}
                  isLoading={isSubmitting}
                  shortcut={{
                    modifiers: ["meta"],
                    key: "enter",
                    enabledOnInputElements: true,
                  }}
                >
                  {action === "replay" ? (
                    <span className="text-text-bright">Replay {impactedCountElement} runs</span>
                  ) : (
                    <span className="text-text-bright">Cancel {impactedCountElement} runs</span>
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </Form>
  );
}

function renderReplayEnvironment(
  environments: { id: string; type: RuntimeEnvironmentType; slug: string; userName?: string }[],
  value: string
) {
  const env = environments.find((e) => e.id === value);
  return env ? <EnvironmentCombo environment={env} /> : undefined;
}

function bulkActionModeFromString(value: string | undefined): BulkActionMode {
  if (!value) return "filter";
  const parsed = BulkActionMode.safeParse(value);
  if (!parsed.success) return "filter";
  return parsed.data;
}

function bulkActionActionFromString(value: string | undefined): BulkActionAction {
  if (!value) return "cancel";
  const parsed = BulkActionAction.safeParse(value);
  if (!parsed.success) return "cancel";
  return parsed.data;
}
