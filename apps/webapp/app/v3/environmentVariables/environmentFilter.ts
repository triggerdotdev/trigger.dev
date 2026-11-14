import type { RuntimeEnvironmentType } from "@trigger.dev/database";

// The values of the `env` search param on the environment variables page.
const ENVIRONMENT_VARIABLES_FILTERS = ["dev", "stg", "prod", "preview", "all"] as const;

export type EnvironmentVariablesFilter = (typeof ENVIRONMENT_VARIABLES_FILTERS)[number];
type EnvironmentVariablesTypeFilter = Exclude<EnvironmentVariablesFilter, "all">;

// In the order the options are shown.
const TYPE_FILTERS: Array<{
  filter: EnvironmentVariablesTypeFilter;
  type: RuntimeEnvironmentType;
}> = [
  { filter: "dev", type: "DEVELOPMENT" },
  { filter: "stg", type: "STAGING" },
  { filter: "preview", type: "PREVIEW" },
  { filter: "prod", type: "PRODUCTION" },
];

type FilterEnvironment = {
  id: string;
  type: RuntimeEnvironmentType;
  parentEnvironmentId: string | null;
  branchName: string | null;
};

// Full names accepted in `env` (and the compare view's sides). Links keep writing the short values.
const FILTER_ALIASES: Record<string, EnvironmentVariablesFilter> = {
  development: "dev",
  staging: "stg",
  production: "prod",
};

/** Reads an `env` value: a short value or a full environment name, in any case. */
export function parseEnvironmentVariablesFilter(
  value: unknown
): EnvironmentVariablesFilter | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const lower = value.toLowerCase();
  // Own properties only: `constructor` or `__proto__` must not resolve to Object's.
  return (
    (Object.hasOwn(FILTER_ALIASES, lower) ? FILTER_ALIASES[lower] : undefined) ??
    ENVIRONMENT_VARIABLES_FILTERS.find((filter) => filter === lower)
  );
}

export function environmentTypeForFilter(
  filter: EnvironmentVariablesTypeFilter
): RuntimeEnvironmentType {
  return TYPE_FILTERS.find((entry) => entry.filter === filter)!.type;
}

export function filterForEnvironmentType(
  type: RuntimeEnvironmentType
): EnvironmentVariablesTypeFilter {
  return TYPE_FILTERS.find((entry) => entry.type === type)!.filter;
}

/** The filter options a project offers: "all", then one per environment type it has. */
export function availableEnvironmentVariablesFilters(
  environments: Array<Pick<FilterEnvironment, "type">>
): EnvironmentVariablesFilter[] {
  const types = new Set(environments.map((environment) => environment.type));
  return [
    "all",
    ...TYPE_FILTERS.filter((entry) => types.has(entry.type)).map((entry) => entry.filter),
  ];
}

/** The `branch` search param value that asks for every preview branch, even on a branch URL. */
export const ALL_BRANCHES = "all";

/**
 * Picks the environments whose variables the page lists.
 *
 * Preview lists the Preview base plus its branches: the requested branches when any are
 * requested by name (or, without a usable request, the current environment when it is a preview
 * branch), every branch otherwise. Unknown names are ignored. `ALL_BRANCHES` asks for every
 * branch. Other type filters list the environments of that type that aren't branches, plus the
 * current environment when it is a branch of that type (a branch runs with its parent's values
 * and its own). "all" lists every environment. With no usable request the filter is the current
 * environment's type (or `currentEnvironmentType` when the current environment isn't in the
 * list, as with an archived branch), and "all" when there is neither.
 */
export function selectEnvironmentVariablesFilter({
  environments,
  requested,
  requestedBranches = [],
  currentEnvironmentId,
  currentEnvironmentType,
}: {
  /** The environments the page can show. */
  environments: FilterEnvironment[];
  requested?: EnvironmentVariablesFilter;
  /** Preview branch names, or `ALL_BRANCHES`. Only used by the Preview filter. */
  requestedBranches?: string[];
  currentEnvironmentId?: string;
  /** The current environment's type, for when it isn't in `environments` (an archived branch). */
  currentEnvironmentType?: RuntimeEnvironmentType;
}): {
  filter: EnvironmentVariablesFilter;
  environmentIds: string[];
  /** The preview branches the list is narrowed to. Empty when it lists every branch. */
  branchEnvironmentIds?: string[];
} {
  const all = { filter: "all" as const, environmentIds: environments.map((e) => e.id) };
  const current = environments.find((environment) => environment.id === currentEnvironmentId);

  const forPreview = () => {
    const branches = environments.filter(
      (environment) => environment.type === "PREVIEW" && environment.parentEnvironmentId !== null
    );
    const requested = branches.filter(
      (environment) =>
        environment.branchName !== null && requestedBranches.includes(environment.branchName)
    );
    const current = branches.filter((environment) => environment.id === currentEnvironmentId);
    const picked = requestedBranches.includes(ALL_BRANCHES)
      ? []
      : requested.length > 0
        ? requested
        : current;
    const pickedIds = new Set(picked.map((environment) => environment.id));

    return {
      filter: "preview" as const,
      environmentIds: environments
        .filter(
          (environment) =>
            environment.type === "PREVIEW" &&
            (environment.parentEnvironmentId === null ||
              pickedIds.size === 0 ||
              pickedIds.has(environment.id))
        )
        .map((environment) => environment.id),
      branchEnvironmentIds: picked.map((environment) => environment.id),
    };
  };

  const forFilter = (filter: EnvironmentVariablesTypeFilter) => {
    if (filter === "preview") {
      return forPreview();
    }

    const type = environmentTypeForFilter(filter);
    return {
      filter,
      environmentIds: environments
        .filter(
          (environment) =>
            environment.type === type &&
            (environment.parentEnvironmentId === null || environment.id === currentEnvironmentId)
        )
        .map((environment) => environment.id),
    };
  };

  if (requested === "all") {
    return all;
  }

  if (requested) {
    const selection = forFilter(requested);
    // A type the project doesn't have is treated like no request.
    if (selection.environmentIds.length > 0) {
      return selection;
    }
  }

  const fallbackType = current?.type ?? currentEnvironmentType;
  if (fallbackType) {
    const selection = forFilter(filterForEnvironmentType(fallbackType));
    if (selection.environmentIds.length > 0) {
      return selection;
    }
  }

  return all;
}

