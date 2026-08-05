/**
 * `trigger://` URI to dashboard link. The one place that mapping lives, and
 * deliberately transport-independent: no Remix, no request, no `~/db.server`.
 *
 * Also pure. A URI's `{env}` segment carries a RuntimeEnvironment id, but dashboard URLs
 * are built from slugs, so the caller supplies the already-resolved scope instead of
 * this module querying for it. That keeps the part that needs a database at the call
 * site.
 *
 * Paths come from `~/utils/pathBuilder`, never string templates, so a route rename can't
 * silently break agent links.
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
  /**
   * The project's connected repository, when the caller resolved one. Only a `source` URI
   * needs it: the URI carries the commit and the repo-relative path, but "which repo"
   * comes from the GitHub connection or the deployment's git metadata. Omit it and a
   * source URI resolves to nothing, the honest answer for a project with no repo.
   */
  repository?: { fullName?: string | null; remoteUrl?: string | null } | null;
};

export type ResolvedTriggerUri = {
  /** Short human label for the resource, e.g. a run id or a queue name. */
  label: string;
  /** Dashboard path, relative to the app origin, unless `external` is set. */
  url: string;
  /**
   * True when `url` is an absolute link off the dashboard. A host must open it as a link,
   * never hand it to the router.
   */
  external?: boolean;
};

/**
 * Resolve one URI against one environment. Returns `null`, never throwing and never
 * guessing, when the URI is malformed, points at a different project or environment, or
 * names a resource kind with no dashboard page yet.
 *
 * The scope check is the important one: a stored transcript can hold URIs from any
 * project the user has seen, and a link must never resolve a foreign project's id into
 * the current project's URL space.
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

const GITHUB_ORIGIN = "https://github.com";
/** `owner/repo`, GitHub's own character set and nothing that could add a path. */
const FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * The repository's canonical `https://github.com/{owner}/{repo}` base, or null.
 *
 * `fullName` comes off the GitHub connection and is the reliable input. `remoteUrl` is
 * the deployment's git metadata, so it can be an SSH remote or carry credentials, and is
 * normalized the way the deployments UI does it. Anything that isn't github.com is
 * rejected rather than guessed at: a wrong link is worse than no link.
 */
function githubRepoBaseUrl(repository: TriggerUriScope["repository"]): string | null {
  const fullName = repository?.fullName?.trim();
  if (fullName && FULL_NAME.test(fullName)) return `${GITHUB_ORIGIN}/${fullName}`;

  const remoteUrl = repository?.remoteUrl?.trim();
  if (!remoteUrl) return null;

  const normalized = remoteUrl
    .replace(/^git@github\.com:/, `${GITHUB_ORIGIN}/`)
    .replace(/^ssh:\/\/git@github\.com\//, `${GITHUB_ORIGIN}/`)
    .replace(/\.git$/, "");

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com") return null;

  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!FULL_NAME.test(path)) return null;
  return `${GITHUB_ORIGIN}/${path}`;
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
      // The navigate intent's `filters` become URL params at the host; this returns the
      // unfiltered list path.
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
      // The queue detail route is keyed by friendlyId, which a URI does not carry: it
      // carries the rename-stable name. So a queue URI resolves to the queues list
      // filtered to that name, with no lookup and no 404.
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
    case "source": {
      // The URI pins the commit and the repo-relative path, and the connected repo says
      // where that lives. Without a repo connection there is nothing to open, though the
      // label still renders.
      const base = githubRepoBaseUrl(scope.repository);
      const label = parsed.line === undefined ? parsed.path : `${parsed.path}:${parsed.line}`;
      if (!base) return null;
      const path = parsed.path.split("/").map(encodeURIComponent).join("/");
      const fragment = parsed.line === undefined ? "" : `#L${parsed.line}`;
      return {
        label,
        url: `${base}/blob/${encodeURIComponent(parsed.sha)}/${path}${fragment}`,
        external: true,
      };
    }
    // No dashboard page exists for these yet. Returning null makes the caller render a
    // label with no link instead of inventing a URL that 404s.
    case "report":
    case "investigation":
      return null;
    default: {
      const unreachable: never = parsed;
      throw new Error(`Unhandled trigger:// kind: ${JSON.stringify(unreachable)}`);
    }
  }
}
