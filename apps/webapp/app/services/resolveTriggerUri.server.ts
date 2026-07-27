/**
 * `trigger://` URI -> dashboard link.
 *
 * The agent points at resources with `trigger://` URIs (rename-stable, frozen
 * grammar); a human needs a label and a URL. This module is the one place that
 * mapping lives, and it is deliberately transport-independent: no Remix, no
 * request, no `~/db.server`. Whatever surface needs a link — the panel, an MCP
 * tool, a Slack unfurl later — calls the same function and gets the same answer.
 *
 * It is also **pure**. The `{env}` segment of a URI carries a RuntimeEnvironment
 * *id*, but dashboard URLs are built from org/project/env *slugs*, so the caller
 * supplies the already-resolved scope (an `AuthenticatedEnvironment` satisfies it
 * structurally) instead of this module querying for it. That keeps id -> slug
 * resolution — the part that needs a database — at the call site, where the
 * environment is already loaded anyway.
 *
 * Paths come from `~/utils/pathBuilder`, never from string templates, so a route
 * rename can't silently break agent links.
 */
import {
  safeParseTriggerUri,
  type ParsedTriggerUri,
  type TriggerUri,
} from "@internal/dashboard-agent-contracts";
import {
  v3DeploymentVersionPath,
  v3ErrorPath,
  v3QueuesPath,
  v3RunPath,
  v3RunSpanPath,
  v3RunsPath,
} from "~/utils/pathBuilder";

/**
 * The resolved environment a URI is read against. Structurally satisfied by
 * `AuthenticatedEnvironment`, so route handlers and services can pass the
 * environment they already have.
 */
export type TriggerUriScope = {
  /** RuntimeEnvironment id — must match the URI's `{env}` segment. */
  id: string;
  /** Environment slug, for the URL. */
  slug: string;
  project: { slug: string; externalRef: string };
  organization: { slug: string };
};

export type ResolvedTriggerUri = {
  /** Short human label for the resource, e.g. a run id or a queue name. */
  label: string;
  /** Dashboard path, relative to the app origin. */
  url: string;
};

/**
 * Resolve one URI against one environment. Returns `null` — never throws, never
 * guesses — when the URI is malformed, points at a different project or
 * environment, or names a resource kind with no dashboard page yet.
 *
 * The scope check is the important one: a stored transcript can hold URIs from
 * any project the user has seen, and a link must never resolve a foreign
 * project's id into the current project's URL space.
 */
export function resolveTriggerUri(
  scope: TriggerUriScope,
  uri: TriggerUri | string
): ResolvedTriggerUri | null {
  const parsed = safeParseTriggerUri(uri);
  if (!parsed.success) return null;
  if (!isInScope(scope, parsed.data)) return null;
  return resolveInScope(scope, parsed.data);
}

/** True when the URI names this exact project and environment. */
function isInScope(scope: TriggerUriScope, parsed: ParsedTriggerUri): boolean {
  return parsed.projectRef === scope.project.externalRef && parsed.environmentId === scope.id;
}

function resolveInScope(
  scope: TriggerUriScope,
  parsed: ParsedTriggerUri
): ResolvedTriggerUri | null {
  const { organization, project } = scope;
  const environment = { slug: scope.slug };

  switch (parsed.kind) {
    case "runs":
      // The runs collection; the navigate intent's `filters` become URL params
      // at the host (this resolver returns the unfiltered list path).
      return {
        label: "Runs",
        url: v3RunsPath(organization, project, environment),
      };
    case "run":
      return {
        label: parsed.runId,
        url: v3RunPath(organization, project, environment, { friendlyId: parsed.runId }),
      };
    case "span":
      return {
        label: `${parsed.runId} (${parsed.spanId})`,
        url: v3RunSpanPath(
          organization,
          project,
          environment,
          { friendlyId: parsed.runId },
          { spanId: parsed.spanId }
        ),
      };
    case "error":
      return {
        label: parsed.fingerprint,
        url: v3ErrorPath(organization, project, environment, { fingerprint: parsed.fingerprint }),
      };
    case "queue":
      // The queue detail route is keyed by friendlyId, which a URI (correctly)
      // does not carry — it carries the rename-stable queue *name*. So a queue
      // URI resolves to the queues list filtered to that name: no lookup, no
      // 404, and the user lands on the queue they asked for.
      return {
        label: parsed.name,
        url: `${v3QueuesPath(organization, project, environment)}?query=${encodeURIComponent(
          parsed.name
        )}`,
      };
    case "deployment":
      return {
        label: parsed.version,
        url: v3DeploymentVersionPath(organization, project, environment, parsed.version),
      };
    // No dashboard page exists for these yet. Returning null keeps the caller
    // honest (it renders a label with no link) instead of inventing a URL that
    // 404s. Add a case here the day the page ships.
    case "report":
    case "source":
    case "investigation":
      return null;
    default: {
      const unreachable: never = parsed;
      throw new Error(`Unhandled trigger:// kind: ${JSON.stringify(unreachable)}`);
    }
  }
}
