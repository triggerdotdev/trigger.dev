import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";
import { environmentTypeForFilter, parseEnvironmentVariablesFilter } from "./environmentFilter";
import {
  KEY_PANEL_BRANCH_PAGE_PARAM,
  KEY_PANEL_BRANCH_SEARCH_PARAM,
} from "./environmentVariableKey";
import { v3EnvironmentVariablesAttentionPath } from "~/utils/pathBuilder";

// The needs-attention page: one environment's keys that are empty, missing, changed recently or
// could be replaced with OIDC.

export const ATTENTION_KINDS = ["empty", "missing", "recent", "oidc"] as const;

/**
 * `empty`: values that are empty or only whitespace (secrets included). `missing`: keys set in
 * another root environment (Dev, Staging, Prod) but not in this one. `recent`: values updated in
 * the last `RECENT_ATTENTION_WINDOW_MS`. `oidc`: keys an OIDC setup could replace (deployed
 * environments only).
 */
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** The search param for the picked kind. Without one the page lists every kind. */
export const ATTENTION_KIND_PARAM = "kind";

/** How far back "Changed recently" looks. */
export const RECENT_ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The kinds a team can ignore. "Changed recently" clears itself after a day. */
export const IGNORABLE_ATTENTION_KINDS = ["empty", "missing", "oidc"] as const;

export type IgnorableAttentionKind = (typeof IGNORABLE_ATTENTION_KINDS)[number];

export function isIgnorableAttentionKind(kind: AttentionKind): kind is IgnorableAttentionKind {
  return (IGNORABLE_ATTENTION_KINDS as readonly string[]).includes(kind);
}

/** The page's last tab: the reasons the team ignored, which the other tabs leave out. */
export const IGNORED_ATTENTION_VIEW = "ignored";

/** What the page lists: one kind, or the ignored reasons. */
export type AttentionView = AttentionKind | typeof IGNORED_ATTENTION_VIEW;

export function parseAttentionKind(value: unknown): AttentionView | undefined {
  return value === IGNORED_ATTENTION_VIEW
    ? IGNORED_ATTENTION_VIEW
    : ATTENTION_KINDS.find((kind) => kind === value);
}

/** The most reasons one ignore or undo takes. */
const ATTENTION_IGNORE_LIMIT = 100;

/** One reason of one key in one environment, as an ignore or undo request names it. */
export const AttentionIgnoreItem = z.object({
  variableId: z.string().min(1),
  environmentId: z.string().min(1),
  reason: z.enum(IGNORABLE_ATTENTION_KINDS),
});

export type AttentionIgnoreItem = z.infer<typeof AttentionIgnoreItem>;

/** The page's ignore and undo forms. */
export const AttentionIgnoreForm = z.object({
  action: z.enum(["ignore-reasons", "unignore-reasons"]),
  // The key open in the key panel, to return to it.
  panelKey: z.string().optional(),
  items: z
    .array(AttentionIgnoreItem)
    .min(1, "Select at least one reason.")
    .max(
      ATTENTION_IGNORE_LIMIT,
      `At most ${ATTENTION_IGNORE_LIMIT} reasons can be changed at once.`
    ),
});

// `env` picks the environment. `env` and `branch` are also the list's filter, kept for the way
// back to it.
const ATTENTION_VIEW_SEARCH_PARAMS = ["env", "branch", ATTENTION_KIND_PARAM, "search", "page"];

/** The page's own search params from a URL, as a query string ("?..." or ""). */
export function attentionViewSearch(
  url: string | URL | URLSearchParams,
  alsoKeep: string[] = []
): string {
  const searchParams = url instanceof URLSearchParams ? url : new URL(url).searchParams;
  const kept = new URLSearchParams();
  for (const name of [...ATTENTION_VIEW_SEARCH_PARAMS, ...alsoKeep]) {
    for (const value of searchParams.getAll(name)) {
      if (value) {
        kept.append(name, value);
      }
    }
  }
  const search = kept.toString();
  return search ? `?${search}` : "";
}

const ATTENTION_PATH = /^(.*\/environment-variables\/attention)(?:\/|$)/;

/** The page's path when `pathname` is the page or a route under it (its key panel). */
export function attentionPagePath(pathname: string): string | undefined {
  return ATTENTION_PATH.exec(pathname)?.[1];
}

/**
 * Where an action posted from the page (or its key panel) sends the user back to: the same view,
 * with the panel still open on `panelKey` when given. Undefined when the request didn't come from
 * the page, so the list's own redirects apply. The path is built from the route's params; the
 * request's path only says whether it came from the page.
 */
export function attentionReturnPath(
  url: string,
  params: { organizationSlug: string; projectParam: string; envParam: string },
  panelKey?: string
): string | undefined {
  const parsed = new URL(url);
  if (!attentionPagePath(parsed.pathname)) {
    return undefined;
  }
  const base = v3EnvironmentVariablesAttentionPath(
    { slug: params.organizationSlug },
    { slug: params.projectParam },
    { slug: params.envParam }
  );
  return panelKey !== undefined
    ? `${base}/key/${encodeURIComponent(panelKey)}${attentionViewSearch(parsed, [
        KEY_PANEL_BRANCH_SEARCH_PARAM,
        KEY_PANEL_BRANCH_PAGE_PARAM,
      ])}`
    : `${base}${attentionViewSearch(parsed)}`;
}

type AttentionEnvironment = {
  id: string;
  type: RuntimeEnvironmentType;
  parentEnvironmentId: string | null;
};

/**
 * The environment the page looks at: the root environment `env` names (Preview: the Preview base),
 * unless the list it came from showed All or named branches. Then the current environment, or its
 * Preview base when it is a branch.
 */
export function attentionTargetEnvironment<T extends AttentionEnvironment>({
  environments,
  env,
  branches,
  currentEnvironmentId,
  currentEnvironmentType,
}: {
  environments: T[];
  env: string | undefined;
  branches: string[];
  currentEnvironmentId?: string;
  /** The current environment's type, for when it isn't in `environments` (an archived branch). */
  currentEnvironmentType?: RuntimeEnvironmentType;
}): T | undefined {
  const root = (type: RuntimeEnvironmentType | undefined) =>
    environments.find(
      (environment) => environment.type === type && environment.parentEnvironmentId === null
    );
  const filter = parseEnvironmentVariablesFilter(env);
  const namesBranches = branches.some((branch) => branch !== "all");
  if (filter && filter !== "all" && !(filter === "preview" && namesBranches)) {
    const picked = root(environmentTypeForFilter(filter));
    if (picked) {
      return picked;
    }
  }
  const current = environments.find((environment) => environment.id === currentEnvironmentId);
  return (
    root(current?.type ?? currentEnvironmentType) ??
    environments.find((e) => !e.parentEnvironmentId)
  );
}

/**
 * The environments "Missing here" looks in for keys `target` lacks: every other root Dev, Staging
 * and Prod environment (Dev is only the user's own).
 */
export function missingAttentionSources<T extends AttentionEnvironment>(
  target: { id: string },
  environments: T[]
): T[] {
  return environments.filter(
    (environment) =>
      environment.id !== target.id &&
      environment.parentEnvironmentId === null &&
      environment.type !== "PREVIEW"
  );
}
