import {
  ArrowsRightLeftIcon,
  DocumentDuplicateIcon,
  LockClosedIcon,
} from "@heroicons/react/20/solid";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  type ShouldRevalidateFunction,
} from "@remix-run/react";
import { json, redirect } from "@remix-run/server-runtime";
import { matchSorter } from "match-sorter";
import { useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { env } from "~/env.server";
import { z } from "zod";
import {
  EnvironmentCombo,
  EnvironmentIcon,
  environmentFullTitle,
} from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import { Header2 } from "~/components/primitives/Headers";
import {
  SelectedItemsProvider,
  useSelectedItems,
  useTickedBeforeHydration,
} from "~/components/primitives/SelectedItemsProvider";
import {
  SelectionBar,
  tickCellClassName,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/SelectionBar";
import { CopyKeyButton } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/CopyKeyButton";
import { CopyValuesDialog } from "./CopyValues";
import { type CompareKindOption, CompareToolbar } from "./CompareToolbar";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
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
import { Select, SelectItem } from "~/components/primitives/Select";
import { Switch } from "~/components/primitives/Switch";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  EnvironmentVariablesComparePresenter,
  type EnvironmentVariablesCompareSide,
  type EnvironmentVariablesComparison,
} from "~/presenters/v3/EnvironmentVariablesComparePresenter.server";
import type { EnvironmentVariablesEnvironment } from "~/presenters/v3/environmentVariablesEnvironments.server";
import { EnvironmentVariableValue } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/EnvironmentVariableControls";
import type { EnvironmentVariablesOutletContext } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { recordDashboardEnvironmentVariablesListed } from "~/services/auditLogs/envVarReadAudit.server";
import { requireRecentMfa } from "~/services/mfa/mfaPolicy.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { parseWithZod } from "~/utils/conform";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  COPY_ENVIRONMENT_VARIABLE_VALUES_LIMIT,
  CopyEnvironmentVariableValues,
} from "~/v3/environmentVariables/repository";
import { findTargetEnvironments } from "~/v3/environmentVariables/targetEnvironments.server";
import { findCopyRefusal } from "~/v3/writableEnvironments";
import { cn } from "~/utils/cn";
import { pageMeta } from "~/utils/pageTitle";
import {
  EnvironmentParamSchema,
  v3EnvironmentVariablesComparePath,
  v3EnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import {
  COMPARE_KIND_PARAM,
  COMPARE_LEFT_PARAM,
  COMPARE_RIGHT_PARAM,
  canCopyFrom,
  canTickCompareRows,
  compareSideEnvironments,
  compareCopyPlan,
  compareSideValue,
  compareViewSearch,
  COMPARE_KEY_PARAM,
  parseCompareSelectedKeys,
  copyEmptySkippedSentence,
  copySkipReason,
  copySkippedSentence,
  type CompareCopyPlan,
  type CompareSideName,
  parseCompareKind,
  type CompareCell,
  type CompareKind,
  type CompareRow,
} from "~/v3/environmentVariables/compare";
import { keyPanelEnvironments } from "~/v3/environmentVariables/environmentVariableKey";
import { attentionReturnPath } from "~/v3/environmentVariables/attention";

export const meta = pageMeta(["Compare", "Environment variables"]);

// The key panel keeps its own search params next to the comparison's. A navigation that changes
// only those, on the same project and environment, leaves the comparison as it is, so don't
// read both sides again. Anything after a form submission still revalidates.
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
    currentParams.organizationSlug === nextParams.organizationSlug &&
    currentParams.projectParam === nextParams.projectParam &&
    currentParams.envParam === nextParams.envParam &&
    currentUrl.search !== nextUrl.search &&
    compareViewSearch(currentUrl) === compareViewSearch(nextUrl)
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
      // dev | stg | prod | preview | branch:<name>. Anything else falls back: the left to the
      // environment in the URL, the right to Prod (Staging when the left is Prod).
      [COMPARE_LEFT_PARAM]: z.string().optional().catch(undefined),
      [COMPARE_RIGHT_PARAM]: z.string().optional().catch(undefined),
      // different | left | right | empty | same. Anything else lists every key but the same ones.
      [COMPARE_KIND_PARAM]: z.string().optional().catch(undefined),
    }),
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    // No hard authorization, as on the list: a side the role can't read is never read, and its
    // cells say Permission denied.
  },
  async ({ params, searchParams, user, ability, context, request }) => {
    const { projectId } = context;
    if (!projectId) {
      throw new Response("Not Found", { status: 404 });
    }
    await requireRecentMfa(request, {
      userId: user.id,
      action: "environmentVariables",
      organizationId: context.organizationId,
    });

    try {
      const comparison = await new EnvironmentVariablesComparePresenter().call({
        userId: user.id,
        projectId,
        left: searchParams[COMPARE_LEFT_PARAM],
        right: searchParams[COMPARE_RIGHT_PARAM],
        currentEnvironmentSlug: params.envParam,
        canRead: (envType) => ability.can("read", { type: "envvars", envType }),
        canWrite: (envType) => ability.can("write", { type: "envvars", envType }),
        kind: parseCompareKind(searchParams[COMPARE_KIND_PARAM]),
        search: searchParams.search,
        // Repeated `key` params: compare only those keys (malformed ones dropped, at most 100).
        selectedKeys: parseCompareSelectedKeys(
          new URL(request.url).searchParams.getAll(COMPARE_KEY_PARAM)
        ),
        page: searchParams.page,
        maxKeys: env.ENVIRONMENT_VARIABLES_COMPARE_MAX_KEYS,
      });

      // Nothing to compare with one environment: back to the list.
      if (!comparison) {
        return redirect(
          v3EnvironmentVariablesPath(
            { slug: params.organizationSlug },
            { slug: params.projectParam },
            { slug: params.envParam }
          )
        );
      }

      // The page sends both sides' values on load, as the list does, so a load is a listing of each
      // side whose values it sent. A side the role can't read only has Permission denied cells.
      if (context.organizationId) {
        const sent = (side: "left" | "right") =>
          comparison.rows.some((row) => row[side].isSet && !row[side].permissionDenied);
        recordDashboardEnvironmentVariablesListed({
          organizationId: context.organizationId,
          projectId,
          environments: [comparison.left.environment, comparison.right.environment],
          readEnvironmentIds: [
            ...(sent("left") ? [comparison.left.environment.id] : []),
            ...(sent("right") ? [comparison.right.environment.id] : []),
          ],
        });
      }

      return typedjson(comparison);
    } catch (error) {
      console.error(error);
      throw new Response(undefined, {
        status: 400,
        statusText: "Something went wrong, if this problem persists please contact support.",
      });
    }
  }
);

