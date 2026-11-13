import * as Ariakit from "@ariakit/react";
import { parseEnvironmentVariableForm } from "~/v3/environmentVariables/forms";
import { BookOpenIcon, InformationCircleIcon, PlusIcon } from "@heroicons/react/20/solid";
import {
  Link,
  Outlet,
  useFetcher,
  useLocation,
  useNavigate,
  useParams,
  useRevalidator,
  type ShouldRevalidateFunction,
} from "@remix-run/react";
import { json } from "@remix-run/server-runtime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ClipboardCheckIcon, ClipboardIcon } from "lucide-react";
import { matchSorter } from "match-sorter";
import { fromPromise } from "neverthrow";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import {
  EnvironmentCombo,
  EnvironmentIcon,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  collapsibleHandleClassName,
} from "~/components/primitives/Resizable";
import { SearchInput } from "~/components/primitives/SearchInput";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Switch } from "~/components/primitives/Switch";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { prisma } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useCopy } from "~/hooks/useCopy";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { EnvironmentVariableKeyPresenter } from "~/presenters/v3/EnvironmentVariableKeyPresenter.server";
import { EnvironmentVariablesPresenter } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { type EnvironmentVariablesEnvironment } from "~/presenters/v3/environmentVariablesEnvironments.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  docsPath,
  v3EnvironmentVariableKeyPath,
  v3EnvironmentVariablesPath,
  v3NewEnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import {
  ALL_BRANCHES,
  availableEnvironmentVariablesFilters,
  canSortEnvironmentVariablesView,
  environmentTypeForFilter,
  listViewSearch,
  nextEnvironmentVariablesSort,
  parseEnvironmentVariablesFilter,
  parseEnvironmentVariablesSort,
  selectEnvironmentVariablesFilter,
  type EnvironmentVariablesFilter,
} from "~/v3/environmentVariables/environmentFilter";
import {
  keyPanelViewSearch,
  listedPreviewBase,
  navigationKeepsList,
  type PreviewBaseState,
} from "~/v3/environmentVariables/environmentVariableKey";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { findTargetEnvironments } from "~/v3/environmentVariables/targetEnvironments.server";
import { findUnauthorizedEnvironmentId } from "~/v3/writableEnvironments";
import {
  isPullEnvVarsEnabledForEnvironment,
  shouldSyncEnvVar,
  type TriggerEnvironmentType,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { sectionAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { WhenAgentUnavailable } from "~/components/dashboard-agent/WhenAgentUnavailable";
import type { Handle } from "~/utils/handle";
import {
  DeleteEnvironmentVariableButton,
  EditEnvironmentVariablePanel,
  EnvironmentVariableUpdated,
  EnvironmentVariableValue,
  maskEnvironmentVariable,
  schema,
  type EnvironmentVariablesPageLoaderData,
  type MaskedEnvironmentVariable,
  type PageVercelIntegration,
} from "./EnvironmentVariableControls";

export const handle: Handle = {
  agentPageContext: () => sectionAgentPageContext("envvars"),
};
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("Environment variables");

/** What the list hands the route under it: the key panel or the create dialog. */
export type EnvironmentVariablesOutletContext = {
  revealAll: boolean;
};

// The key panel keeps its own search params (its branches search and page) next to the
// list's. A navigation that changes only those, on the same project and environment, leaves
// the list as it is, so don't reload it. Anything after a form submission still revalidates.
export const shouldRevalidate: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  currentParams,
  nextParams,
  formMethod,
  defaultShouldRevalidate,
}) => {
  if (
    (formMethod === undefined || formMethod.toUpperCase() === "GET") &&
    navigationKeepsList({ currentUrl, nextUrl, currentParams, nextParams })
  ) {
    return false;
  }

  return defaultShouldRevalidate;
};

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    searchParams: z.object({
      page: z.coerce.number().int().min(1).catch(1),
      search: z.string().trim().min(1).optional().catch(undefined),
      // dev | stg | prod | preview | all. Anything else is treated as absent, which means the
      // type of the environment in the URL.
      env: z.string().optional().catch(undefined),
      // updated | updated-asc. Anything else is alphabetical by key.
      sort: z.string().optional().catch(undefined),
    }),
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    // No hard authorization: the page can list every environment. Values in
    // environments the role can't read are masked per-tier below.
  },
  async ({ params, searchParams, user, ability, context, request }) => {
    const { projectId } = context;
    if (!projectId) {
      throw new Response("Not Found", { status: 404 });
    }

    try {
      const presenter = new EnvironmentVariablesPresenter();
      const {
        environmentVariables,
        environments,
        filter,
        filterEnvironmentIds,
        filterBranchEnvironmentIds,
        projectHasNoVariables,
        hasStaging,
        vercelIntegration,
        pagination,
        allowEmptyEnvironmentVariableValues,
      } = await presenter.call({
        userId: user.id,
        projectId,
        page: searchParams.page,
        search: searchParams.search,
        environmentFilter: parseEnvironmentVariablesFilter(searchParams.env),
        // One `branch` per preview branch name, or "all" for every branch. Only used with the
        // Preview filter; unknown names are ignored.
        branches: new URL(request.url).searchParams.getAll("branch"),
        currentEnvironmentSlug: params.envParam,
        sort: parseEnvironmentVariablesSort(searchParams.sort),
      });

      const accessibleEnvironmentIds = environments
        .filter((env) => ability.can("read", { type: "envvars", envType: env.type }))
        .map((env) => env.id);
      const accessible = new Set(accessibleEnvironmentIds);

      // Write access is a separate grant from read: gate write controls (edit,
      // delete, create) on this set, not on read-accessibility.
      const writableEnvironmentIds = environments
        .filter((env) => ability.can("write", { type: "envvars", envType: env.type }))
        .map((env) => env.id);

      // Withhold values (and the "who/when" metadata) for environments the
      // role can't read — never serialize them to the client.
      const masked: MaskedEnvironmentVariable[] = environmentVariables.map((variable) =>
        accessible.has(variable.environment.id) ? variable : maskEnvironmentVariable(variable)
      );

      return typedjson({
        environmentVariables: masked,
        allowEmptyEnvironmentVariableValues,
        environments,
        filter,
        filterEnvironmentIds,
        filterBranchEnvironmentIds,
        projectHasNoVariables,
        hasStaging,
        vercelIntegration,
        accessibleEnvironmentIds,
        writableEnvironmentIds,
        pagination,
        search: searchParams.search,
      });
    } catch (error) {
      console.error(error);
      throw new Response(undefined, {
        status: 400,
        statusText: "Something went wrong, if this problem persists please contact support.",
      });
    }
  }
);

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    // Per-environment write:envvars is enforced in the handler — the target
    // environment tier comes from the submission, not the route params.
  },
  async ({ request, params, user, ability, context }) => {
    const userId = user.id;
    const { organizationSlug, projectParam, envParam } = params;

    const { projectId } = context;
    if (!projectId) {
      throw new Response("Not Found", { status: 404 });
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId, organization: { members: { some: { userId } } } },
      select: { id: true },
    });
    if (!project) {
      throw new Response("Not Found", { status: 404 });
    }

    if (request.method.toUpperCase() !== "POST") {
      throw new Response("Method Not Allowed", { status: 405 });
    }

    const formData = await request.formData();
    const submission = parseEnvironmentVariableForm(formData, schema);

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    // Enforce env-tier write:envvars on the targeted environment, so a role
    // that can't write a deployed tier can't mutate it via a direct POST.
    // Archived environments are left out, so an archived id answers "Environment not found".
    const submittedEnvs =
      submission.value.action === "update-vercel-sync"
        ? []
        : await findTargetEnvironments(prisma, projectId, [submission.value.environmentId]);
    const targetEnvType =
      submission.value.action === "update-vercel-sync"
        ? submission.value.environmentType
        : submittedEnvs[0]?.type;
    if (!targetEnvType) {
      return json(submission.reply({ formErrors: ["Environment not found"] }));
    }
    if (!ability.can("write", { type: "envvars", envType: targetEnvType })) {
      return json(
        submission.reply({
          formErrors: [
            "You don't have permission to manage environment variables in this environment.",
          ],
        })
      );
    }

    // Per-env write gate for the mutating value actions: `environmentId` is a
    // user-supplied hidden field and the repository only checks project
    // membership. Mirrors the create route's check.
    // The submitted environment's branch name, for the delete toast.
    let submittedBranchName: string | null = null;
    if (submission.value.action === "edit" || submission.value.action === "delete") {
      submittedBranchName = submittedEnvs[0]?.branchName ?? null;
      const unauthorizedEnvironmentId = findUnauthorizedEnvironmentId(
        submittedEnvs,
        [submission.value.environmentId],
        userId
      );
      if (unauthorizedEnvironmentId) {
        return json(submission.reply({ formErrors: ["This environment is not writable by you."] }));
      }
    }

    switch (submission.value.action) {
      case "edit": {
        const repository = new EnvironmentVariablesRepository(prisma);
        const result = await repository.editValue(projectId, {
          ...submission.value,
          lastUpdatedBy: {
            type: "user",
            userId,
          },
        });

        if (!result.success) {
          return json(submission.reply({ formErrors: [result.error] }));
        }

        return json({ ...submission.reply(), success: true });
      }
      case "delete": {
        const repository = new EnvironmentVariablesRepository(prisma);
        const result = await repository.deleteValue(projectId, submission.value);

        if (!result.success) {
          return json(submission.reply({ formErrors: [result.error] }));
        }

        // Clean up syncEnvVarsMapping if Vercel integration exists (best-effort)
        const { environmentId, key } = submission.value;
        const vercelService = new VercelIntegrationService();
        await fromPromise(
          (async () => {
            const integration = await vercelService.getVercelProjectIntegration(projectId);
            if (integration) {
              const runtimeEnv = await prisma.runtimeEnvironment.findUnique({
                where: { id: environmentId },
                select: { type: true },
              });
              if (runtimeEnv) {
                await vercelService.removeSyncEnvVarForEnvironment(
                  projectId,
                  key,
                  runtimeEnv.type as TriggerEnvironmentType
                );
              }
            }
          })(),
          (error) => error
        ).mapErr((error) => {
          logger.error("Failed to remove Vercel sync mapping", { error });
          return error;
        });

        // Stay on the view the delete was made from, with the key panel still open when it
        // was open and its key has a value left.
        const { panelKey } = submission.value;
        const slugs = [
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: envParam },
        ] as const;
        const keepPanelOpen =
          panelKey !== undefined &&
          (await new EnvironmentVariableKeyPresenter().isSet({ userId, projectId, key: panelKey }));

        return redirectWithSuccessMessage(
          keepPanelOpen
            ? `${v3EnvironmentVariableKeyPath(...slugs, panelKey)}${keyPanelViewSearch(request.url)}`
            : `${v3EnvironmentVariablesPath(...slugs)}${listViewSearch(request.url)}`,
          request,
          submittedBranchName
            ? `Removed the ${submission.value.key} override on ${submittedBranchName}`
            : `Deleted ${submission.value.key} environment variable`
        );
      }
      case "update-vercel-sync": {
        const vercelService = new VercelIntegrationService();
        const integration = await vercelService.getVercelProjectIntegration(projectId);

        if (!integration) {
          return json(submission.reply({ formErrors: ["Vercel integration not found"] }));
        }

        // Update the sync mapping for the specific env var and environment
        await vercelService.updateSyncEnvVarForEnvironment(
          projectId,
          submission.value.key,
          submission.value.environmentType,
          submission.value.syncEnabled
        );

        return json({ success: true });
      }
    }
  }
);

