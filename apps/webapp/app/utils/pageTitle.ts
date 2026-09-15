import type { MetaDescriptor, MetaFunction } from "@remix-run/node";
import type { UseDataFunctionReturn } from "remix-typedjson";
import { appEnvTitleTag } from "~/utils";

/**
 * Tab titles. Every page exports `export const meta = pageMeta(...)` and only says what the page
 * is; the app title is added here.
 *
 * Shape (leading words carry the information, so a narrow tab still reads):
 *   env page:   `Runs | Trigger.dev`
 *   env entity: `run_abc | Runs | Trigger.dev`
 *   org page:   `Team | Acme | Trigger.dev`
 *   else:       `Login to Trigger.dev` etc.
 *
 * Remix v2 picks the meta of the deepest route that exports one; a route without a meta export
 * inherits its nearest ancestor's. So a layout's `pageMeta` is the fallback for children that
 * don't declare their own, and non-title tags from the root (viewport, robots) are carried over
 * here rather than re-declared per route.
 */

const APP_NAME = "Trigger.dev";

/** The org route carries the organization the URL resolved to. */
const ORGANIZATION_MATCH_ID = "routes/_app.orgs.$organizationSlug";

/** One or more title segments, most specific first: `["run_abc", "Runs"]`. */
type TitleSegments = string | string[];

type MetaArgs = Parameters<MetaFunction>[0];
type Matches = MetaArgs["matches"];

type PageInput<TLoader> =
  | TitleSegments
  | ((args: {
      data: UseDataFunctionReturn<TLoader> | undefined;
      params: Record<string, string | undefined>;
    }) => TitleSegments | undefined);

/** The title used when no page declares one. */
export function appTitle(appEnv?: string): string {
  return `${APP_NAME}${appEnvTitleTag(appEnv)}`;
}

/**
 * Declares this page's tab title. Pass a string (or segments), or a function of the route's
 * loader data and params for entity pages.
 */
export function pageMeta<TLoader = unknown>(page: PageInput<TLoader>): MetaFunction {
  return ({ data, params, matches }) => {
    const segments = resolveSegments(
      page,
      data as UseDataFunctionReturn<TLoader> | undefined,
      params
    );
    return [...inheritedMeta(matches), { title: composePageTitle(segments, matches) }];
  };
}

/** Builds the full title from the page segments, the org scope and the app title. */
function composePageTitle(segments: string[], matches: Matches): string {
  return [...segments, scopeFromMatches(matches), appTitle(appEnvFromMatches(matches))]
    .filter((segment): segment is string => Boolean(segment))
    .join(" | ");
}

/**
 * The organization, and only on its own pages: inside a project the tab is already about one
 * project, and the dashboard switches projects in every tab at once, so naming it adds nothing.
 */
function scopeFromMatches(matches: Matches): string | undefined {
  const match = matches.find((m) => m.id === ORGANIZATION_MATCH_ID);
  if (!match || match.params?.projectParam) return undefined;
  const data = match.data as { organization?: { title?: string | null } } | undefined;
  return data?.organization?.title ?? undefined;
}

function appEnvFromMatches(matches: Matches): string | undefined {
  const rootData = matches[0]?.data as { appEnv?: string } | undefined;
  return rootData?.appEnv;
}

/** Non-title tags (viewport, robots) from the nearest ancestor, which Remix would otherwise drop. */
function inheritedMeta(matches: Matches): MetaDescriptor[] {
  const parent = matches[matches.length - 2];
  return (parent?.meta ?? []).filter((descriptor) => !("title" in descriptor));
}

function resolveSegments<TLoader>(
  page: PageInput<TLoader>,
  data: UseDataFunctionReturn<TLoader> | undefined,
  params: Record<string, string | undefined>
): string[] {
  const resolved = typeof page === "function" ? safeResolve(() => page({ data, params })) : page;
  if (!resolved) return [];
  return (Array.isArray(resolved) ? resolved : [resolved]).filter(Boolean);
}

// Loader data can be missing (error boundaries, redirects), so a bad lookup must not break the page.
function safeResolve(resolve: () => TitleSegments | undefined): TitleSegments | undefined {
  try {
    return resolve();
  } catch {
    return undefined;
  }
}