const CopyValuesFormSchema = z.object({
  action: z.literal("copy-values"),
  sourceEnvironmentId: z.string(),
  targetEnvironmentId: z.string(),
  variableIds: CopyEnvironmentVariableValues.shape.variableIds,
  // The key open in the panel, kept open after the copy.
  panelKey: z.string().optional(),
});

/**
 * Copies the values of the ticked keys from one side to the other. Nothing about a value comes
 * from the page: the server reads the source. Both environments are checked before anything is
 * written, and one refused key refuses the whole copy.
 */
export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    // Read and write access are checked in the handler: the environments come from the submission.
  },
  async ({ request, params, user, ability, context }) => {
    const { projectId } = context;
    if (!projectId) {
      throw new Response("Not Found", { status: 404 });
    }
    await requireRecentMfa(request, {
      userId: user.id,
      action: "environmentVariables",
      organizationId: context.organizationId,
    });
    if (request.method.toUpperCase() !== "POST") {
      throw new Response("Method Not Allowed", { status: 405 });
    }

    const submission = parseWithZod(await request.formData(), { schema: CopyValuesFormSchema });
    if (submission.status !== "success") {
      return json(submission.reply());
    }
    const { sourceEnvironmentId, targetEnvironmentId, variableIds, panelKey } = submission.value;

    const environments = await findTargetEnvironments(prisma, projectId, [
      sourceEnvironmentId,
      targetEnvironmentId,
    ]);
    const refusal = findCopyRefusal(environments, {
      sourceEnvironmentId,
      targetEnvironmentId,
      userId: user.id,
      canReadType: (envType) => ability.can("read", { type: "envvars", envType }),
      canWriteType: (envType) => ability.can("write", { type: "envvars", envType }),
      title: sideLabel,
    });
    if (refusal) {
      return json(submission.reply({ formErrors: [refusal] }));
    }

    const result = await new EnvironmentVariablesRepository(prisma).copyValues(projectId, {
      sourceEnvironmentId,
      targetEnvironmentId,
      variableIds,
      lastUpdatedBy: { type: "user", userId: user.id },
    });
    if (!result.success) {
      return json(submission.reply({ formErrors: [result.error] }));
    }

    // The same comparison, tab, search and page, with the key panel still open if it was.
    const comparePath = v3EnvironmentVariablesComparePath(
      { slug: params.organizationSlug },
      { slug: params.projectParam },
      { slug: params.envParam }
    );
    const target = environments.find((environment) => environment.id === targetEnvironmentId)!;
    const count = result.copied.length;
    return redirectWithSuccessMessage(
      // Posted from the needs attention page: back to it.
      attentionReturnPath(request.url, params, panelKey) ??
        `${comparePath}${panelKey ? `/key/${encodeURIComponent(panelKey)}` : ""}${compareViewSearch(request.url)}`,
      request,
      `Copied ${count} ${count === 1 ? "value" : "values"} to ${sideLabel(target)}`
    );
  }
);

