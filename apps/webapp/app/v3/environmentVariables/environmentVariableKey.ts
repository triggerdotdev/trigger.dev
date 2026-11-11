import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { listViewSearch } from "./environmentFilter";

// The key panel's own search params: the search and page of its Preview branches list.
export const KEY_PANEL_BRANCH_SEARCH_PARAM = "branchSearch";
export const KEY_PANEL_BRANCH_PAGE_PARAM = "branchPage";
const KEY_PANEL_SEARCH_PARAMS = [KEY_PANEL_BRANCH_SEARCH_PARAM, KEY_PANEL_BRANCH_PAGE_PARAM];

/** The create dialog's search param for the environment to start with, by id. */
export const NEW_VARIABLE_ENVIRONMENT_PARAM = "environmentId";

/**
 * The create dialog's search param for starting on the key panel's key when no environment is
 * asked for: "Add new" on the panel of a key that doesn't exist yet.
 */
export const NEW_VARIABLE_FILL_KEY_PARAM = "fillKey";

/**
 * The create dialog's search param for adding a Preview branch override of the key panel's key:
 * the dialog opens on its branch picker, which lists only the branches without their own value.
 */
export const NEW_VARIABLE_PICK_BRANCH_PARAM = "pickBranch";

/** The create dialog's search param for starting with the secret switch on. */
export const NEW_VARIABLE_SECRET_PARAM = "secret";

/**
 * The search params that describe the list view with the key panel open on it, as a query
 * string ("?..." or ""). Other params are dropped.
 */
export function keyPanelViewSearch(url: string | URL | URLSearchParams): string {
  return listViewSearch(url, KEY_PANEL_SEARCH_PARAMS);
}

/** Only the key panel's own search params, as a query string, to compare two URLs by. */
function keyPanelSearch(url: string | URL): string {
  const searchParams = new URL(url).searchParams;
  const kept = new URLSearchParams();
  for (const name of KEY_PANEL_SEARCH_PARAMS) {
    const value = searchParams.get(name);
    if (value) {
      kept.set(name, value);
    }
  }
  return kept.toString();
}

type Navigation = {
  currentUrl: URL;
  nextUrl: URL;
  currentParams: Record<string, string | undefined>;
  nextParams: Record<string, string | undefined>;
};

// The route params that name the page: another organization, project or environment is another
// list, whatever the search params say.
const PAGE_PARAMS = ["organizationSlug", "projectParam", "envParam"];

function isSamePage({ currentParams, nextParams }: Navigation): boolean {
  return PAGE_PARAMS.every((name) => currentParams[name] === nextParams[name]);
}

/**
 * True when a navigation stays on the same project and environment and changes only the key
 * panel's own search params, so the list's data is still right and needn't be loaded again.
 */
export function navigationKeepsList(navigation: Navigation): boolean {
  const { currentUrl, nextUrl } = navigation;
  return (
    isSamePage(navigation) &&
    currentUrl.search !== nextUrl.search &&
    listViewSearch(currentUrl) === listViewSearch(nextUrl) &&
    keyPanelSearch(currentUrl) !== keyPanelSearch(nextUrl)
  );
}

/**
 * True when a navigation stays on the same key of the same project and leaves the key panel's
 * own search params alone (the list's filter, search or page changed), so the panel's data is
 * still right and needn't be loaded again.
 */
export function navigationKeepsKeyPanel(navigation: Navigation): boolean {
  const { currentUrl, nextUrl, currentParams, nextParams } = navigation;
  return (
    isSamePage(navigation) &&
    currentParams.keyParam === nextParams.keyParam &&
    currentUrl.search !== nextUrl.search &&
    keyPanelSearch(currentUrl) === keyPanelSearch(nextUrl)
  );
}

// The order the panel lists a key's environments in: the same as the page's filter options.
const KEY_PANEL_ENVIRONMENT_ORDER: RuntimeEnvironmentType[] = [
  "DEVELOPMENT",
  "STAGING",
  "PREVIEW",
  "PRODUCTION",
];

/** The environments a key's panel has a row for: every one that isn't a branch, in filter order. */
export function keyPanelEnvironments<
  T extends { type: RuntimeEnvironmentType; parentEnvironmentId: string | null },
>(environments: T[]): T[] {
  return KEY_PANEL_ENVIRONMENT_ORDER.flatMap((type) =>
    environments.filter(
      (environment) => environment.type === type && environment.parentEnvironmentId === null
    )
  );
}

export type EnvironmentVariableKeyCounts = {
  /** "none" when the project has no Preview environment. */
  previewBase: "set" | "unset" | "none";
  /** Preview branches with their own value for the key. */
  branchesSet: number;
  /** Every Preview branch of the project. */
  branches: number;
};

/**
 * Whether a Preview branch's key has a value in the Preview environment itself, which the
 * branch uses once its own value is removed. "unknown" when the data at hand doesn't say.
 */
export type PreviewBaseState = "set" | "unset" | "unknown";

/** Which confirm dialog removing a value gets. */
export type DeleteValueDialog =
  | { kind: "delete" }
  | { kind: "removeOverride"; afterRemoval: "previewValue" | "noValue" | "unknown" };

/**
 * A value of a Preview branch is an override of the Preview value: removing it reads as
 * removing the override, and says what the branch is left with when that's known. Every other
 * value gets the plain delete dialog.
 */
export function deleteValueDialog(
  environment: { type: RuntimeEnvironmentType; branchName: string | null },
  previewBase: PreviewBaseState
): DeleteValueDialog {
  if (environment.type !== "PREVIEW" || !environment.branchName) {
    return { kind: "delete" };
  }

  switch (previewBase) {
    case "set":
      return { kind: "removeOverride", afterRemoval: "previewValue" };
    case "unset":
      return { kind: "removeOverride", afterRemoval: "noValue" };
    case "unknown":
      return { kind: "removeOverride", afterRemoval: "unknown" };
  }
}

/**
 * The Preview base of a key as the list's rows show it. A key's rows always come together on
 * one page, so when the Preview environment is listed, a missing row means no Preview value.
 */
export function listedPreviewBase(
  key: string,
  rows: { key: string; environment: { id: string } }[],
  previewEnvironmentId: string | undefined,
  listedEnvironmentIds: string[]
): PreviewBaseState {
  if (!previewEnvironmentId || !listedEnvironmentIds.includes(previewEnvironmentId)) {
    return "unknown";
  }

  return rows.some((row) => row.key === key && row.environment.id === previewEnvironmentId)
    ? "set"
    : "unset";
}

/**
 * A value edited in place in the key panel, held with its key. "set" adds the first value for an
 * environment that has none; "edit" changes a value that exists.
 */
export type InlineValueEdit = { key: string; environmentId: string; kind: "set" | "edit" };

/**
 * The in-place edit the key panel shows, if any. An edit started on another key's panel doesn't
 * carry over. A set lasts only while its environment has no value: when its save goes through,
 * the panel reloads with the new value, and that value shows as saved rather than opening in an
 * edit.
 */
export function activeInlineValueEdit(
  edit: InlineValueEdit | null,
  key: string,
  hasValue: (environmentId: string) => boolean
): InlineValueEdit | null {
  if (!edit || edit.key !== key) return null;
  if (edit.kind === "set" && hasValue(edit.environmentId)) return null;
  return edit;
}
