import { CloudArrowUpIcon } from "@heroicons/react/20/solid";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { GitBranchIcon, GitCommitIcon, TerminalIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { RelativeDateTime } from "~/components/primitives/DateTime";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import { Spinner } from "~/components/primitives/Spinner";
import { DeploymentStatus } from "~/components/runs/v3/DeploymentStatus";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { VersionDetail, VersionSource } from "~/presenters/v3/VersionPresenter.server";
import { cn } from "~/utils/cn";
import { v3DeploymentPath, v3EnvironmentPath, v3RunsPath } from "~/utils/pathBuilder";
import { versionStanding, type VersionStanding } from "~/utils/versionLabel";

// The environment's current version, loaded once by the page and read by every label on it.
const CurrentVersionContext = createContext<string | undefined>(undefined);

export function CurrentVersionProvider({
  currentVersion,
  children,
}: {
  currentVersion: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <CurrentVersionContext.Provider value={currentVersion ?? undefined}>
      {children}
    </CurrentVersionContext.Provider>
  );
}

export function StandingBadge({ standing }: { standing: VersionStanding | undefined }) {
  if (standing === "current") return <Badge variant="extra-small">Current</Badge>;
  if (standing === "not-promoted")
    return (
      <Badge variant="extra-small" className="text-text-dimmed">
        Not promoted
      </Badge>
    );
  return null;
}

/**
 * A version wherever the dashboard shows one: the version string, its Current or Not promoted
 * tag, and a popover with how it was made, its tasks and links. The current version comes from
 * the nearest CurrentVersionProvider unless passed in.
 */
export function VersionLabel({
  version,
  currentVersion,
  environment,
  className,
  openOnHover = false,
}: {
  version: string;
  currentVersion?: string;
  /**
   * The environment the version belongs to, when it may not be the page's (a replay's runs listed
   * under the source environment). Version numbers are per environment.
   */
  environment?: VersionEnvironment;
  className?: string;
  /** Hover only, no button: a click passes through (e.g. to a table row's link). */
  openOnHover?: boolean;
}) {
  const fromPage = useContext(CurrentVersionContext);
  const pageEnvironment = useEnvironment();
  // The page's current version says nothing about a version in another environment: no tag on
  // the label there, and the card shows that environment's own standing once it loads.
  const elsewhere = environment !== undefined && environment.id !== pageEnvironment.id;
  const standing = versionStanding(version, currentVersion ?? (elsewhere ? undefined : fromPage));
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const hoverTo = (next: boolean) => () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), next ? 250 : 150);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const label = (
    <>
      <span className="underline decoration-charcoal-500 decoration-dotted underline-offset-4 transition group-hover:text-text-bright group-hover:decoration-text-dimmed">
        {version}
      </span>
      <StandingBadge standing={standing} />
    </>
  );
  const content = (
    <PopoverContent
      align="start"
      className="w-[22rem] min-w-0 p-0"
      onOpenAutoFocus={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
      onPointerEnter={hoverTo(true)}
      onPointerLeave={hoverTo(false)}
    >
      {open ? (
        <VersionPopoverBody
          version={version}
          standing={standing}
          environment={elsewhere ? environment : undefined}
        />
      ) : null}
    </PopoverContent>
  );

  if (openOnHover) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <span
            onPointerEnter={hoverTo(true)}
            onPointerLeave={hoverTo(false)}
            className={cn("group inline-flex items-center gap-1.5", className)}
          >
            {label}
          </span>
        </PopoverAnchor>
        {content}
      </Popover>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onPointerEnter={hoverTo(true)}
        onPointerLeave={hoverTo(false)}
        onClick={(e) => {
          // Keyboard and touch open it with a click; a hover may already have opened it, so don't toggle shut.
          e.preventDefault();
          e.stopPropagation();
          clearTimeout(timer.current);
          setOpen(true);
        }}
        className={cn(
          "group inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-left focus-custom",
          className
        )}
      >
        {label}
      </PopoverTrigger>
      {content}
    </Popover>
  );
}

type VersionDetailJson = Omit<VersionDetail, "source"> & {
  source: Omit<VersionSource, "at"> & { at: string };
};

type VersionEnvironment = { id: string; slug: string; type: RuntimeEnvironmentType };

function useVersionPaths(elsewhere?: VersionEnvironment) {
  const organization = useOrganization();
  const project = useProject();
  const pageEnvironment = useEnvironment();
  const environment = elsewhere ?? pageEnvironment;
  return {
    environment,
    resource: (version: string) =>
      `/resources${v3EnvironmentPath(organization, project, environment)}/versions/${encodeURIComponent(version)}`,
    runs: (version: string) =>
      v3RunsPath(organization, project, environment, { versions: [version] }),
    deployment: (shortCode: string) =>
      v3DeploymentPath(organization, project, environment, { shortCode }, 0),
  };
}