const ENVIRONMENT_VARIABLES_SORTS = ["updated", "updated-asc"] as const;

/**
 * The list's order. `updated` is newest first, by the most recent update among a key's values in
 * view. `updated-asc` is oldest first, by the oldest. With one environment in view a key has one
 * value, so both go by it. No sort means alphabetical by key.
 */
export type EnvironmentVariablesSort = (typeof ENVIRONMENT_VARIABLES_SORTS)[number];

/**
 * Whether a view can be sorted by last update. Only where the sort reads a bounded number of
 * values: a view of one environment, or Preview narrowed to one branch (the Preview base plus
 * that branch). "All" and Preview with every branch or several can't, and list alphabetically
 * whatever sort is asked for.
 */
export function canSortEnvironmentVariablesView(view: {
  filter: EnvironmentVariablesFilter;
  environmentIds: string[];
  branchEnvironmentIds?: string[];
}): boolean {
  if (view.filter === "all") {
    return false;
  }
  if (view.environmentIds.length === 1) {
    return true;
  }
  return (
    view.filter === "preview" &&
    view.branchEnvironmentIds?.length === 1 &&
    view.environmentIds.length === 2
  );
}

export function parseEnvironmentVariablesSort(
  value: string | null | undefined
): EnvironmentVariablesSort | undefined {
  return ENVIRONMENT_VARIABLES_SORTS.find((sort) => sort === value);
}

/** What a click on the Updated header switches to: newest first, oldest first, alphabetical. */
export function nextEnvironmentVariablesSort(
  sort: EnvironmentVariablesSort | undefined
): EnvironmentVariablesSort | undefined {
  switch (sort) {
    case undefined:
      return "updated";
    case "updated":
      return "updated-asc";
    case "updated-asc":
      return undefined;
  }
}

// The search params that describe the list view: its filter, branches, search, sort and page.
const LIST_VIEW_SEARCH_PARAMS = ["env", "branch", "search", "sort", "page"];

/**
 * The list view's search params from a URL (or its search params), as a query string ("?..." or ""), so an
 * action can send the user back to the view they acted from. Other params are dropped, apart
 * from the ones named in `alsoKeep`.
 */
export function listViewSearch(
  url: string | URL | URLSearchParams,
  alsoKeep: string[] = []
): string {
  const searchParams = url instanceof URLSearchParams ? url : new URL(url).searchParams;
  const kept = new URLSearchParams();
  for (const name of [...LIST_VIEW_SEARCH_PARAMS, ...alsoKeep]) {
    for (const value of searchParams.getAll(name)) {
      if (value) {
        kept.append(name, value);
      }
    }
  }
  const search = kept.toString();
  return search ? `?${search}` : "";
}

/**
 * The list view to open after values were saved into `savedEnvironmentIds`, from the view
 * they were saved from (its `env` and `branch` params). When one of the saved environments is in
 * view, the view stays. Otherwise it switches to show them: the one environment's filter (for a
 * Preview branch, Preview narrowed to that branch alone), or "all" for several. A switch drops a
 * sort the new view can't apply. Search and other params are kept; `page` is left to the caller.
 */
export function viewAfterSave({
  searchParams,
  environments,
  currentEnvironmentId,
  currentEnvironmentType,
  savedEnvironmentIds,
}: {
  searchParams: URLSearchParams;
  environments: FilterEnvironment[];
  currentEnvironmentId?: string;
  /** The current environment's type when it isn't in `environments` (an archived branch). */
  currentEnvironmentType?: RuntimeEnvironmentType;
  savedEnvironmentIds: string[];
}): {
  searchParams: URLSearchParams;
  view: ReturnType<typeof selectEnvironmentVariablesFilter>;
  switched: boolean;
} {
  const select = (params: URLSearchParams) =>
    selectEnvironmentVariablesFilter({
      environments,
      requested: parseEnvironmentVariablesFilter(params.get("env")),
      requestedBranches: params.getAll("branch"),
      currentEnvironmentId,
      currentEnvironmentType,
    });

  const view = select(searchParams);
  if (savedEnvironmentIds.some((id) => view.environmentIds.includes(id))) {
    return { searchParams, view, switched: false };
  }

  const saved = environments.filter((environment) => savedEnvironmentIds.includes(environment.id));
  const next = new URLSearchParams(searchParams);
  next.delete("branch");
  const only = saved.length === 1 ? saved[0] : undefined;
  if (only?.type === "PREVIEW" && only.parentEnvironmentId !== null && only.branchName) {
    next.set("env", "preview");
    next.set("branch", only.branchName);
  } else if (only && only.parentEnvironmentId === null) {
    next.set("env", filterForEnvironmentType(only.type));
  } else {
    next.set("env", "all");
  }

  const nextView = select(next);
  if (!canSortEnvironmentVariablesView(nextView)) {
    next.delete("sort");
  }
  return { searchParams: next, view: nextView, switched: true };
}
