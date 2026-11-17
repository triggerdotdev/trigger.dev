import {
  ArrowUturnLeftIcon,
  DocumentDuplicateIcon,
  EyeSlashIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import {
  Link,
  Outlet,
  useFetcher,
  useLocation,
  useNavigate,
  useParams,
  type ShouldRevalidateFunction,
} from "@remix-run/react";
import { json, redirect, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { EnvironmentCombo, environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import {
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  collapsibleHandleClassName,
} from "~/components/primitives/Resizable";
import { SearchInput } from "~/components/primitives/SearchInput";
import { Select, SelectItem } from "~/components/primitives/Select";
import {
  SelectedItemsProvider,
  useSelectedItems,
  useTickedBeforeHydration,
} from "~/components/primitives/SelectedItemsProvider";
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
import { env } from "~/env.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  EnvironmentVariablesAttentionPresenter,
  type AttentionRow,
  type EnvironmentVariablesAttention,
} from "~/presenters/v3/EnvironmentVariablesAttentionPresenter.server";
import type { EnvironmentVariablesEnvironment } from "~/presenters/v3/environmentVariablesEnvironments.server";
import { BatchDeleteDialog } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/BatchDelete";
import { CopyKeyButton } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/CopyKeyButton";
import {
  DeleteEnvironmentVariableButton,
  EditEnvironmentVariablePanel,
  EnvironmentVariableValue,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/EnvironmentVariableControls";
import {
  action as listAction,
  type EnvironmentVariablesOutletContext,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route";
import {
  SelectionBar,
  tickCellClassName,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/SelectionBar";
import { action as compareAction } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables_.compare/route";
import { CompareToolbar } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables_.compare/CompareToolbar";
import {
  CopyValuesDialog,
  type CopyValuesDialogPlan,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables_.compare/CopyValues";
import { isExternalOidcEnabled } from "~/services/oidc/externalOidc.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { recordDashboardEnvironmentVariablesListed } from "~/services/auditLogs/envVarReadAudit.server";
import { requireRecentMfa } from "~/services/mfa/mfaPolicy.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { cn } from "~/utils/cn";
import { pageMeta } from "~/utils/pageTitle";
import {
  REASON_ICONS,
  REASON_ORDER,
  REASON_TITLES,
  IgnoredReasonLines,
  ReasonLines,
  sortedReasons,
} from "./AttentionReasons";
import {
  EnvironmentParamSchema,
  v3EnvironmentVariablesAttentionPath,
  v3EnvironmentVariablesPath,
  v3OidcPath,
} from "~/utils/pathBuilder";
import {
  ATTENTION_KIND_PARAM,
  AttentionIgnoreForm,
  attentionReturnPath,
  attentionViewSearch,
  IGNORED_ATTENTION_VIEW,
  isIgnorableAttentionKind,
  parseAttentionKind,
  type AttentionIgnoreItem,
  type AttentionKind,
  type AttentionView,
} from "~/v3/environmentVariables/attention";
import { setAttentionIgnores } from "~/v3/environmentVariables/attentionIgnores.server";
import { parseEnvironmentVariableForm } from "~/v3/environmentVariables/forms";
import { filterForEnvironmentType } from "~/v3/environmentVariables/environmentFilter";
import { NEW_VARIABLE_ENVIRONMENT_PARAM } from "~/v3/environmentVariables/environmentVariableKey";
import { COPY_ENVIRONMENT_VARIABLE_VALUES_LIMIT } from "~/v3/environmentVariables/repository";

export const meta = pageMeta(["Needs attention", "Environment variables"]);

// The key panel keeps its own search params next to the page's. A navigation that changes only
// those leaves the page as it is. Anything after a form submission still revalidates.
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
    attentionViewSearch(currentUrl) === attentionViewSearch(nextUrl)
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
      // dev | stg | prod | preview, or a full name. Anything else is the environment in the URL.
      env: z.string().optional().catch(undefined),
      // empty | missing | recent | oidc. Anything else lists every kind.
      [ATTENTION_KIND_PARAM]: z.string().optional().catch(undefined),
    }),
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    // As the list: an environment the role can't read isn't read, and the page says so.
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
      const attention = await new EnvironmentVariablesAttentionPresenter().call({
        userId: user.id,
        projectId,
        env: searchParams.env,
        // The list's branch filter: with branch names, the page opens on the URL's environment.
        branches: new URL(request.url).searchParams.getAll("branch"),
        currentEnvironmentSlug: params.envParam,
        kind: parseAttentionKind(searchParams[ATTENTION_KIND_PARAM]),
        search: searchParams.search,
        page: searchParams.page,
        canRead: (envType) => ability.can("read", { type: "envvars", envType }),
        canWrite: (envType) => ability.can("write", { type: "envvars", envType }),
        maxKeys: env.ENVIRONMENT_VARIABLES_COMPARE_MAX_KEYS,
        isOidcEnabled: isExternalOidcEnabled,
      });
      if (!attention.target) {
        return redirect(
          v3EnvironmentVariablesPath(
            { slug: params.organizationSlug },
            { slug: params.projectParam },
            { slug: params.envParam }
          )
        );
      }
      // The page sends the target environment's values on load, as the list does, so a load is a
      // listing of the target when a row set there was sent. Missing-here rows carry no value.
      if (context.organizationId && attention.isReadable) {
        recordDashboardEnvironmentVariablesListed({
          organizationId: context.organizationId,
          projectId,
          environments: [attention.target],
          readEnvironmentIds: attention.rows.some((row) => !row.notSetHere)
            ? [attention.target.id]
            : [],
        });
      }
      return typedjson({ ...attention, search: searchParams.search });
    } catch (error) {
      console.error(error);
      throw new Response(undefined, {
        status: 400,
        statusText: "Something went wrong, if this problem persists please contact support.",
      });
    }
  }
);

/**
 * Ignore and undo, this page's own. Each reason's environment is checked for write access, as
 * batch delete checks, before anything is written.
 */
const ignoreAction = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    // Per-environment write:envvars is checked per reason: the environments come from the form.
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
    const submission = parseEnvironmentVariableForm(await request.formData(), AttentionIgnoreForm);
    if (submission.status !== "success") {
      return json(submission.reply(), { status: 400 });
    }

    const { action, items, panelKey } = submission.value;
    const result = await setAttentionIgnores(prisma, {
      projectId,
      userId: user.id,
      action: action === "ignore-reasons" ? "ignore" : "unignore",
      items,
      canWrite: (envType) => ability.can("write", { type: "envvars", envType }),
    });
    const back =
      attentionReturnPath(request.url, params, panelKey) ??
      v3EnvironmentVariablesAttentionPath(
        { slug: params.organizationSlug },
        { slug: params.projectParam },
        { slug: params.envParam }
      );
    if (!result.success) {
      return redirectWithErrorMessage(back, request, result.error);
    }
    const reasons = `${result.changed} ${result.changed === 1 ? "reason" : "reasons"}`;
    return redirectWithSuccessMessage(
      back,
      request,
      action === "ignore-reasons"
        ? result.changed === 0
          ? "Those reasons were already ignored"
          : `Ignored ${reasons}`
        : result.changed === 0
          ? "Those reasons weren't ignored"
          : `Stopped ignoring ${reasons}`
    );
  }
);