const SSR_ROW_WINDOW = 50;
const ROW_ESTIMATE_HEIGHT = 44;
const VIRTUAL_OVERSCAN = 10;

type GroupedEnvironmentVariable = MaskedEnvironmentVariable & {
  isFirstTime: boolean;
  isLastTime: boolean;
  occurences: number;
  /** For a Preview branch's row: whether the key has a Preview value the branch falls back to. */
  previewBase: PreviewBaseState;
};

export default function Page() {
  const loaderData = useTypedLoaderData<EnvironmentVariablesPageLoaderData>();

  return <EnvironmentVariablesListPage loaderData={loaderData} />;
}

function EnvironmentVariablesListPage({
  loaderData,
}: {
  loaderData: EnvironmentVariablesPageLoaderData;
}) {
  const [revealAll, setRevealAll] = useState(false);
  const {
    environmentVariables,
    environments,
    filter,
    filterBranchEnvironmentIds,
    filterEnvironmentIds,
    projectHasNoVariables,
    vercelIntegration,
    pagination,
    search,
  } = loaderData;
  const location = useLocation();
  const hasSearch = Boolean(search);
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  // Whether the view a URL's search params ask for can be sorted by last update: the rule the
  // loader applies, worked out here so a click can tell before the next page loads.
  const canSortView = (params: URLSearchParams) =>
    canSortEnvironmentVariablesView(
      selectEnvironmentVariablesFilter({
        environments,
        requested: parseEnvironmentVariablesFilter(params.get("env")),
        requestedBranches: params.getAll("branch"),
        currentEnvironmentId: environment.id,
        currentEnvironmentType: environment.type,
      })
    );
  // Read from the URL, so the header arrow moves on click while the next page loads. A view that
  // can't be sorted ignores the param.
  const currentSearchParams = new URLSearchParams(location.search);
  const isSortableView = canSortView(currentSearchParams);
  const selectedSort = isSortableView
    ? parseEnvironmentVariablesSort(currentSearchParams.get("sort"))
    : undefined;
  const navigate = useNavigate();
  const { value: searchParamValue, values: searchParamValues } = useSearchParams();
  const filteredItems = environmentVariables;
  // The key open in the side panel, carried by the nested key route.
  const { keyParam } = useParams();
  const isShowingKeyPanel = keyParam !== undefined;
  const outletContext: EnvironmentVariablesOutletContext = { revealAll };

  const filterOptions = useMemo(
    () => availableEnvironmentVariablesFilters(environments),
    [environments]
  );
  // Follow the URL while the next page loads, so the control moves on click.
  const urlFilter = parseEnvironmentVariablesFilter(searchParamValue("env"));
  const selectedFilter = urlFilter && filterOptions.includes(urlFilter) ? urlFilter : filter;

  const previewBranches = useMemo(
    () => environments.filter((env) => env.type === "PREVIEW" && env.parentEnvironmentId !== null),
    [environments]
  );
  // The ticked branch environment ids; none means every branch. Follows the URL like the filter
  // does, and falls back to the loader's (the current branch on a branch URL).
  // Memoized on the URL so the picker gets the same array until the selection changes.
  const urlBranchesKey = searchParamValues("branch").join("\n");
  const selectedBranchIds = useMemo(() => {
    const urlBranches = urlBranchesKey ? urlBranchesKey.split("\n") : [];
    if (urlBranches.includes(ALL_BRANCHES)) {
      return [];
    }
    const urlBranchIds = previewBranches
      .filter((env) => env.branchName !== null && urlBranches.includes(env.branchName))
      .map((env) => env.id);
    return urlBranchIds.length > 0 ? urlBranchIds : filterBranchEnvironmentIds;
  }, [urlBranchesKey, previewBranches, filterBranchEnvironmentIds]);

  // Picking a view adds a history entry, so Back returns to the previous one. Search replaces.
  const navigateToView = (
    values: Record<string, string | string[] | undefined>,
    { replace = false }: { replace?: boolean } = {}
  ) => {
    const params = new URLSearchParams(location.search);
    for (const [name, value] of Object.entries(values)) {
      params.delete(name);
      for (const v of value === undefined ? [] : Array.isArray(value) ? value : [value]) {
        params.append(name, v);
      }
    }
    // The sort doesn't follow into a view that can't be sorted.
    if (!canSortView(params)) {
      params.delete("sort");
    }
    navigate(`${location.pathname}?${params.toString()}`, { replace });
  };

  // The first tick after the branch picker opens adds a history entry and the rest replace it,
  // so Back undoes one round of picking.
  const branchPickPushedRef = useRef(false);
  const selectBranches = (picked: string[]) => {
    // The reset row is never in the selection, so it's only in `picked` when it was just clicked.
    const reset = picked.includes(RESET_BRANCHES_VALUE);
    if (reset && selectedBranchIds.length === 0) {
      return;
    }
    const branchIds = reset ? [] : picked;
    const names = previewBranches
      .filter((env) => branchIds.includes(env.id) && env.branchName !== null)
      .map((env) => env.branchName!);
    navigateToView(
      {
        env: "preview",
        // On a branch URL no branch means that branch, so "All branches" has to be explicit.
        branch:
          names.length > 0
            ? names
            : environment.type === "PREVIEW" && environment.branchName
              ? ALL_BRANCHES
              : undefined,
        page: undefined,
      },
      { replace: branchPickPushedRef.current }
    );
    branchPickPushedRef.current = true;
  };

  // The unsearched view's key count. With a search active the page only has the searched count.
  const searchPlaceholder = hasSearch
    ? "Search variables…"
    : `Search ${pagination.totalCount} ${pagination.totalCount === 1 ? "key" : "keys"}…`;

  // The create dialog reads the filter from this route's loader data, so its URL keeps the
  // search params. That also brings the user back to the same view when it closes.
  // With the key panel open the dialog opens over it, from the panel's own create route.
  const newVariablePath = `${
    keyParam !== undefined
      ? `${v3EnvironmentVariableKeyPath(organization, project, environment, keyParam)}/new`
      : v3NewEnvironmentVariablesPath(organization, project, environment)
  }${location.search}`;

  // The same list for every environment. Keeps the search, starts at the first page.
  const allEnvironmentsSearchParams = new URLSearchParams(location.search);
  allEnvironmentsSearchParams.set("env", "all");
  allEnvironmentsSearchParams.delete("page");
  allEnvironmentsSearchParams.delete("sort");
  const allEnvironmentsPath = `${location.pathname}?${allEnvironmentsSearchParams.toString()}`;

  const tableScrollRef = useRef<HTMLDivElement>(null);

  // Add isFirst and isLast to each environment variable
  // They're set based on if they're the first or last time that `key` has been seen in the list
  const groupedEnvironmentVariables = useMemo((): GroupedEnvironmentVariable[] => {
    // Create a map to track occurrences of each key
    const keyOccurrences = new Map<string, number>();

    // First pass: count total occurrences of each key
    filteredItems.forEach((variable) => {
      keyOccurrences.set(variable.key, (keyOccurrences.get(variable.key) || 0) + 1);
    });

    // Second pass: add isFirstTime, isLastTime, and occurrences flags
    const seenKeys = new Set<string>();
    const currentOccurrences = new Map<string, number>();
    const previewEnvironmentId = environments.find(
      (env) => env.type === "PREVIEW" && env.parentEnvironmentId === null
    )?.id;

    return filteredItems.map((variable) => {
      // Track current occurrence number for this key
      const currentCount = (currentOccurrences.get(variable.key) || 0) + 1;
      currentOccurrences.set(variable.key, currentCount);

      const totalOccurrences = keyOccurrences.get(variable.key) || 1;
      const isFirstTime = !seenKeys.has(variable.key);
      const isLastTime = currentCount === totalOccurrences;

      if (isFirstTime) {
        seenKeys.add(variable.key);
      }

      return {
        ...variable,
        isFirstTime,
        isLastTime,
        occurences: totalOccurrences,
        previewBase: listedPreviewBase(
          variable.key,
          filteredItems,
          previewEnvironmentId,
          filterEnvironmentIds
        ),
      };
    });
  }, [filteredItems, environments, filterEnvironmentIds]);

  const shouldVirtualize = groupedEnvironmentVariables.length > SSR_ROW_WINDOW;
  const [isVirtualized, setIsVirtualized] = useState(false);

  useLayoutEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
    setIsVirtualized(shouldVirtualize);
  }, [shouldVirtualize]);

  const staticRows = useMemo(() => {
    if (shouldVirtualize) {
      return groupedEnvironmentVariables.slice(0, SSR_ROW_WINDOW);
    }
    return groupedEnvironmentVariables;
  }, [groupedEnvironmentVariables, shouldVirtualize]);

  const vercelColumnCount = vercelIntegration?.enabled ? 6 : 5;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Environment variables" />
        <PageAccessories>
          <WhenAgentUnavailable>
            <LinkButton
              LeadingIcon={BookOpenIcon}
              to={docsPath("v3/deploy-environment-variables")}
              variant="docs/small"
            >
              Environment variables docs
            </LinkButton>
          </WhenAgentUnavailable>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="environment-variables-main" min={"100px"}>
            <div className={cn("flex h-full min-h-0 flex-col")}>
              {/* One row that wraps when the key panel leaves it too little room. The search,
                  filter and branch picker are items of the row itself (`contents`), so they wrap
                  one by one and stay next to each other; Reveal values and Add new stay together
                  at the right end of their line. */}
              <div className="flex flex-wrap items-center gap-1.5 px-2 py-2">
                <div className="contents">
                  <SearchInput
                    placeholder={searchPlaceholder}
                    resetParams={["page"]}
                    shortcut={{ key: "/" }}
                    autoFocus
                  />
                  <SegmentedControl
                    name="env"
                    variant="secondary/small"
                    value={selectedFilter}
                    options={filterOptions.map((option) => ({
                      value: option,
                      label: <EnvironmentFilterLabel filter={option} />,
                    }))}
                    onChange={(value) =>
                      navigateToView({ env: value, branch: undefined, page: undefined })
                    }
                  />
                  {selectedFilter === "preview" && previewBranches.length > 0 && (
                    <Select<string[], EnvironmentVariablesEnvironment>
                      variant="secondary/small"
                      value={selectedBranchIds}
                      setValue={selectBranches}
                      setOpen={(open) => {
                        if (open) {
                          branchPickPushedRef.current = false;
                        }
                      }}
                      placeholder="All branches"
                      items={previewBranches}
                      className="w-fit min-w-40"
                      filter={{
                        // Only names that contain what was typed: no acronym or fuzzy matches.
                        threshold: matchSorter.rankings.CONTAINS,
                        // The raw name so a typed "/" matches, and a spaced one so "audit log" does too.
                        keys: [
                          (item) => item.branchName ?? "",
                          (item) => item.branchName?.replace(/[/_-]/g, " ") ?? "",
                        ],
                      }}
                      empty={<div className="p-3 text-xs text-text-dimmed">No branches found.</div>}
                      text={(value) =>
                        value.length === 0
                          ? "All branches"
                          : value.length === 1
                            ? (previewBranches.find((env) => env.id === value[0])?.branchName ??
                              "1 branch")
                            : `${value.length} branches`
                      }
                      dropdownIcon
                    >
                      {(matches) => (
                        <>
                          <SelectItem
                            value={RESET_BRANCHES_VALUE}
                            hideOnClick
                            checkIcon={
                              <Ariakit.SelectItemCheck
                                checked={selectedBranchIds.length === 0}
                                className="size-8 flex-none text-text-bright"
                              />
                            }
                            className="border-b border-grid-dimmed"
                          >
                            All branches
                          </SelectItem>
                          {matches?.map((env) => (
                            <SelectItem key={env.id} value={env.id}>
                              {env.branchName}
                            </SelectItem>
                          ))}
                        </>
                      )}
                    </Select>
                  )}
                </div>
                <div className="ml-auto flex items-center justify-end gap-1.5 pl-0.5">
                  <Switch
                    variant="secondary/small"
                    label="Reveal values"
                    checked={revealAll}
                    onCheckedChange={(e) => setRevealAll(e.valueOf())}
                  />
                  <LinkButton
                    to={newVariablePath}
                    variant="primary/small"
                    LeadingIcon={PlusIcon}
                    shortcut={{ key: "n", ignoreWhileDialogOpen: true }}
                  >
                    Add new
                  </LinkButton>
                </div>
              </div>
              <div
                ref={tableScrollRef}
                className="min-h-0 flex-1 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
              >
                <Table
                  containerClassName={cn(
                    filteredItems.length === 0 && "border-t-0",
                    "overflow-visible"
                  )}
                >
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell
                        className={vercelIntegration?.enabled ? "w-[22%]" : "w-[25%]"}
                      >
                        Key
                      </TableHeaderCell>
                      <TableHeaderCell
                        className={vercelIntegration?.enabled ? "w-[32%]" : "w-[37%]"}
                      >
                        Value
                      </TableHeaderCell>
                      <TableHeaderCell
                        className={vercelIntegration?.enabled ? "w-[13%]" : "w-[15%]"}
                      >
                        <SimpleTooltip
                          button={
                            <span className="flex items-center gap-1">
                              Environment
                              <InformationCircleIcon className="size-4 text-text-dimmed" />
                            </span>
                          }
                          content="Dev environment variables specified here will be overridden by ones in your .env file when running locally."
                          className="max-w-60"
                        />
                      </TableHeaderCell>
                      {vercelIntegration?.enabled && (
                        <TableHeaderCell className="w-[8%]">
                          <SimpleTooltip
                            button={
                              <span className="flex items-center gap-1">
                                Sync
                                <InformationCircleIcon className="size-4 text-text-dimmed" />
                              </span>
                            }
                            content="When enabled, this variable will be pulled from Vercel during builds. Requires 'Pull env vars before build' to be enabled in settings."
                          />
                        </TableHeaderCell>
                      )}
                      <TableHeaderCell
                        className={vercelIntegration?.enabled ? "w-[24%]" : "w-[22%]"}
                        sortDirection={
                          selectedSort === "updated"
                            ? "desc"
                            : selectedSort === "updated-asc"
                              ? "asc"
                              : null
                        }
                        onSort={
                          isSortableView
                            ? () =>
                                navigateToView({
                                  sort: nextEnvironmentVariablesSort(selectedSort),
                                  page: undefined,
                                })
                            : undefined
                        }
                        tooltip={
                          isSortableView
                            ? undefined
                            : "Pick one environment to sort by last updated."
                        }
                      >
                        Updated
                      </TableHeaderCell>
                      <TableHeaderCell hiddenLabel className="w-0">
                        Actions
                      </TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  {groupedEnvironmentVariables.length > 0 ? (
                    isVirtualized && shouldVirtualize ? (
                      <EnvironmentVariablesVirtualTableBody
                        groupedEnvironmentVariables={groupedEnvironmentVariables}
                        scrollRef={tableScrollRef}
                        revealAll={revealAll}
                        vercelIntegration={vercelIntegration}
                        columnCount={vercelColumnCount}
                      />
                    ) : (
                      <TableBody>
                        {staticRows.map((variable) => (
                          <EnvironmentVariableTableRow
                            key={`${variable.id}-${variable.environment.id}`}
                            variable={variable}
                            revealAll={revealAll}
                            vercelIntegration={vercelIntegration}
                          />
                        ))}
                      </TableBody>
                    )
                  ) : (
                    <TableBody>
                      <TableRow>
                        <TableCell colSpan={vercelColumnCount}>
                          {!hasSearch ? (
                            <div className="flex flex-col items-center justify-center gap-y-4 py-8">
                              <Header2>
                                {projectHasNoVariables
                                  ? "You haven't set any environment variables yet."
                                  : `No variables in ${environmentFilterLabels[filter]} yet`}
                              </Header2>
                              <div className="flex items-center gap-2">
                                <LinkButton
                                  to={newVariablePath}
                                  variant="primary/medium"
                                  LeadingIcon={PlusIcon}
                                  shortcut={{ key: "n", ignoreWhileDialogOpen: true }}
                                >
                                  Add new
                                </LinkButton>
                                {!projectHasNoVariables && (
                                  <LinkButton to={allEnvironmentsPath} variant="secondary/medium">
                                    View all environments
                                  </LinkButton>
                                )}
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center justify-center gap-y-4 py-8">
                              <Paragraph>
                                {filter === "all"
                                  ? "No variables match your search."
                                  : `No variables in ${environmentFilterLabels[filter]} match your search.`}
                              </Paragraph>
                              {filter !== "all" && (
                                <LinkButton to={allEnvironmentsPath} variant="secondary/small">
                                  Search all environments
                                </LinkButton>
                              )}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  )}
                </Table>
              </div>
              {pagination.totalPages > 1 && (
                <div className="flex items-center justify-end border-t border-grid-dimmed px-2 py-2">
                  <PaginationControls
                    currentPage={pagination.currentPage}
                    totalPages={pagination.totalPages}
                  />
                </div>
              )}
            </div>
          </ResizablePanel>
          <ResizableHandle
            id="environment-variables-handle"
            className={collapsibleHandleClassName(isShowingKeyPanel)}
          />
          <ResizablePanel
            id="environment-variables-key"
            min="420px"
            // Narrow enough that, in a 1280px window, the search and the filter still share the
            // toolbar's first line next to the panel.
            default="480px"
            className="overflow-hidden"
            collapsible
            collapsed={!isShowingKeyPanel}
            onCollapseChange={() => {}}
            collapsedSize="0px"
            collapseAnimation={RESIZABLE_PANEL_ANIMATION}
          >
            <div className="h-full" style={{ minWidth: 420 }}>
              {isShowingKeyPanel && <Outlet context={outletContext} />}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
      {/* Without a key panel the only route under the list is the create dialog. */}
      {!isShowingKeyPanel && <Outlet context={outletContext} />}
    </PageContainer>
  );
}

