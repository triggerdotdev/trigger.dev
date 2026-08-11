/**
 * `trigger://` URI to dashboard link. Pure: a URI's `{env}` is a RuntimeEnvironment id but
 * dashboard URLs need slugs, so the caller supplies the already-resolved scope.
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

/** Structurally satisfied by `AuthenticatedEnvironment`. */
export type TriggerUriScope = {
  /** RuntimeEnvironment id. Must match the URI's `{env}` segment. */
  id: string;
  slug: string;
  project: { slug: string; externalRef: string };
  organization: { slug: string };
  /** Only a `source` URI needs this. Omitted, a source URI resolves to nothing. */
  repository?: { fullName?: string | null; remoteUrl?: string | null } | null;
};

export type ResolvedTriggerUri = {
  label: string;
  /** Dashboard path, relative to the app origin, unless `external` is set. */
  url: string;
  /** True when `url` is absolute and off the dashboard, so a host must not route it. */
  external?: boolean;
};

/**
 * Resolve one URI against one environment, returning `null` rather than guessing. A stored
 * transcript can hold foreign URIs, which must never resolve into this project's URL space.
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
 * The repository's canonical `https://github.com/{owner}/{repo}` base, or null. `remoteUrl` is
 * normalized as the deployments UI does; anything but github.com is rejected, not guessed at.
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
      // The navigate intent's `filters` become URL params at the host.
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
      // The queue detail route is keyed by friendlyId, which a URI doesn't carry, so this
      // resolves to the queues list filtered to the name.
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
      // The URI pins the commit and repo-relative path; the connected repo says where that
      // lives. Without a connection there is nothing to open.
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
    // No dashboard page exists for these yet, so the caller renders a label with no link.
    case "report":
    case "investigation":
      return null;
    default: {
      const unreachable: never = parsed;
      throw new Error(`Unhandled trigger:// kind: ${JSON.stringify(unreachable)}`);
    }
  }
}