const IGNORE_ACTIONS = new Set(["ignore-reasons", "unignore-reasons"]);

/**
 * Ignore and undo; the list's forms (edit, delete, batch delete) and the compare view's copy,
 * posted from this page or its key panel. Each action checks access as it does there, and sends
 * the user back here.
 */
export async function action(args: ActionFunctionArgs) {
  const formData = await args.request.clone().formData();
  const intent = formData.get("action");
  if (typeof intent === "string" && IGNORE_ACTIONS.has(intent)) {
    return ignoreAction(args);
  }
  return intent === "copy-values" ? compareAction(args) : listAction(args);
}

/** Ignores or stops ignoring reasons, from a row or the selection bar. */
function useIgnoreReasons(actionPath: string) {
  const fetcher = useFetcher();
  const { keyParam } = useParams();
  return (action: "ignore-reasons" | "unignore-reasons", items: AttentionIgnoreItem[]) => {
    if (items.length === 0) {
      return;
    }
    const formData = new FormData();
    formData.set("action", action);
    if (keyParam) {
      formData.set("panelKey", keyParam);
    }
    items.forEach((item, index) => {
      formData.set(`items[${index}].variableId`, item.variableId);
      formData.set(`items[${index}].environmentId`, item.environmentId);
      formData.set(`items[${index}].reason`, item.reason);
    });
    fetcher.submit(formData, { method: "post", action: actionPath });
  };
}