// Browser-side, per page session, for 60s: hovering the same version again (e.g. down the runs
// list) reuses the answer instead of fetching again, and a promotion shows up within a minute.
// Concurrent hovers share one request; a failed fetch isn't kept, so the next hover retries.
const VERSION_DETAIL_TTL_MS = 60_000;
type CachedVersionDetail = {
  at: number;
  detail?: VersionDetailJson | null;
  request: Promise<VersionDetailJson | null>;
};
const versionDetailCache = new Map<string, CachedVersionDetail>();

function freshVersionDetail(resource: string): CachedVersionDetail | undefined {
  const entry = versionDetailCache.get(resource);
  if (entry && Date.now() - entry.at < VERSION_DETAIL_TTL_MS) return entry;
  versionDetailCache.delete(resource);
  return undefined;
}

function loadVersionDetail(resource: string): Promise<VersionDetailJson | null> {
  const cached = freshVersionDetail(resource);
  if (cached) return cached.request;
  const entry: CachedVersionDetail = {
    at: Date.now(),
    request: fetch(resource)
      .then((r) => {
        if (!r.ok) throw new Error(`version detail ${r.status}`);
        return r.json() as Promise<{ detail: VersionDetailJson | null }>;
      })
      .then((d) => (entry.detail = d.detail ?? null))
      .catch(() => {
        versionDetailCache.delete(resource);
        return null;
      }),
  };
  versionDetailCache.set(resource, entry);
  return entry.request;
}

