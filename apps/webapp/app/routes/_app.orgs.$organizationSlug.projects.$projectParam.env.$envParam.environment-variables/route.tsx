import * as Ariakit from "@ariakit/react";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { getFormProps, getInputProps, useForm } from "@conform-to/react";
import { parseEnvironmentVariableForm } from "~/v3/environmentVariables/forms";
import {
  BookOpenIcon,
  InformationCircleIcon,
  LockClosedIcon,
  MinusCircleIcon,
  NoSymbolIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import {
  Form,
  Outlet,
  useActionData,
  useFetcher,
  useLocation,
  useNavigate,
  useNavigation,
  useRevalidator,
} from "@remix-run/react";
import { json } from "@remix-run/server-runtime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { matchSorter } from "match-sorter";
import { fromPromise } from "neverthrow";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { UserAvatar } from "~/components/UserProfilePhoto";
import {
  EnvironmentCombo,
  EnvironmentIcon,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import { VercelLogo } from "~/components/integrations/VercelLogo";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { DialogClose } from "@radix-ui/react-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { redirectWithSuccessMessage } from "~/models/message.server";
import {
  EnvironmentVariablesPresenter,
  type EnvironmentVariableWithSetValues,
} from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { type EnvironmentVariablesEnvironment } from "~/presenters/v3/environmentVariablesEnvironments.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  docsPath,
  v3EnvironmentVariablesPath,
  v3NewEnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import {
  ALL_BRANCHES,
  availableEnvironmentVariablesFilters,
  environmentTypeForFilter,
  listViewSearch,
  parseEnvironmentVariablesFilter,
  type EnvironmentVariablesFilter,
} from "~/v3/environmentVariables/environmentFilter";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { findUnauthorizedEnvironmentId } from "~/v3/writableEnvironments";
import {
  DeleteEnvironmentVariableValue,
  EditEnvironmentVariableValue,
} from "~/v3/environmentVariables/repository";
import {
  isPullEnvVarsEnabledForEnvironment,
  shouldSyncEnvVar,
  type TriggerEnvironmentType,
} from "~/v3/vercel/vercelProjectIntegrationSchema";
import { sectionAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { WhenAgentUnavailable } from "~/components/dashboard-agent/WhenAgentUnavailable";
import type { Handle } from "~/utils/handle";

export const handle: Handle = {
  agentPageContext: () => sectionAgentPageContext("envvars"),
};
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("Environment variables");

type PageVercelIntegration = NonNullable<
  Awaited<ReturnType<EnvironmentVariablesPresenter["call"]>>["vercelIntegration"]
>;

// A value the current role can't read for its environment tier is masked
// server-side: the value is withheld and the cell renders "Permission denied".
export type MaskedEnvironmentVariable = EnvironmentVariableWithSetValues & {
  permissionDenied?: boolean;
};

export type EnvironmentVariablesPageLoaderData = {
  allowEmptyEnvironmentVariableValues: boolean;
  environmentVariables: MaskedEnvironmentVariable[];
  environments: EnvironmentVariablesEnvironment[];
  // The environment filter in effect, and the environments it lists.
  filter: EnvironmentVariablesFilter;
  filterEnvironmentIds: string[];
  // The preview branches the list is narrowed to. Empty when it lists every branch.
  filterBranchEnvironmentIds: string[];
  // True when no listed environment has a variable, whatever the filter is.
  projectHasNoVariables: boolean;
  hasStaging: boolean;
  vercelIntegration: PageVercelIntegration | null;
  // Environment ids whose env vars the current role can read.
  accessibleEnvironmentIds: string[];
  // Environment ids whose env vars the current role can write (create/edit/delete).
  writableEnvironmentIds: string[];
  pagination: { currentPage: number; totalPages: number; totalCount: number };
  search?: string;
};

export const environmentVariablesRouteId =
  "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables";

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    searchParams: z.object({
      page: z.coerce.number().int().min(1).catch(1),
      search: z.string().trim().min(1).optional().catch(undefined),
      // dev | stg | prod | preview | all. Anything else is treated as absent, which means the
      // type of the environment in the URL.
      env: z.string().optional().catch(undefined),
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
        accessible.has(variable.environment.id)
          ? variable
          : {
              ...variable,
              value: "",
              isSecret: false,
              permissionDenied: true,
              lastUpdatedBy: null,
              updatedByUser: null,
            }
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

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), ...EditEnvironmentVariableValue.shape }),
  z.object({
    action: z.literal("delete"),
    key: z.string(),
    ...DeleteEnvironmentVariableValue.shape,
  }),
  z.object({
    action: z.literal("update-vercel-sync"),
    key: z.string(),
    environmentType: z.enum(["PRODUCTION", "STAGING", "PREVIEW", "DEVELOPMENT"]),
    syncEnabled: z
      .union([z.literal("true"), z.literal("false")])
      .transform((val) => val === "true"),
  }),
]);

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
    const targetEnvType =
      submission.value.action === "update-vercel-sync"
        ? submission.value.environmentType
        : (
            await prisma.runtimeEnvironment.findFirst({
              where: { id: submission.value.environmentId, projectId },
              select: { type: true },
            })
          )?.type;
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
    if (submission.value.action === "edit" || submission.value.action === "delete") {
      const submittedEnvs = await prisma.runtimeEnvironment.findMany({
        where: { projectId, id: submission.value.environmentId },
        select: { id: true, type: true, orgMember: { select: { userId: true } } },
      });
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

        // Stay on the view the delete was made from.
        return redirectWithSuccessMessage(
          `${v3EnvironmentVariablesPath(
            { slug: organizationSlug },
            { slug: projectParam },
            { slug: envParam }
          )}${listViewSearch(request.url)}`,
          request,
          `Deleted ${submission.value.key} environment variable`
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
    projectHasNoVariables,
    vercelIntegration,
    pagination,
    search,
  } = loaderData;
  const hasSearch = Boolean(search);
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  const navigate = useNavigate();
  const { value: searchParamValue, values: searchParamValues } = useSearchParams();
  const filteredItems = environmentVariables;

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
  const newVariablePath = `${v3NewEnvironmentVariablesPath(organization, project, environment)}${location.search}`;

  // The same list for every environment. Keeps the search, starts at the first page.
  const allEnvironmentsSearchParams = new URLSearchParams(location.search);
  allEnvironmentsSearchParams.set("env", "all");
  allEnvironmentsSearchParams.delete("page");
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
      };
    });
  }, [filteredItems]);

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
        <div className={cn("flex h-full min-h-0 flex-col")}>
          <div className="flex items-center justify-between gap-2 px-2 py-2">
            <div className="flex items-center gap-1.5">
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
            <div className="flex items-center justify-end gap-1.5">
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
                shortcut={{ key: "n" }}
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
                  <TableHeaderCell className={vercelIntegration?.enabled ? "w-[22%]" : "w-[25%]"}>
                    Key
                  </TableHeaderCell>
                  <TableHeaderCell className={vercelIntegration?.enabled ? "w-[32%]" : "w-[37%]"}>
                    Value
                  </TableHeaderCell>
                  <TableHeaderCell className={vercelIntegration?.enabled ? "w-[13%]" : "w-[15%]"}>
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
                  <TableHeaderCell className={vercelIntegration?.enabled ? "w-[24%]" : "w-[22%]"}>
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
                              shortcut={{ key: "n" }}
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
      </PageBody>
      <Outlet />
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

  return (
    <TableRow className={variable.isLastTime ? "after:bg-surface-control" : "after:bg-transparent"}>
      <TableCell className={cellClassName}>
        {variable.isFirstTime ? <CopyableText value={variable.key} className="font-mono" /> : null}
      </TableCell>
      <TableCell className={cn(cellClassName, borderedCellClassName, "after:left-3")}>
        {variable.permissionDenied ? (
          <SimpleTooltip
            button={
              <div className="flex items-center gap-x-1">
                <NoSymbolIcon className="size-3 text-text-dimmed" />
                <span className="text-xs text-text-dimmed">Permission denied</span>
              </div>
            }
            content="With your current role, you can't view this environment's variables."
          />
        ) : variable.valueUnavailable ? (
          <span className="text-xs text-text-dimmed">Encryption key unavailable</span>
        ) : variable.isSecret ? (
          <SimpleTooltip
            button={
              <div className="flex items-center gap-x-1">
                <LockClosedIcon className="size-3 text-text-dimmed" />
                <span className="text-xs text-text-dimmed">Secret</span>
              </div>
            }
            content="This variable is secret and cannot be revealed."
          />
        ) : variable.value === "" ? (
          <SimpleTooltip
            button={
              <div className="flex items-center gap-x-1">
                <MinusCircleIcon className="size-3 text-text-dimmed" />
                <span className="text-xs text-text-dimmed">Empty</span>
              </div>
            }
            content="This variable is set to an empty string."
          />
        ) : (
          <ClipboardField
            secure={!revealAll}
            value={variable.value}
            variant={"secondary/small"}
            fullWidth={true}
          />
        )}
      </TableCell>

      <TableCell className={cn(cellClassName, borderedCellClassName)}>
        <EnvironmentCombo environment={variable.environment} className="text-sm" />
      </TableCell>
      {vercelIntegration?.enabled && (
        <TableCell className={cn(cellClassName, borderedCellClassName)}>
          {variable.environment.type !== "DEVELOPMENT" && (
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
          )}
        </TableCell>
      )}
      <TableCell className={cn(cellClassName, borderedCellClassName)}>
        <div className="flex items-center gap-3">
          {variable.updatedAt ? (
            <span className="shrink-0 text-sm tabular-nums text-text-dimmed">
              <DateTime date={variable.updatedAt} includeSeconds={false} />
            </span>
          ) : null}
          {variable.updatedByUser ? (
            <div className="flex min-w-0 items-center gap-2">
              <UserAvatar
                avatarUrl={variable.updatedByUser.avatarUrl}
                name={variable.updatedByUser.name}
                className="size-5 shrink-0"
              />
              <span className="truncate text-sm">{variable.updatedByUser.name}</span>
            </div>
          ) : variable.lastUpdatedBy?.type === "integration" &&
            variable.lastUpdatedBy?.integration === "vercel" ? (
            <div className="flex min-w-0 items-center gap-2">
              <VercelLogo className="size-4 shrink-0 text-text-dimmed transition-colors group-hover/table-row:text-text-bright" />
              <span className="truncate text-sm capitalize text-text-dimmed transition-colors group-hover/table-row:text-text-bright">
                {variable.lastUpdatedBy.integration}
              </span>
            </div>
          ) : null}
        </div>
      </TableCell>
      <TableCellMenu
        isSticky
        className="[&:has([data-hidden-buttons])]:w-auto w-0"
        hiddenButtons={
          // No edit/delete for environments the role can't manage — the value
          // is withheld, and the action enforces write:envvars independently.
          variable.permissionDenied ? undefined : (
            <>
              <EditEnvironmentVariablePanel variable={variable} revealAll={revealAll} />
              <DeleteEnvironmentVariableButton variable={variable} />
            </>
          )
        }
      />
    </TableRow>
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

function EditEnvironmentVariablePanel({
  variable,
  revealAll,
}: {
  variable: EnvironmentVariableWithSetValues;
  revealAll: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const { allowEmptyEnvironmentVariableValues } =
    useTypedLoaderData<EnvironmentVariablesPageLoaderData>();
  const [emptyValueSelected, setEmptyValueSelected] = useState(false);
  const [draftValue, setDraftValue] = useState(variable.value);
  const fetcher = useFetcher<typeof action>();
  const lastSubmission = fetcher.data as any;

  const isLoading = fetcher.state !== "idle";

  // Close dialog on successful submission
  useEffect(() => {
    if (lastSubmission?.success && fetcher.state === "idle") {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setIsOpen(false);
    }
  }, [lastSubmission?.success, fetcher.state]);

  const [form, { id, environmentId, value }] = useForm({
    id: `edit-environment-variable-${variable.id}-${variable.environment.id}`,
    // TODO: type this
    lastResult: lastSubmission as any,
    onValidate({ formData }) {
      return parseEnvironmentVariableForm(formData, schema, allowEmptyEnvironmentVariableValues);
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) {
          setEmptyValueSelected(false);
          setDraftValue(variable.value);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="small-menu-item" LeadingIcon={PencilSquareIcon} fullWidth textAlignLeft />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>Edit environment variable</DialogHeader>
        <fetcher.Form method="post" {...getFormProps(form)}>
          <input type="hidden" name="action" value="edit" />
          <input {...getInputProps(id, { type: "hidden" })} value={variable.id} />
          <input
            {...getInputProps(environmentId, { type: "hidden" })}
            value={variable.environment.id}
          />
          <FormError id={id.errorId}>{id.errors}</FormError>
          <FormError id={environmentId.errorId}>{environmentId.errors}</FormError>
          <Fieldset>
            <InputGroup fullWidth className="mt-2 gap-0">
              <Label>Key</Label>
              <CopyableText value={variable.key} className="w-fit font-mono text-sm" />
            </InputGroup>

            <InputGroup fullWidth>
              <Label>Environment</Label>
              <EnvironmentCombo environment={variable.environment} className="text-sm" />
            </InputGroup>

            <InputGroup fullWidth>
              <Label>Value</Label>
              <Input
                {...getInputProps(value, { type: "text", value: false })}
                placeholder={variable.isSecret ? "Set new secret value" : "Not set"}
                value={emptyValueSelected ? "" : draftValue}
                onChange={(event) => setDraftValue(event.currentTarget.value)}
                disabled={emptyValueSelected}
                type={"text"}
                autoComplete="off"
              />
              {emptyValueSelected && <input type="hidden" name={value.name} value="" />}
              <FormError id={value.errorId}>{value.errors}</FormError>
              {variable.isSecret && allowEmptyEnvironmentVariableValues && (
                <CheckboxWithLabel
                  name="setEmptyValue"
                  value="true"
                  variant="description"
                  label="Set to an empty string"
                  description="Replaces the secret with an empty string and keeps the variable."
                  onChange={setEmptyValueSelected}
                />
              )}
            </InputGroup>

            <FormError>{form.errors}</FormError>

            <FormButtons
              confirmButton={
                <Button type="submit" variant="primary/medium" disabled={isLoading}>
                  {isLoading ? "Saving…" : "Save"}
                </Button>
              }
              cancelButton={
                <Button onClick={() => setIsOpen(false)} variant="tertiary/medium" type="button">
                  Cancel
                </Button>
              }
            />
          </Fieldset>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteEnvironmentVariableButton({
  variable,
}: {
  variable: EnvironmentVariableWithSetValues;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const lastSubmission = useActionData();
  const navigation = useNavigation();
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "delete" &&
    navigation.formData?.get("id") === variable.id &&
    navigation.formData?.get("environmentId") === variable.environment.id;

  const [form] = useForm({
    id: `delete-environment-variable-${variable.id}-${variable.environment.id}`,
    // TODO: type this
    lastResult: lastSubmission as any,
    onValidate({ formData }) {
      return parseEnvironmentVariableForm(formData, schema);
    },
    shouldRevalidate: "onSubmit",
  });

  // The action data is shared by every row, so only show errors from a
  // submission for this variable and environment.
  const submittedValues = (lastSubmission as any)?.initialValue;
  const isLastSubmissionForThisRow =
    submittedValues?.id === variable.id &&
    submittedValues?.environmentId === variable.environment.id;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          variant="small-menu-item"
          fullWidth
          textAlignLeft
          LeadingIcon={TrashIcon}
          leadingIconClassName="text-rose-500 group-hover/button:text-white dark:group-hover/button:text-text-bright transition-colors"
          className="ml-0.5 transition-colors group-hover/button:bg-error"
        />
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        // Start on Delete, so Enter confirms. Enter on Cancel or the close button does what that
        // button says, because the shortcut below only labels the key and never fires by itself.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          deleteButtonRef.current?.focus();
        }}
      >
        <DialogHeader>Delete environment variable</DialogHeader>
        <div className="mb-2 mt-4 flex flex-col gap-3">
          <Paragraph>
            Are you sure you want to delete <strong className="font-mono">{variable.key}</strong>{" "}
            from this environment? This can't be undone.
          </Paragraph>
          <EnvironmentCombo environment={variable.environment} className="text-sm" />
          {isLastSubmissionForThisRow && <FormError>{form.errors}</FormError>}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary/medium">Cancel</Button>
          </DialogClose>
          <Form method="post" {...getFormProps(form)}>
            <input type="hidden" name="id" value={variable.id} />
            <input type="hidden" name="key" value={variable.key} />
            <input type="hidden" name="environmentId" value={variable.environment.id} />
            <Button
              ref={deleteButtonRef}
              name="action"
              value="delete"
              type="submit"
              variant="danger/medium"
              LeadingIcon={TrashIcon}
              disabled={isLoading}
              shortcut={{ key: "enter", enabled: false }}
            >
              {isLoading ? "Deleting…" : "Delete"}
            </Button>
          </Form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