// The segmented control's value for every kind.
const ALL_KINDS_VALUE = "all";

// The header checkbox's value, for ticks made before the page hydrated.
const SELECT_ALL_VALUE = "all";

type LoaderData = EnvironmentVariablesAttention & { search?: string };
type ReadableData = Extract<LoaderData, { isReadable: true }>;

export default function Page() {
  return (
    // The cap is the most one delete or copy takes, so the selection can never ask for more.
    <SelectedItemsProvider
      initialSelectedItems={[]}
      maxSelectedItemCount={COPY_ENVIRONMENT_VARIABLE_VALUES_LIMIT}
    >
      <AttentionPage />
    </SelectedItemsProvider>
  );
}

function AttentionPage() {
  const data = useTypedLoaderData<LoaderData>();
  const [revealAll, setRevealAll] = useState(false);
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  const navigate = useNavigate();
  const { keyParam } = useParams();
  const isShowingKeyPanel = keyParam !== undefined;
  const target = data.target!;
  const targetName = environmentFullTitle(target);

  const attentionPath = v3EnvironmentVariablesAttentionPath(organization, project, environment);
  const urlParams = new URLSearchParams(location.search);
  const viewSearch = attentionViewSearch(urlParams);
  // Read from the URL, so the control moves on click while the next page loads.
  const selectedKind = parseAttentionKind(urlParams.get(ATTENTION_KIND_PARAM));

  // Another view of the page: starts at the first page, and keeps the key panel open.
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

  // Back to the list, with the filter it had when this page was opened.
  const listFilter = new URLSearchParams();
  for (const name of ["env", "branch"]) {
    for (const value of urlParams.getAll(name)) {
      listFilter.append(name, value);
    }
  }
  const listPath = `${v3EnvironmentVariablesPath(organization, project, environment)}${
    listFilter.size > 0 ? `?${listFilter.toString()}` : ""
  }`;

  const pickerEnvironments = data.environments.filter((e) => e.parentEnvironmentId === null);
  const picker = (
    <Select<string, EnvironmentVariablesEnvironment>
      aria-label="Environment"
      variant="minimal/small"
      value={target.id}
      setValue={(id) => {
        const picked = pickerEnvironments.find((e) => e.id === id);
        if (picked) {
          navigate(viewPath({ env: filterForEnvironmentType(picked.type), branch: undefined }));
        }
      }}
      items={pickerEnvironments}
      className="w-fit"
      text={<EnvironmentName environment={target} />}
      dropdownIcon
    >
      {(matches) =>
        matches?.map((e) => (
          <SelectItem key={e.id} value={e.id}>
            <EnvironmentName environment={e} />
          </SelectItem>
        ))
      }
    </Select>
  );

  const outletContext: EnvironmentVariablesOutletContext = {
    revealAll,
    attention: { path: attentionPath, closePath: `${attentionPath}${viewSearch}` },
  };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title="Needs attention"
          backButton={{ to: listPath, text: "Environment variables" }}
        />
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="environment-variables-attention-main" min={"100px"}>
            {data.isReadable ? (
              <AttentionTable
                data={data}
                picker={picker}
                revealAll={revealAll}
                setRevealAll={setRevealAll}
                selectedKind={selectedKind}
                viewPath={viewPath}
                rowPath={(key) => `${attentionPath}/key/${encodeURIComponent(key)}${viewSearch}`}
                newValuePath={(key) => {
                  const params = new URLSearchParams(viewSearch);
                  params.set(NEW_VARIABLE_ENVIRONMENT_PARAM, target.id);
                  return `${attentionPath}/key/${encodeURIComponent(key)}/new?${params.toString()}`;
                }}
              />
            ) : (
              <div className="flex h-full flex-col">
                <div className="flex items-center gap-2 px-3 py-2">{picker}</div>
                <div className="flex flex-col items-center gap-y-3 py-8">
                  <Paragraph className="max-w-lg text-center">
                    With your current role, you can't view the variables in {targetName}.
                  </Paragraph>
                </div>
              </div>
            )}
          </ResizablePanel>
          <ResizableHandle
            id="environment-variables-attention-handle"
            className={collapsibleHandleClassName(isShowingKeyPanel)}
          />
          <ResizablePanel
            id="environment-variables-attention-key"
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

/** A root environment by name; the Preview environment is the base its branches inherit. */
function EnvironmentName({
  environment,
}: {
  environment: Pick<EnvironmentVariablesEnvironment, "type" | "branchName">;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <EnvironmentCombo environment={environment} className="text-sm" />
      {environment.type === "PREVIEW" && <span className="font-normal text-text-dimmed">base</span>}
    </span>
  );
}

/** An environment's short name, as the list's filter and the compare view name it. */
function shortName(environment: Pick<EnvironmentVariablesEnvironment, "type">): string {
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

function AttentionTable({
  data,
  picker,
  revealAll,
  setRevealAll,
  selectedKind,
  viewPath,
  rowPath,
  newValuePath,
}: {
  data: ReadableData;
  picker: React.ReactNode;
  revealAll: boolean;
  setRevealAll: (reveal: boolean) => void;
  selectedKind: AttentionView | undefined;
  viewPath: (values: Record<string, string | undefined>) => string;
  rowPath: (key: string) => string;
  newValuePath: (key: string) => string;
}) {
  const { target, counts, emptyProblem, hasOidc, rows, sources, search, pagination } = data;
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigate = useNavigate();
  const location = useLocation();
  const { keyParam } = useParams();
  const targetName = environmentFullTitle(target);
  const writable = new Set(data.writableEnvironmentIds);
  const canWriteTarget = writable.has(target.id);
  // The sources Missing here can copy from: the role reads them and writes here.
  const copySources = canWriteTarget
    ? sources.filter((source) => data.readableSourceIds.includes(source.id))
    : [];
  const shownKind = selectedKind === "oidc" && !hasOidc ? undefined : selectedKind;
  const isIgnoredView = shownKind === IGNORED_ATTENTION_VIEW;
  const ignoreReasons = useIgnoreReasons(
    `${v3EnvironmentVariablesAttentionPath(organization, project, environment)}${location.search}`
  );
  // What a row's Ignore takes (the tab's kind, or in All every kind that can be ignored), and in
  // the Ignored tab what its Stop ignoring gives back.
  const ignoreItems = (row: AttentionRow): AttentionIgnoreItem[] =>
    (isIgnoredView
      ? row.ignored.map((ignore) => ignore.kind)
      : row.kinds.filter(isIgnorableAttentionKind).filter((k) => !shownKind || k === shownKind)
    ).map((reason) => ({ variableId: row.id, environmentId: target.id, reason }));

  const emptyTitle =
    emptyProblem?.kind === "tooManyKeys"
      ? `Empty: too many keys to check (more than ${formatCount(emptyProblem.max)}). Search to narrow them down.`
      : emptyProblem?.kind === "unavailable"
        ? "Empty: these values can't be read right now, so empty ones can't be found."
        : "Empty: values set to an empty string";
  const kindOptions = [
    {
      value: ALL_KINDS_VALUE,
      label: "All",
      title: "All: every key that needs attention",
      count: counts.all,
    },
    {
      value: "empty",
      label: REASON_TITLES.empty,
      title: emptyTitle,
      count: emptyProblem ? undefined : counts.empty,
    },
    {
      value: "missing",
      label: REASON_TITLES.missing,
      title: `Missing here: set in another environment but not in ${targetName}`,
      count: counts.missing,
    },
    {
      value: "recent",
      label: REASON_TITLES.recent,
      title: "Changed recently: in the last 24 hours",
      count: counts.recent,
    },
    ...(hasOidc
      ? [
          {
            value: "oidc",
            label: REASON_TITLES.oidc,
            title: "Replace with OIDC: keys an OIDC setup could replace",
            count: counts.oidc,
          },
        ]
      : []),
    {
      value: IGNORED_ATTENTION_VIEW,
      label: "Ignored",
      title: "Ignored: reasons your team chose to ignore here",
      count: counts.ignored,
    },
  ];

  // The selection is this page's rows only, by variable id.
  const { selectedItems, has, select, deselect, toggle, deselectAll } = useSelectedItems();
  const rowIds = rows.map((row) => row.id);
  const selectedRows = rows.filter((row) => has(row.id));
  const isEverySelected = selectedRows.length > 0 && selectedRows.length === rows.length;
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [copy, setCopy] = useState<
    { plan: CopyValuesDialogPlan; source: EnvironmentVariablesEnvironment } | undefined
  >(undefined);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  const focusListStart = useCallback(() => {
    const list = tableScrollRef.current;
    const element =
      list?.querySelector<HTMLElement>(`input[value="${SELECT_ALL_VALUE}"]`) ??
      list?.querySelector<HTMLElement>("a[href], button:not([disabled]), input:not([disabled])");
    element?.focus();
  }, []);

  const lastToggledRef = useRef<string | null>(null);
  const toggleRow = (id: string, shiftKey: boolean) => {
    const from = lastToggledRef.current ? rowIds.indexOf(lastToggledRef.current) : -1;
    const to = rowIds.indexOf(id);
    lastToggledRef.current = id;
    if (shiftKey && from !== -1 && to !== -1 && from !== to) {
      const range = rowIds.slice(Math.min(from, to), Math.max(from, to) + 1);
      if (has(id)) {
        deselect(range);
      } else {
        select(range);
      }
      return;
    }
    toggle(id);
  };

  // A ticked row that left the page (copied, deleted, or fixed elsewhere) is unticked.
  const rowKey = rowIds.join(" ");
  useEffect(() => {
    const listed = new Set(rowKey.split(" "));
    const gone = [...selectedItems].filter((id) => !listed.has(id));
    if (gone.length > 0) {
      deselect(gone);
    }
  }, [rowKey, selectedItems, deselect]);

  useTickedBeforeHydration(tableScrollRef, (values) =>
    select(values.includes(SELECT_ALL_VALUE) ? rowIds : values)
  );

  // Another environment, kind, search or page: start with nothing ticked. Not on mount.
  const viewSearch = attentionViewSearch(new URLSearchParams(location.search));
  const clearedViewRef = useRef(viewSearch);
  useEffect(() => {
    if (clearedViewRef.current === viewSearch) {
      return;
    }
    clearedViewRef.current = viewSearch;
    deselectAll();
  }, [viewSearch, deselectAll]);

  // Missing here rows are copied; the rest can be deleted. The Ignored tab only stops ignoring.
  const deletable =
    canWriteTarget && !isIgnoredView ? selectedRows.filter((row) => !row.notSetHere) : [];
  const selectedIgnoreItems = canWriteTarget ? selectedRows.flatMap(ignoreItems) : [];
  const reasonAction =
    selectedIgnoreItems.length === 0
      ? []
      : [
          {
            label: isIgnoredView ? "Stop ignoring" : "Ignore",
            icon: isIgnoredView ? ArrowUturnLeftIcon : EyeSlashIcon,
            variant: "secondary/small" as const,
            onClick: () => {
              ignoreReasons(
                isIgnoredView ? "unignore-reasons" : "ignore-reasons",
                selectedIgnoreItems
              );
              deselectAll();
            },
          },
        ];
  const selectedMissing = selectedRows.filter((row) => row.notSetHere);
  const copyPlan = (rowsToCopy: AttentionRow[], sourceId: string): CopyValuesDialogPlan => {
    const copied = rowsToCopy.filter((row) =>
      row.notSetHere?.setIn.some((source) => source.id === sourceId)
    );
    return {
      copied: copied.map((row) => ({ row: { id: row.id, key: row.key }, replaces: false })),
      skipped: { notSet: rowsToCopy.length - copied.length, unreadable: 0, matching: 0, empty: 0 },
    };
  };
  const copyActions = (isIgnoredView ? [] : copySources)
    .filter((source) =>
      selectedMissing.some((row) => row.notSetHere?.setIn.some((s) => s.id === source.id))
    )
    .map((source) => ({
      label: `Copy from ${shortName(source)}`,
      icon: DocumentDuplicateIcon,
      variant: "secondary/small" as const,
      onClick: () => setCopy({ plan: copyPlan(selectedMissing, source.id), source }),
    }));

  const emptyMessage = (): string => {
    if (shownKind === "empty" && emptyProblem?.kind === "tooManyKeys") {
      return `${targetName} has more than ${formatCount(emptyProblem.max)} keys, too many to check for empty values. Search to narrow them down.`;
    }
    if (shownKind === "empty" && emptyProblem?.kind === "unavailable") {
      return "These values can't be read right now, so empty ones can't be found.";
    }
    if (search) {
      return "No keys here match your search.";
    }
    switch (shownKind) {
      case "empty":
        return `No empty values in ${targetName}.`;
      case "missing":
        return `Every key set in another environment is set in ${targetName}.`;
      case "recent":
        return `No values changed in ${targetName} in the last 24 hours.`;
      case "oidc":
        return `No keys in ${targetName} that OIDC could replace.`;
      case IGNORED_ATTENTION_VIEW:
        return `Nothing is ignored in ${targetName}.`;
      default:
        return `Nothing needs attention in ${targetName}.`;
    }
  };

  // OIDC setup is per environment: open it on the page's environment, not the URL's.
  const oidcPath = v3OidcPath(
    organization,
    project,
    project.environments.find((e) => e.id === target.id) ?? environment
  );
  const columnCount = 5;

  // In All, rows sit under their most pressing reason, most pressing group first.
  const groups = !shownKind
    ? REASON_ORDER.map((kind) => ({
        kind,
        rows: rows.filter((row) => sortedReasons(row)[0] === kind),
      })).filter((group) => group.rows.length > 0)
    : [{ kind: undefined, rows }];

  const renderRow = (row: AttentionRow) => {
    const path = rowPath(row.key);
    const isSelected = keyParam === row.key;
    const isTicked = has(row.id);
    const tickClassName = tickCellClassName({
      isTicked,
      isAnyTicked: selectedRows.length > 0,
      isSelected,
    });
    // Every source the key is set in; one the role can't read shows disabled, with why.
    const rowSources = canWriteTarget
      ? sources.filter((source) => row.notSetHere?.setIn.some((s) => s.id === source.id))
      : [];
    const rowIgnoreItems = canWriteTarget ? ignoreItems(row) : [];
    const reasonTitles = rowIgnoreItems.map((item) => REASON_TITLES[item.reason]).join(" and ");
    const reasonButton =
      rowIgnoreItems.length > 0 ? (
        <Button
          variant="small-menu-item"
          LeadingIcon={isIgnoredView ? ArrowUturnLeftIcon : EyeSlashIcon}
          tooltip={`${isIgnoredView ? "Stop ignoring" : "Ignore"} ${reasonTitles}`}
          aria-label={`${isIgnoredView ? "Stop ignoring" : "Ignore"} ${reasonTitles} for ${row.key}`}
          onClick={() =>
            ignoreReasons(isIgnoredView ? "unignore-reasons" : "ignore-reasons", rowIgnoreItems)
          }
        />
      ) : undefined;
    const missingButtons =
      row.notSetHere && canWriteTarget && !isIgnoredView ? (
        <>
          <CopyFromButton
            keyName={row.key}
            sources={rowSources}
            isReadable={(source) => data.readableSourceIds.includes(source.id)}
            onCopy={(source) => setCopy({ plan: copyPlan([row], source.id), source })}
          />
          <LinkButton to={newValuePath(row.key)} variant="secondary/small" LeadingIcon={PlusIcon}>
            Set
          </LinkButton>
        </>
      ) : undefined;
    return (
      <TableRow key={row.id} isSelected={isSelected}>
        <TableCell
          className={cn("w-0 pl-3 pr-0", isTicked && tickClassName)}
          isSelected={isSelected}
        >
          {canWriteTarget && (
            <Checkbox
              aria-label={`Select ${row.key}`}
              value={row.id}
              checked={isTicked}
              onMouseDown={(event) => {
                if (event.shiftKey) {
                  event.preventDefault();
                }
              }}
              onChange={(event) =>
                toggleRow(
                  row.id,
                  event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey
                )
              }
            />
          )}
        </TableCell>
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
        <TableCell
          className={cn("relative max-w-0 py-2 pr-6", tickClassName)}
          isSelected={isSelected}
          hasAction
        >
          <Link to={path} tabIndex={-1} aria-hidden className="absolute inset-0" />
          <div className="pointer-events-none relative w-full [&_button]:pointer-events-auto [&_input]:pointer-events-auto">
            {row.notSetHere ? (
              <span className="text-sm text-text-dimmed">Not set</span>
            ) : (
              <EnvironmentVariableValue variable={row} revealAll={revealAll} />
            )}
          </div>
        </TableCell>
        <TableCell
          to={path}
          isSelected={isSelected}
          className={cn(
            "max-w-0",
            // Touch screens always show the row actions: room for them at the row's end.
            missingButtons
              ? "pointer-coarse:pr-[17rem]"
              : !isIgnoredView && row.kinds.includes("oidc")
                ? "pointer-coarse:pr-60"
                : "pointer-coarse:pr-32",
            tickClassName
          )}
          actionClassName={cn("min-w-0", isTicked && "text-text-bright")}
        >
          {isIgnoredView ? <IgnoredReasonLines row={row} /> : <ReasonLines row={row} />}
        </TableCell>
        <TableCellMenu
          isSticky
          isSelected={isSelected}
          className={cn(
            "[&:has([data-hidden-buttons])]:w-auto w-0 pointer-coarse:static",
            isTicked && tickClassName
          )}
          // Copy from and Set stay in view, except in a narrow table, where they would cover the
          // reason: there they show on hover, as edit and delete do.
          visibleButtons={
            missingButtons ? (
              <div className="flex items-center gap-1 @max-[60rem]:hidden">{missingButtons}</div>
            ) : undefined
          }
          hiddenButtons={
            missingButtons ? (
              <>
                <div className="flex items-center gap-1 @min-[60rem]:hidden">{missingButtons}</div>
                {reasonButton}
              </>
            ) : row.notSetHere || isIgnoredView ? (
              // The Ignored tab only stops ignoring, as its bar does.
              reasonButton
            ) : (
              <>
                {row.kinds.includes("oidc") && (
                  <LinkButton to={oidcPath} variant="small-menu-item" LeadingIcon={KeyIcon}>
                    Set up OIDC
                  </LinkButton>
                )}
                {reasonButton}
                <EditEnvironmentVariablePanel variable={row} revealAll={revealAll} />
                {canWriteTarget && <DeleteEnvironmentVariableButton variable={row} />}
              </>
            )
          }
        />
      </TableRow>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CompareToolbar
        search={
          <SearchInput
            placeholder="Search keys…"
            resetParams={["page"]}
            shortcut={{ key: "/" }}
            autoFocus
          />
        }
        kinds={kindOptions}
        selectedKind={shownKind ?? ALL_KINDS_VALUE}
        onKindChange={(value) =>
          navigate(
            viewPath({ [ATTENTION_KIND_PARAM]: value === ALL_KINDS_VALUE ? undefined : value })
          )
        }
        subset={null}
        revealSwitch={
          <Switch
            variant="secondary/small"
            label="Reveal values"
            checked={revealAll}
            onCheckedChange={(checked) => setRevealAll(checked)}
          />
        }
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={tableScrollRef}
          className={cn(
            "@container min-h-0 flex-1 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
            selectedRows.length > 0 && "pb-28"
          )}
        >
          {/* On touch the row actions always show, so the table keeps a width where they sit beside
              the reason, and scrolls sideways when the page is narrower. */}
          <Table
            className="pointer-coarse:min-w-[72rem]"
            containerClassName={cn(rows.length === 0 && "border-t-0", "overflow-visible")}
          >
            <TableHeader>
              <TableRow>
                <TableHeaderCell className="w-0 pl-3 pr-0">
                  {rows.length > 0 && (
                    <Checkbox
                      aria-label="Select every key on this page"
                      value={SELECT_ALL_VALUE}
                      checked={isEverySelected}
                      ref={(element) => {
                        if (element) {
                          element.indeterminate = selectedRows.length > 0 && !isEverySelected;
                        }
                      }}
                      onChange={() => {
                        lastToggledRef.current = null;
                        if (isEverySelected) {
                          deselectAll();
                        } else {
                          select(rowIds);
                        }
                      }}
                    />
                  )}
                </TableHeaderCell>
                <TableHeaderCell className="w-[26%]">Key</TableHeaderCell>
                <TableHeaderCell className="w-[24%]">
                  <span className="-my-1 -ml-2 flex">{picker}</span>
                </TableHeaderCell>
                <TableHeaderCell>Reason</TableHeaderCell>
                <TableHeaderCell className="w-0">
                  <span className="sr-only">Actions</span>
                </TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length > 0 ? (
                groups.map((group) => (
                  <Fragment key={group.kind ?? "all"}>
                    {group.kind && <ReasonGroupRow kind={group.kind} colSpan={columnCount} />}
                    {group.rows.map(renderRow)}
                  </Fragment>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columnCount}>
                    <div className="flex flex-col items-center justify-center gap-y-3 py-8">
                      {!search && !shownKind && counts.all === 0 ? (
                        <Header2>{emptyMessage()}</Header2>
                      ) : (
                        <Paragraph className="max-w-lg text-center">{emptyMessage()}</Paragraph>
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
          label={<>{selectedRows.length} selected</>}
          onClear={deselectAll}
          restoreFocus={focusListStart}
          actions={[
            ...copyActions,
            ...reasonAction,
            ...(deletable.length > 0
              ? [
                  {
                    label: "Delete",
                    icon: TrashIcon,
                    variant: "danger/small" as const,
                    onClick: () => setIsDeleteOpen(true),
                  },
                ]
              : []),
          ]}
        />
        <BatchDeleteDialog
          selected={deletable.map((row) => ({ ...row, previewBase: "unknown" as const }))}
          isOpen={isDeleteOpen}
          setIsOpen={setIsDeleteOpen}
          restoreFocus={focusListStart}
        />
        <CopyValuesDialog
          plan={copy?.plan}
          source={{ environment: copy?.source ?? target }}
          target={{ environment: target }}
          setPlan={() => setCopy(undefined)}
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
  );
}

/** The heading row of the rows whose most pressing reason is `kind`. */
function ReasonGroupRow({ kind, colSpan }: { kind: AttentionKind; colSpan: number }) {
  const { icon: Icon, className } = REASON_ICONS[kind];
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="bg-background-bright py-1.5">
        <span className="flex items-center gap-1.5 text-xs font-medium text-text-bright">
          <Icon className={cn("size-4", className)} aria-hidden />
          {REASON_TITLES[kind]}
        </span>
      </TableCell>
    </TableRow>
  );
}

/**
 * "Copy from <environment>": a button for one source, a small menu for several. A source the
 * role can't read is shown disabled, with why.
 */
function CopyFromButton({
  keyName,
  sources,
  isReadable,
  onCopy,
}: {
  keyName: string;
  sources: EnvironmentVariablesEnvironment[];
  isReadable: (source: EnvironmentVariablesEnvironment) => boolean;
  onCopy: (source: EnvironmentVariablesEnvironment) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const unreadableReason = (source: EnvironmentVariablesEnvironment) =>
    `Your role can't read ${environmentFullTitle(source)}`;
  if (sources.length === 0) {
    return null;
  }
  if (sources.length === 1) {
    const source = sources[0]!;
    const readable = isReadable(source);
    return (
      <Button
        variant="secondary/small"
        LeadingIcon={DocumentDuplicateIcon}
        aria-label={`Copy ${keyName} from ${environmentFullTitle(source)}`}
        disabled={!readable}
        tooltip={readable ? undefined : unreadableReason(source)}
        onClick={() => onCopy(source)}
      >
        Copy from {shortName(source)}
      </Button>
    );
  }
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary/small"
          LeadingIcon={DocumentDuplicateIcon}
          aria-label={`Copy ${keyName} from another environment`}
        >
          Copy from…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="min-w-40 p-1">
        {sources.map((source) =>
          isReadable(source) ? (
            <PopoverMenuItem
              key={source.id}
              title={environmentFullTitle(source)}
              onClick={() => {
                setIsOpen(false);
                onCopy(source);
              }}
            />
          ) : (
            <SimpleTooltip
              key={source.id}
              asChild
              side="left"
              button={
                <div>
                  <PopoverMenuItem title={environmentFullTitle(source)} disabled />
                </div>
              }
              content={unreadableReason(source)}
            />
          )
        )}
      </PopoverContent>
    </Popover>
  );
}

const countFormat = new Intl.NumberFormat("en-US");

function formatCount(count: number) {
  return countFormat.format(count);
}