function VersionPopoverBody({
  version,
  standing,
  environment,
}: {
  version: string;
  standing: VersionStanding;
  environment?: VersionEnvironment;
}) {
  const paths = useVersionPaths(environment);
  const resource = paths.resource(version);
  // undefined while loading, null when the version can't be shown.
  const [detail, setDetail] = useState<VersionDetailJson | null | undefined>(
    () => freshVersionDetail(resource)?.detail
  );

  // The body mounts each time the card opens, so state starts from the cache; fetch only on a miss.
  useEffect(() => {
    if (detail !== undefined) return;
    let live = true;
    loadVersionDetail(resource).then((d) => live && setDetail(d));
    return () => {
      live = false;
    };
  }, [resource, detail]);

  const isDev = paths.environment.type === "DEVELOPMENT";

  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <CopyableText value={version} className="text-sm font-medium text-text-bright" />
        <StandingBadge standing={detail?.standing ?? standing} />
      </div>
      {detail === undefined ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-text-dimmed">
          <Spinner className="size-3.5" /> Loading version
        </div>
      ) : detail === null ? (
        <div className="px-3 pb-3 pt-1.5 text-xs text-text-dimmed">
          Couldn't load {version} in this environment.
        </div>
      ) : (
        <>
          <div className="px-3 pb-2.5 pt-1.5">
            <VersionHeadline detail={detail} />
            <VersionSourceMeta source={detail.source} className="mt-1" />
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-grid-dimmed px-3 py-2.5 text-xs">
            {detail.deployment ? (
              <>
                <span className="text-text-dimmed">Build</span>
                <span className="flex min-w-0 items-center gap-2">
                  <DeploymentStatus status={detail.deployment.status} isBuilt={false} />
                  {detail.source.buildMs !== null ? (
                    <span className="text-text-dimmed">
                      in {formatDurationMilliseconds(detail.source.buildMs, { style: "short" })}
                    </span>
                  ) : null}
                </span>
              </>
            ) : null}
            <span className="text-text-dimmed">
              {detail.deployment ? "Deployed by" : "Built by"}
            </span>
            <VersionAuthor source={detail.source} />
            <span className="text-text-dimmed">Tasks</span>
            <span className="flex flex-wrap items-center gap-1.5 text-text-bright">
              {detail.tasksCount}
              <TaskDiffChips added={detail.added} removed={detail.removed} />
              {detail.previousVersion && (detail.added.length || detail.removed.length) ? (
                <span className="text-text-dimmed">vs {detail.previousVersion}</span>
              ) : null}
            </span>
            {detail.sdkVersion ? (
              <>
                <span className="text-text-dimmed">SDK</span>
                <span className="text-text-bright">
                  {detail.sdkVersion}
                  {detail.cliVersion ? (
                    <span className="text-text-dimmed"> (CLI {detail.cliVersion})</span>
                  ) : null}
                </span>
              </>
            ) : null}
            <span className="text-text-dimmed">New runs</span>
            <span className="text-text-bright">{newRunsLine(detail, isDev)}</span>
          </div>
          <div className="flex gap-2 border-t border-grid-dimmed px-3 py-2">
            <LinkButton variant="secondary/small" to={paths.runs(version)}>
              View runs on this version
            </LinkButton>
            {detail.deployment ? (
              <LinkButton
                variant="tertiary/small"
                to={paths.deployment(detail.deployment.shortCode)}
              >
                View deployment
              </LinkButton>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}

function newRunsLine(detail: VersionDetailJson, isDev: boolean) {
  if (detail.standing === "current") return "Start on this version.";
  if (!detail.currentVersion) return "No version is current yet.";
  if (detail.standing === "not-promoted")
    return `Start on ${detail.currentVersion}. This one is deployed but not promoted.`;
  if (isDev) return `Start on ${detail.currentVersion}, your newest version.`;
  return `Start on ${detail.currentVersion}. Runs that started here stay here, retries included.`;
}

/** The readable line of a version: the commit message for a deploy, the task change for a dev rebuild. */
function VersionHeadline({ detail }: { detail: VersionDetailJson }) {
  const { source, added, removed } = detail;
  if (source.commitMessage) {
    return (
      <span className="line-clamp-2 block text-sm text-text-bright" title={source.commitMessage}>
        {source.commitMessage}
      </span>
    );
  }
  if (source.kind === "deploy") {
    return <span className="block text-sm text-text-dimmed">No commit info for this deploy</span>;
  }
  const parts = [
    added.length ? `Added ${added.join(", ")}` : null,
    removed.length ? `${added.length ? "removed" : "Removed"} ${removed.join(", ")}` : null,
  ].filter(Boolean);
  return (
    <span className="line-clamp-2 block text-sm text-text-bright">
      {parts.length
        ? parts.join("; ")
        : detail.previousVersion
          ? "Code changes, same tasks"
          : "First version"}
    </span>
  );
}

/** Branch, commit and how the version arrived, as one dimmed line. */
function VersionSourceMeta({
  source,
  className,
}: {
  source: VersionDetailJson["source"];
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-text-dimmed",
        className
      )}
    >
      {source.branch ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          <GitBranchIcon className="size-3.5 shrink-0" />
          <MaybeLink to={source.branchUrl} className="truncate">
            {source.branch}
          </MaybeLink>
        </span>
      ) : null}
      {source.shortSha ? (
        <span className="inline-flex items-center gap-1">
          <GitCommitIcon className="size-3.5 shrink-0" />
          <MaybeLink to={source.commitUrl} className="font-mono">
            {source.shortSha}
          </MaybeLink>
          {source.dirty ? <span title="Uncommitted changes">+ changes</span> : null}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1">
        {source.kind === "dev" ? (
          <>
            <TerminalIcon className="size-3.5 shrink-0" />
            <span className="font-mono">trigger dev</span>
          </>
        ) : (
          <>
            <CloudArrowUpIcon className="size-3.5 shrink-0" />
            <span>via {source.via}</span>
          </>
        )}
      </span>
    </span>
  );
}

function MaybeLink({
  to,
  className,
  children,
}: {
  to: string | null;
  className?: string;
  children: ReactNode;
}) {
  // These URLs are built from git metadata the deploying client sent: link only to http(s).
  if (!to || !/^https?:\/\//i.test(to)) return <span className={className}>{children}</span>;
  return (
    <a
      href={to}
      target="_blank"
      rel="noreferrer"
      className={cn("transition hover:text-text-bright hover:underline", className)}
    >
      {children}
    </a>
  );
}

function VersionAuthor({ source }: { source: VersionDetailJson["source"] }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      <UserAvatar
        avatarUrl={source.author?.avatarUrl}
        name={source.author?.name}
        className="size-4 shrink-0"
      />
      <span className="truncate text-text-bright">{source.author?.name ?? "Unknown"}</span>
      <span className="shrink-0 text-text-dimmed">
        <RelativeDateTime date={new Date(source.at)} />
      </span>
    </span>
  );
}

// A big deploy can add dozens of tasks: show a few, then a count.
const MAX_TASK_DIFF_CHIPS = 3;

function TaskDiffChips({ added, removed }: { added: string[]; removed: string[] }) {
  const changes = [
    ...added.map((slug) => ({ slug, sign: "+" as const })),
    ...removed.map((slug) => ({ slug, sign: "−" as const })),
  ];
  const shown = changes.slice(0, MAX_TASK_DIFF_CHIPS);
  const hidden = changes.length - shown.length;
  return (
    <>
      {shown.map(({ slug, sign }) => (
        <span
          key={`${sign}${slug}`}
          className={cn(
            "rounded-sm px-1 font-mono text-xxs",
            sign === "+" ? "bg-success/10 text-success" : "bg-error/10 text-error"
          )}
        >
          {sign}
          {slug}
        </span>
      ))}
      {hidden > 0 ? <span className="text-xxs text-text-dimmed">+{hidden} more</span> : null}
    </>
  );
}