// The picker's "All branches" row. Not a branch environment id, so it never matches one.
const RESET_BRANCHES_VALUE = "__all_branches__";

const environmentFilterLabels: Record<EnvironmentVariablesFilter, string> = {
  dev: "Dev",
  stg: "Staging",
  prod: "Prod",
  preview: "Preview",
  all: "All",
};

function EnvironmentFilterLabel({ filter }: { filter: EnvironmentVariablesFilter }) {
  if (filter === "all") {
    return <span>{environmentFilterLabels.all}</span>;
  }

  const environment = { type: environmentTypeForFilter(filter) };

  return (
    <span className="flex items-center gap-1">
      <EnvironmentIcon environment={environment} className="size-3.5 shrink-0" />
      <span className={environmentTextClassName(environment)}>
        {environmentFilterLabels[filter]}
      </span>
    </span>
  );
}

function getBorderedCellClassName(variable: GroupedEnvironmentVariable) {
  if (variable.occurences <= 1) {
    return "";
  }

  if (variable.isLastTime) {
    return "";
  }

  return "relative after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright group-hover/table-row:after:bg-grid-bright group-hover/table-row:before:bg-grid-bright";
}

function EnvironmentVariableTableRow({
  variable,
  revealAll,
  vercelIntegration,
}: {
  variable: GroupedEnvironmentVariable;
  revealAll: boolean;
  vercelIntegration: PageVercelIntegration | null;
}) {
  const cellClassName = "py-2";
  const borderedCellClassName = getBorderedCellClassName(variable);
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  // Any row of a key opens that key's panel, keeping the list's view.
  const path = `${v3EnvironmentVariableKeyPath(organization, project, environment, variable.key)}${listViewSearch(new URLSearchParams(location.search))}`;
  // Every row of the key open in the side panel is marked, as the selected row is on other lists.
  const { keyParam } = useParams();
  const isSelected = keyParam === variable.key;

  return (
    <TableRow
      className={variable.isLastTime ? "after:bg-surface-control" : "after:bg-transparent"}
      isSelected={isSelected}
    >
      <TableCell
        to={path}
        isTabbableCell
        isSelected={isSelected}
        actionClassName="font-mono"
        trailingContent={variable.isFirstTime ? <CopyKeyButton value={variable.key} /> : undefined}
      >
        {variable.isFirstTime ? variable.key : null}
      </TableCell>
      <TableCell
        className={cn(cellClassName, borderedCellClassName, "relative after:left-3")}
        isSelected={isSelected}
        hasAction
      >
        <RowLink to={path} />
        {/* Above the row's link, and only the value's own controls take clicks. */}
        <div className="pointer-events-none relative w-full [&_button]:pointer-events-auto [&_input]:pointer-events-auto">
          <EnvironmentVariableValue variable={variable} revealAll={revealAll} />
        </div>
      </TableCell>

      <TableCell to={path} className={borderedCellClassName} isSelected={isSelected}>
        <EnvironmentCombo environment={variable.environment} className="text-sm" />
      </TableCell>
      {vercelIntegration?.enabled && (
        <TableCell
          className={cn(cellClassName, borderedCellClassName, "relative")}
          isSelected={isSelected}
          hasAction
        >
          <RowLink to={path} />
          {variable.environment.type !== "DEVELOPMENT" && (
            <div className="relative w-fit">
              <VercelSyncCheckbox
                envVarKey={variable.key}
                environmentType={variable.environment.type as TriggerEnvironmentType}
                syncEnabled={shouldSyncEnvVar(
                  vercelIntegration.syncEnvVarsMapping,
                  variable.key,
                  variable.environment.type as TriggerEnvironmentType
                )}
                pullEnvVarsEnabledForEnv={isPullEnvVarsEnabledForEnvironment(
                  vercelIntegration.pullEnvVarsBeforeBuild,
                  variable.environment.type as TriggerEnvironmentType
                )}
              />
            </div>
          )}
        </TableCell>
      )}
      <TableCell to={path} className={borderedCellClassName} isSelected={isSelected}>
        <EnvironmentVariableUpdated variable={variable} />
      </TableCell>
      <TableCellMenu
        isSticky
        isSelected={isSelected}
        className="[&:has([data-hidden-buttons])]:w-auto w-0"
        hiddenButtons={
          // No edit/delete for environments the role can't manage — the value
          // is withheld, and the action enforces write:envvars independently.
          variable.permissionDenied ? undefined : (
            <>
              <EditEnvironmentVariablePanel variable={variable} revealAll={revealAll} />
              <DeleteEnvironmentVariableButton
                variable={variable}
                previewBase={variable.previewBase}
              />
            </>
          )
        }
      />
    </TableRow>
  );
}