// The segmented control's value for every key but the same ones. Not a kind.
const ALL_KINDS_VALUE = "all";

// The header checkbox's value, for ticks made before the page hydrated.
const SELECT_ALL_VALUE = "all";

export default function Page() {
  return (
    // The cap is the most one copy takes, so the selection can never ask for more.
    <SelectedItemsProvider
      initialSelectedItems={[]}
      maxSelectedItemCount={COPY_ENVIRONMENT_VARIABLE_VALUES_LIMIT}
    >
      <ComparePage />
    </SelectedItemsProvider>
  );
}

function ComparePage() {
  const {
    environments,
    left,
    right,
    counts,
    mixedSecretCount,
    inheritedCount,
    rows,
    search,
    selectedKeyCount,
    pagination,
    emptyValuesAllowed,
    tooManyKeys,
  } = useTypedLoaderData<EnvironmentVariablesComparison>();
  const [revealAll, setRevealAll] = useState(false);
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  const navigate = useNavigate();
  const { keyParam } = useParams();
  const isShowingKeyPanel = keyParam !== undefined;

  const comparePath = v3EnvironmentVariablesComparePath(organization, project, environment);
  const viewSearch = compareViewSearch(new URLSearchParams(location.search));
  // Read from the URL, so the controls move on click while the next comparison loads.
  const urlParams = new URLSearchParams(location.search);
  const selectedKind = parseCompareKind(urlParams.get(COMPARE_KIND_PARAM));

  // Another view of the comparison: starts at the first page, and keeps the key panel open.
  const viewPath = (values: Record<string, string | undefined>) => {
    const params = new URLSearchParams(location.search);
    params.delete("page");
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) {
        params.delete(name);
      } else {
        params.set(name, value);
      }
    }
    return `${location.pathname}?${params.toString()}`;
  };

  // The same keys with the columns the other way round, so "missing in" follows its side.
  const swapPath = viewPath({
    [COMPARE_LEFT_PARAM]: right.value,
    [COMPARE_RIGHT_PARAM]: left.value,
    [COMPARE_KIND_PARAM]:
      selectedKind === "left" ? "right" : selectedKind === "right" ? "left" : selectedKind,
    page: urlParams.get("page") ?? undefined,
  });

  const sideEnvironments = [
    ...keyPanelEnvironments(environments),
    ...compareSideEnvironments(environments).filter((env) => env.parentEnvironmentId !== null),
  ];
  const pickSide = (param: string, other: EnvironmentVariablesCompareSide, id: string) => {
    const picked = sideEnvironments.find((env) => env.id === id);
    if (!picked) {
      return;
    }
    // Picking the other side's environment swaps the two.
    navigate(
      picked.id === other.environment.id
        ? swapPath
        : viewPath({ [param]: compareSideValue(picked) })
    );
  };

  // Back to the list, with the filter it had when the comparison was opened.
  const listFilter = new URLSearchParams();
  for (const name of ["env", "branch"]) {
    for (const value of urlParams.getAll(name)) {
      listFilter.append(name, value);
    }
  }
  const listFilterSearch = listFilter.toString();
  const listPath = `${v3EnvironmentVariablesPath(organization, project, environment)}${
    listFilterSearch ? `?${listFilterSearch}` : ""
  }`;

  const leftLabel = sideLabel(left.environment);
  const rightLabel = sideLabel(right.environment);
  const differences = counts.different + counts.left + counts.right + counts.empty;
  const total = differences + counts.same + counts.uncompared + counts.unset;
  // A side's icon tells it apart unless both are Preview (two branches, or a branch and the base).
  const iconsDiffer = left.environment.type !== right.environment.type;
  const missingOption = (value: "left" | "right", count: number): CompareKindOption => {
    // "left" lists the keys only the left side has: missing on the right.
    const missingSide = value === "left" ? right : left;
    return {
      value,
      label: iconsDiffer ? (
        <>
          Missing
          <EnvironmentIcon environment={missingSide.environment} className="size-4 shrink-0" />
        </>
      ) : (
        `Missing ${value === "left" ? "right" : "left"}`
      ),
      title: `Missing in ${environmentFullTitle(missingSide.environment)}`,
      count: tooManyKeys ? undefined : count,
    };
  };
  const bothSides = `${environmentFullTitle(left.environment)} and ${environmentFullTitle(right.environment)}`;
  const kindOptions: CompareKindOption[] = [
    {
      value: ALL_KINDS_VALUE,
      label: "All",
      title: "Every key that differs",
      count: tooManyKeys ? undefined : differences + counts.uncompared + counts.unset,
    },
    {
      value: "different",
      label: "Different",
      title: `Different in ${bothSides}`,
      count: tooManyKeys ? undefined : counts.different,
    },
    missingOption("left", counts.left),
    missingOption("right", counts.right),
    {
      value: "empty",
      label: "Empty",
      title: "Empty on one side",
      count: tooManyKeys ? undefined : counts.empty,
    },
    {
      value: "same",
      label: "Same",
      title: `Same in ${bothSides}`,
      count: tooManyKeys ? undefined : counts.same,
    },
  ];

  const branchSides = [left, right].filter((side) => side.environment.parentEnvironmentId !== null);
  const deniedSides = [left, right].filter((side) => !side.isReadable);

  // The selection is this page's rows only. A row's id is its variable's.
  const { selectedItems, has, select, deselect, toggle, deselectAll } = useSelectedItems();
  const rowIds = rows.map((row) => row.id);
  const selectedRows = rows.filter((row) => has(row.id));
  const isEverySelected = selectedRows.length > 0 && selectedRows.length === rows.length;
  const isSelectionFull =
    selectedRows.length >= Math.min(rows.length, COPY_ENVIRONMENT_VARIABLE_VALUES_LIMIT);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [copyPlan, setCopyPlan] = useState<CompareCopyPlan | undefined>(undefined);

  // When the bar or the dialog goes away under the keyboard focus: the header's box.
  const focusListStart = useCallback(() => {
    const list = tableScrollRef.current;
    const target =
      list?.querySelector<HTMLElement>(`input[value="${SELECT_ALL_VALUE}"]`) ??
      list?.querySelector<HTMLElement>("a[href], button:not([disabled]), input:not([disabled])");
    target?.focus();
  }, []);

  const lastToggledRef = useRef<string | null>(null);
  const toggleRow = (id: string, shiftKey: boolean) => {
    const from = lastToggledRef.current ? rowIds.indexOf(lastToggledRef.current) : -1;
    const to = rowIds.indexOf(id);
    lastToggledRef.current = id;
    if (shiftKey && from !== -1 && to !== -1 && from !== to) {
      const range = rowIds.slice(Math.min(from, to), Math.max(from, to) + 1);
      // The range takes the state the clicked row is moving to.
      if (has(id)) {
        deselect(range);
      } else {
        select(range);
      }
      return;
    }
    toggle(id);
  };

  // A ticked row that left the page (copied into Same, or deleted elsewhere) is unticked.
  const rowKey = rowIds.join(" ");
  useEffect(() => {
    const listed = new Set(rowKey.split(" "));
    const gone = [...selectedItems].filter((id) => !listed.has(id));
    if (gone.length > 0) {
      deselect(gone);
    }
  }, [rowKey, selectedItems, deselect]);

  // Ticks made before the page hydrated: select them (the header's box stands for every row).
  useTickedBeforeHydration(tableScrollRef, (values) =>
    select(values.includes(SELECT_ALL_VALUE) ? rowIds : values)
  );

  // Another comparison, tab, search or page: start with nothing ticked. Not on mount.
  const clearedViewRef = useRef(viewSearch);
  useEffect(() => {
    if (clearedViewRef.current === viewSearch) {
      return;
    }
    clearedViewRef.current = viewSearch;
    deselectAll();
  }, [viewSearch, deselectAll]);

  const sides = { left, right };
  const labels = { left: leftLabel, right: rightLabel };
  // Why values can't be copied from one side to the other, whichever rows are ticked.
  const copyBlocked = (from: CompareSideName): string | undefined => {
    if (canCopyFrom(sides, from)) {
      return undefined;
    }
    return sides[from].isReadable
      ? `You don't have permission to change environment variables in ${labels[from === "left" ? "right" : "left"]}.`
      : `You don't have permission to view environment variables in ${labels[from]}.`;
  };
  // Checkboxes only where ticking can lead to a copy.
  const canTick = !tooManyKeys && canTickCompareRows(sides, selectedKind);
  const copyAction = (from: CompareSideName) => {
    const to = from === "left" ? "right" : "left";
    const plan = compareCopyPlan(selectedRows, from, emptyValuesAllowed);
    const blocked = copyBlocked(from);
    return {
      label: `Copy to ${labels[to]}`,
      icon: DocumentDuplicateIcon,
      variant: "secondary/small" as const,
      onClick: () => setCopyPlan(plan),
      disabled: blocked !== undefined || plan.copied.length === 0,
      // Every ticked row is skipped here: the same reasons the dialog would give.
      disabledReason:
        blocked ??
        ([
          copySkippedSentence(plan.skipped, labels[from], labels[to]),
          copyEmptySkippedSentence(plan.skipped.empty),
        ]
          .filter((sentence) => sentence !== undefined)
          .join(" ") ||
          `None of the selected keys has a value in ${labels[from]} that differs from ${labels[to]}.`),
    };
  };

  const leftPicker = (
    <SidePicker
      label="Left side"
      side={left}
      environments={sideEnvironments}
      onPick={(id) => pickSide(COMPARE_LEFT_PARAM, right, id)}
    />
  );
  const rightPicker = (
    <SidePicker
      label="Right side"
      side={right}
      environments={sideEnvironments}
      onPick={(id) => pickSide(COMPARE_RIGHT_PARAM, left, id)}
    />
  );
  const swapButton = (
    <LinkButton
      to={swapPath}
      variant="minimal/small"
      LeadingIcon={ArrowsRightLeftIcon}
      aria-label="Swap sides"
      tooltip="Swap sides"
    />
  );

  const outletContext: EnvironmentVariablesOutletContext = {
    revealAll,
    compare: { closePath: `${comparePath}${viewSearch}` },
  };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Compare" backButton={{ to: listPath, text: "Environment variables" }} />
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="environment-variables-compare-main" min={"100px"}>
            <div className="flex h-full min-h-0 flex-col">
              <CompareToolbar
                search={
                  <SearchInput
                    placeholder={
                      search
                        ? "Search variables…"
                        : tooManyKeys
                          ? `Search ${formatCount(tooManyKeys.count)} keys…`
                          : `Search ${total} ${total === 1 ? "key" : "keys"}…`
                    }
                    resetParams={["page"]}
                    shortcut={{ key: "/" }}
                    autoFocus
                  />
                }
                kinds={kindOptions}
                selectedKind={selectedKind ?? ALL_KINDS_VALUE}
                onKindChange={(value) =>
                  navigate(
                    viewPath({
                      [COMPARE_KIND_PARAM]: value === ALL_KINDS_VALUE ? undefined : value,
                    })
                  )
                }
                subset={
                  selectedKeyCount !== undefined && (
                    <AppliedFilter
                      label="Keys"
                      value={`${selectedKeyCount} selected`}
                      removeLabel="Show all keys"
                      onRemove={() => navigate(viewPath({ [COMPARE_KEY_PARAM]: undefined }))}
                    />
                  )
                }
                revealSwitch={
                  <Switch
                    variant="secondary/small"
                    label="Reveal values"
                    checked={revealAll}
                    onCheckedChange={(checked) => setRevealAll(checked)}
                  />
                }
              />
              {(branchSides.length > 0 || deniedSides.length > 0 || counts.uncompared > 0) && (
                <div className="flex flex-col gap-0.5 px-3 pb-2">
                  {branchSides.length > 0 && (
                    <Paragraph variant="extra-small" className="text-text-dimmed">
                      {inheritedCount > 0
                        ? `${sideLabel(branchSides[0]!.environment)} is compared by its own values. The ${inheritedCount} ${
                            inheritedCount === 1 ? "key" : "keys"
                          } it takes from Preview unchanged ${inheritedCount === 1 ? "isn't" : "aren't"} listed.`
                        : `${
                            branchSides.length === 2
                              ? "Each branch"
                              : sideLabel(branchSides[0]!.environment)
                          } is compared by its own values only. A key it takes from Preview shows as Not set.`}
                    </Paragraph>
                  )}
                  {deniedSides.length > 0 ? (
                    <Paragraph variant="extra-small" className="text-text-dimmed">
                      With your current role, you can't view the variables in{" "}
                      {deniedSides.map((side) => sideLabel(side.environment)).join(" or ")}, so keys
                      set on both sides aren't compared.
                    </Paragraph>
                  ) : (
                    <>
                      {mixedSecretCount > 0 && (
                        <Paragraph variant="extra-small" className="text-text-dimmed">
                          {mixedSecretCount} {mixedSecretCount === 1 ? "key isn't" : "keys aren't"}{" "}
                          compared: one side is a secret and the other isn't.
                        </Paragraph>
                      )}
                      {counts.uncompared > mixedSecretCount && (
                        <Paragraph variant="extra-small" className="text-text-dimmed">
                          {counts.uncompared - mixedSecretCount}{" "}
                          {counts.uncompared - mixedSecretCount === 1 ? "key isn't" : "keys aren't"}{" "}
                          compared, because a value couldn't be read.
                        </Paragraph>
                      )}
                    </>
                  )}
                </div>
              )}
              {/* The selection bar floats over the bottom of the table, above the pager. */}
              <div className="relative flex min-h-0 flex-1 flex-col">
                <div
                  ref={tableScrollRef}
                  className={cn(
                    "min-h-0 flex-1 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
                    // Room to scroll the last row out from under the bar.
                    selectedRows.length > 0 && "pb-28"
                  )}
                >
                  <Table
                    containerClassName={cn(rows.length === 0 && "border-t-0", "overflow-visible")}
                  >
                    <TableHeader>
                      <TableRow>
                        {canTick && (
                          <TableHeaderCell className="w-0 pl-3 pr-0">
                            {rows.length > 0 && (
                              <Checkbox
                                aria-label="Select every key on this page"
                                value={SELECT_ALL_VALUE}
                                checked={isEverySelected}
                                ref={(element) => {
                                  if (element) {
                                    element.indeterminate =
                                      selectedRows.length > 0 && !isEverySelected;
                                  }
                                }}
                                onChange={() => {
                                  lastToggledRef.current = null;
                                  if (isSelectionFull) {
                                    deselectAll();
                                  } else {
                                    select(rowIds);
                                  }
                                }}
                              />
                            )}
                          </TableHeaderCell>
                        )}
                        <TableHeaderCell className="w-[30%]">Key</TableHeaderCell>
                        <TableHeaderCell className="w-[35%]">
                          <span className="-my-1 -ml-2 flex items-center gap-1">
                            {leftPicker}
                            {swapButton}
                          </span>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-[35%]">
                          <span className="-my-1 -ml-2 flex">{rightPicker}</span>
                        </TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.length > 0 ? (
                        rows.map((row) => (
                          <CompareTableRow
                            key={row.id}
                            row={row}
                            path={`${comparePath}/key/${encodeURIComponent(row.key)}${viewSearch}`}
                            isSelected={keyParam === row.key}
                            revealAll={revealAll}
                            canTick={canTick}
                            isTicked={has(row.id)}
                            isAnyTicked={selectedRows.length > 0}
                            onToggle={(shiftKey) => toggleRow(row.id, shiftKey)}
                            copyTo={(from) =>
                              copyBlocked(from) === undefined &&
                              copySkipReason(row, from, emptyValuesAllowed) === undefined
                                ? {
                                    label: `Copy to ${labels[from === "left" ? "right" : "left"]}`,
                                    onClick: () =>
                                      setCopyPlan(compareCopyPlan([row], from, emptyValuesAllowed)),
                                  }
                                : undefined
                            }
                          />
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={canTick ? 4 : 3}>
                            <div className="flex flex-col items-center justify-center gap-y-3 py-8">
                              {tooManyKeys ? (
                                <>
                                  <Header2>
                                    {bothSides} have {formatCount(tooManyKeys.count)} keys between
                                    them.
                                  </Header2>
                                  <Paragraph className="max-w-lg text-center">
                                    Up to {formatCount(tooManyKeys.max)} can be compared at once.
                                    Search to narrow them down, or tick keys on the environment
                                    variables list and choose Compare.
                                  </Paragraph>
                                </>
                              ) : total === 0 ? (
                                search ? (
                                  <Paragraph>No keys match your search.</Paragraph>
                                ) : (
                                  <Header2>
                                    {leftLabel} and {rightLabel} have no variables.
                                  </Header2>
                                )
                              ) : selectedKind ? (
                                <Paragraph>
                                  {emptyKindMessage(selectedKind, leftLabel, rightLabel, bothSides)}
                                </Paragraph>
                              ) : (
                                <>
                                  <Header2>
                                    No differences between {leftLabel} and {rightLabel}.
                                  </Header2>
                                  <Paragraph>
                                    {counts.same} {counts.same === 1 ? "key is" : "keys are"} the
                                    same on both sides.
                                  </Paragraph>
                                  <LinkButton
                                    to={viewPath({ [COMPARE_KIND_PARAM]: "same" })}
                                    variant="secondary/small"
                                  >
                                    Show the same keys
                                  </LinkButton>
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                <SelectionBar
                  count={selectedRows.length}
                  label={
                    <>
                      {selectedRows.length} selected
                      {selectedRows.length >= COPY_ENVIRONMENT_VARIABLE_VALUES_LIMIT && (
                        <span className="font-normal text-text-dimmed"> (the most at once)</span>
                      )}
                    </>
                  }
                  onClear={deselectAll}
                  restoreFocus={focusListStart}
                  actions={[copyAction("right"), copyAction("left")]}
                />
                <CopyValuesDialog
                  plan={copyPlan}
                  source={copyPlan?.from === "right" ? right : left}
                  target={copyPlan?.from === "right" ? left : right}
                  setPlan={setCopyPlan}
                  restoreFocus={focusListStart}
                />
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
            id="environment-variables-compare-handle"
            className={collapsibleHandleClassName(isShowingKeyPanel)}
          />
          <ResizablePanel
            id="environment-variables-compare-key"
            min="420px"
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
    </PageContainer>
  );
}

/** A side's short name, as the list's filter names its environments. Only a branch has a name. */
function sideLabel(
  environment: Pick<EnvironmentVariablesEnvironment, "type" | "branchName">
): string {
  if (environment.branchName) {
    return environment.branchName;
  }
  switch (environment.type) {
    case "DEVELOPMENT":
      return "Dev";
    case "STAGING":
      return "Staging";
    case "PREVIEW":
      return "Preview";
    case "PRODUCTION":
      return "Prod";
  }
}

function emptyKindMessage(
  kind: CompareKind,
  leftLabel: string,
  rightLabel: string,
  bothSides: string
): string {
  switch (kind) {
    case "different":
      return `No keys have different values in ${leftLabel} and ${rightLabel}.`;
    case "left":
      return `No keys are missing in ${rightLabel}.`;
    case "right":
      return `No keys are missing in ${leftLabel}.`;
    case "empty":
      return "No keys are empty on one side.";
    case "same":
      return `No keys have the same value in ${bothSides}.`;
  }
}

/** An environment as a side: the Preview environment itself is the base its branches inherit. */
function SideCombo({ environment }: { environment: EnvironmentVariablesEnvironment }) {
  const isPreviewBase = environment.type === "PREVIEW" && environment.parentEnvironmentId === null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <EnvironmentCombo
        environment={isPreviewBase ? { type: "PREVIEW", branchName: null } : environment}
        className="text-sm"
      />
      {isPreviewBase && <span className="font-normal text-text-dimmed">base</span>}
    </span>
  );
}

function SidePicker({
  label,
  side,
  environments,
  onPick,
}: {
  label: string;
  side: EnvironmentVariablesCompareSide;
  environments: EnvironmentVariablesEnvironment[];
  onPick: (environmentId: string) => void;
}) {
  return (
    <Select<string, EnvironmentVariablesEnvironment>
      aria-label={label}
      variant="minimal/small"
      value={side.environment.id}
      setValue={onPick}
      items={environments}
      className="w-fit"
      filter={{
        // As the list's branch picker: only names that contain what was typed.
        threshold: matchSorter.rankings.CONTAINS,
        keys: [(item) => sideLabel(item), (item) => sideLabel(item).replace(/[/_-]/g, " ")],
      }}
      empty={<div className="p-3 text-xs text-text-dimmed">No environments found.</div>}
      text={<SideCombo environment={side.environment} />}
      dropdownIcon
    >
      {(matches) =>
        matches?.map((env) => (
          <SelectItem key={env.id} value={env.id}>
            <SideCombo environment={env} />
          </SelectItem>
        ))
      }
    </Select>
  );
}

function CompareTableRow({
  row,
  path,
  isSelected,
  revealAll,
  canTick,
  isTicked,
  isAnyTicked,
  onToggle,
  copyTo,
}: {
  row: CompareRow;
  /** The key's panel, beside the table. */
  path: string;
  isSelected: boolean;
  revealAll: boolean;
  /** Whether the row has a checkbox. */
  canTick: boolean;
  isTicked: boolean;
  isAnyTicked: boolean;
  /** Ticks or unticks the row; with Shift held, a range. */
  onToggle: (shiftKey: boolean) => void;
  /** The copy button for a side's value, when that value can be copied to the other side. */
  copyTo: (from: CompareSideName) => { label: string; onClick: () => void } | undefined;
}) {
  const tickClassName = tickCellClassName({ isTicked, isAnyTicked, isSelected });
  return (
    <TableRow isSelected={isSelected} className="group/row">
      {/* No link in this cell, so ticking a row never opens the key panel. */}
      {canTick && (
        <TableCell
          className={cn("w-0 pl-3 pr-0", isTicked && tickClassName)}
          isSelected={isSelected}
        >
          <Checkbox
            aria-label={`Select ${row.key}`}
            value={row.id}
            checked={isTicked}
            // A Shift-click would otherwise select the page's text between the two clicks.
            onMouseDown={(event) => {
              if (event.shiftKey) {
                event.preventDefault();
              }
            }}
            onChange={(event) =>
              onToggle(event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)
            }
          />
        </TableCell>
      )}
      <TableCell
        to={path}
        isTabbableCell
        isSelected={isSelected}
        className={tickClassName}
        actionClassName={cn("font-mono", isTicked && "text-text-bright")}
        trailingContent={<CopyKeyButton value={row.key} />}
      >
        {row.key}
      </TableCell>
      {(["left", "right"] as const).map((side) => {
        const copy = copyTo(side);
        return (
          <TableCell
            key={side}
            className={cn("relative py-2", tickClassName)}
            isSelected={isSelected}
            hasAction
          >
            {/* Fills the cell, so a click anywhere but the value's own controls opens the panel. */}
            <Link to={path} tabIndex={-1} aria-hidden className="absolute inset-0" />
            {/* No width of its own, so a value's field shrinks with its column beside the key panel. */}
            <div className="pointer-events-none relative flex w-0 min-w-full items-center gap-2 pr-3 [&_button]:pointer-events-auto [&_input]:pointer-events-auto">
              <div className="min-w-0 flex-1">
                <CompareValue cell={row[side]} revealAll={revealAll} />
              </div>
              {copy && (
                // Shown on the row's hover, or when reached with the keyboard.
                <Button
                  variant="secondary/small"
                  LeadingIcon={DocumentDuplicateIcon}
                  className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
                  onClick={copy.onClick}
                >
                  {copy.label}
                </Button>
              )}
            </div>
          </TableCell>
        );
      })}
    </TableRow>
  );
}

/**
 * One side's value as the list shows it, or Not set. A secret that differs says so, and an empty
 * secret says Empty with the lock.
 */
function CompareValue({ cell, revealAll }: { cell: CompareCell; revealAll: boolean }) {
  if (!cell.isSet) {
    return <span className="text-xs text-text-dimmed">Not set</span>;
  }
  if (cell.emptySecret) {
    return (
      <SimpleTooltip
        button={
          <div className="flex items-center gap-x-1">
            <LockClosedIcon className="size-3 text-text-dimmed" />
            <span className="text-xs text-text-dimmed">Empty</span>
          </div>
        }
        content="This secret is set to an empty string."
      />
    );
  }
  if (cell.differs) {
    return (
      <div className="flex items-center gap-1.5">
        <EnvironmentVariableValue variable={cell} revealAll={revealAll} />
        <span className="text-xs text-text-dimmed">differs</span>
      </div>
    );
  }
  return <EnvironmentVariableValue variable={cell} revealAll={revealAll} />;
}

const countFormat = new Intl.NumberFormat("en-US");

function formatCount(count: number) {
  return countFormat.format(count);
}