/**
 * The row's link under a cell that holds its own controls: it fills the cell, so a click
 * anywhere else in the cell opens the panel. Not a tab stop: the key cell's link is the row's.
 */
function RowLink({ to }: { to: string }) {
  return <Link to={to} tabIndex={-1} aria-hidden className="absolute inset-0" />;
}

/** Copies the key. Shown while the row is hovered or the button has focus. */
function CopyKeyButton({ value }: { value: string }) {
  const { copy, copied } = useCopy(value);
  return (
    <SimpleTooltip
      asChild
      disableHoverableContent
      button={
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy"}
          onClick={copy}
          className={cn(
            "flex size-6 items-center justify-center rounded border border-border-bright bg-background-hover opacity-0 transition-opacity focus-visible:opacity-100 group-hover/table-row:opacity-100",
            copied
              ? "text-green-500 opacity-100"
              : "text-text-dimmed hover:bg-background-raised hover:text-text-bright"
          )}
        >
          {copied ? (
            <ClipboardCheckIcon className="size-3.5" />
          ) : (
            <ClipboardIcon className="size-3.5" />
          )}
        </button>
      }
      content={copied ? "Copied" : "Copy"}
    />
  );
}

function EnvironmentVariablesVirtualTableBody({
  groupedEnvironmentVariables,
  scrollRef,
  revealAll,
  vercelIntegration,
  columnCount,
}: {
  groupedEnvironmentVariables: GroupedEnvironmentVariable[];
  scrollRef: RefObject<HTMLDivElement | null>;
  revealAll: boolean;
  vercelIntegration: PageVercelIntegration | null;
  columnCount: number;
}) {
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual is not compatible with compiler memoization.
  const rowVirtualizer = useVirtualizer({
    count: groupedEnvironmentVariables.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_HEIGHT,
    overscan: VIRTUAL_OVERSCAN,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const topSpacerHeight = virtualItems[0]?.start ?? 0;
  const bottomSpacerHeight = rowVirtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0);

  return (
    <TableBody>
      {topSpacerHeight > 0 && (
        <tr aria-hidden style={{ height: topSpacerHeight }}>
          <td colSpan={columnCount} />
        </tr>
      )}
      {virtualItems.map((virtualRow) => {
        const variable = groupedEnvironmentVariables[virtualRow.index];
        if (!variable) {
          return null;
        }

        return (
          <EnvironmentVariableTableRow
            key={`${variable.id}-${variable.environment.id}`}
            variable={variable}
            revealAll={revealAll}
            vercelIntegration={vercelIntegration}
          />
        );
      })}
      {bottomSpacerHeight > 0 && (
        <tr aria-hidden style={{ height: bottomSpacerHeight }}>
          <td colSpan={columnCount} />
        </tr>
      )}
    </TableBody>
  );
}

/**
 * Toggle component for controlling whether an environment variable is pulled from Vercel.
 *
 * When enabled, the variable will be pulled from Vercel during builds.
 * By default, all variables are pulled unless explicitly disabled.
 *
 * Note: If the env slug is missing from syncEnvVarsMapping, all vars are pulled by default.
 * Only when syncEnvVarsMapping[envSlug][envVarName] = false, the env var is skipped during builds.
 */
function VercelSyncCheckbox({
  envVarKey,
  environmentType,
  syncEnabled,
  pullEnvVarsEnabledForEnv,
}: {
  envVarKey: string;
  environmentType: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";
  syncEnabled: boolean;
  pullEnvVarsEnabledForEnv: boolean;
}) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const isLoading = fetcher.state !== "idle";

  // Revalidate loader data after successful submission (without full page reload)
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      const data = fetcher.data as { success?: boolean };
      if (data.success) {
        revalidator.revalidate();
      }
    }
  }, [fetcher.state, fetcher.data, revalidator]);

  const handleChange = (checked: boolean) => {
    fetcher.submit(
      {
        action: "update-vercel-sync",
        key: envVarKey,
        environmentType,
        syncEnabled: checked.toString(),
      },
      { method: "post" }
    );
  };

  // If pull env vars is disabled for this environment, show disabled state
  if (!pullEnvVarsEnabledForEnv) {
    return (
      <SimpleTooltip
        button={<Switch variant="small" checked={false} disabled onCheckedChange={() => {}} />}
        content="Enable 'Pull env vars before build' for this environment in Vercel settings."
      />
    );
  }

  return (
    <Switch
      variant="small"
      checked={syncEnabled}
      disabled={isLoading}
      onCheckedChange={handleChange}
    />
  );
}
