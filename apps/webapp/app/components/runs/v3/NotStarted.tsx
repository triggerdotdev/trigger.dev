import { VersionLabel } from "~/components/versions/VersionLabel";
import { Disclosure } from "@headlessui/react";
import {
  ArrowUturnLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  LockClosedIcon,
  NoSymbolIcon,
  PauseIcon,
  RectangleStackIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import { DeploymentsIcon } from "~/assets/icons/DeploymentsIcon";
import { InvestigateButton } from "~/components/dashboard-agent/InvestigateButton";
import {
  pendingVersionRunPrompt,
  waitingRunPrompt,
} from "~/components/dashboard-agent/investigate-prompts";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyButton } from "~/components/primitives/CopyButton";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { Spinner } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { QueuePauseResumeButton } from "~/components/queues/QueueControls";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  type NotStarted,
  type NotStartedAction,
  type NotStartedGroup,
  type RunWaitingView,
  type WaitingVersion,
  waitingPollDelayMs,
} from "~/presenters/v3/runWaiting";
import type { loader as waitingLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.waiting";
import { cn } from "~/utils/cn";
import {
  concurrencyPath,
  concurrencyLimitsPath,
  concurrencyQueuePath,
  v3BillingLimitsPath,
  v3DeploymentPath,
  v3RunPath,
  v3RunsPath,
} from "~/utils/pathBuilder";
import { CancelRunDialog } from "./CancelRunDialog";
import { ReplayRunDialog } from "./ReplayRunDialog";

/**
 * The run's not-started view, polled while the run waits, from the span loader's copy. Null once
 * it starts. A tick says which status the view was built from, so the route only reads the live
 * counts again while the run stays in it; coming back to the tab loads everything.
 */
function useLiveNotStarted(initial: RunWaitingView, runFriendlyId: string): RunWaitingView | null {
  const path = useWaitingPath(runFriendlyId);
  const fetcher = useTypedFetcher<typeof waitingLoader>();
  const [view, setView] = useState<RunWaitingView | null>(initial);

  // The span loader sent a new copy: start again from it.
  const [seenInitial, setSeenInitial] = useState(initial);
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    setView(initial);
  }

  // A tick answered. "Unchanged" keeps the view; a counts-only answer keeps its permissions.
  const [seenData, setSeenData] = useState(fetcher.data);
  if (fetcher.data !== seenData) {
    setSeenData(fetcher.data);
    const data = fetcher.data;
    if (data && !data.unchanged) {
      setView(
        data.view && data.countsOnly && view
          ? { ...data.view, canManageQueues: view.canManageQueues }
          : data.view
      );
    }
  }

  const latest = useRef({ view, fetcher });
  useEffect(() => {
    latest.current = { view, fetcher };
  });

  // An expired run won't change, so there's nothing to poll for.
  const live = initial.notStarted.cause !== "externalExpired";
  useEffect(() => {
    if (!live) return;

    const load = (everything: boolean) => {
      const { view, fetcher } = latest.current;
      if (fetcher.state !== "idle") return;
      if (everything || !view) return fetcher.load(path);

      const have = new URLSearchParams({ have: view.status });
      if (view.usualWait?.p50Ms != null) have.set("p50", String(view.usualWait.p50Ms));
      if (view.usualWait?.p95Ms != null) have.set("p95", String(view.usualWait.p95Ms));
      fetcher.load(`${path}?${have}`);
    };

    const openedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (document.visibilityState === "visible") load(false);
      timer = setTimeout(tick, waitingPollDelayMs(Date.now() - openedAt));
    };
    timer = setTimeout(tick, waitingPollDelayMs(0));

    const onVisible = () => {
      if (document.visibilityState === "visible") load(true);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, live]);

  return view;
}

function useWaitingPath(runFriendlyId: string) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  return `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/${runFriendlyId}/waiting`;
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function shortDuration(ms: number) {
  return formatDurationMilliseconds(Math.max(0, ms), { style: "short", maxDecimalPoints: 0 });
}

// ---------------------------------------------------------------------------------------------
// The groups: one icon and one color each. "Won't start" is the only red one: today it's the most
// urgent case and looked the most harmless.

type GroupStyle = {
  icon: ComponentType<{ className?: string }>;
  text: string;
  tint: string;
  border: string;
  rail: string;
};

const GROUP_STYLES: Record<NotStartedGroup, GroupStyle> = {
  startingSoon: {
    icon: RectangleStackIcon,
    text: "text-text-dimmed",
    tint: "bg-charcoal-750/60 light:bg-charcoal-100",
    border: "border-grid-bright",
    rail: "bg-charcoal-500",
  },
  delayed: {
    icon: ClockIcon,
    text: "text-text-dimmed",
    tint: "bg-charcoal-750/60 light:bg-charcoal-100",
    border: "border-grid-bright",
    rail: "bg-charcoal-500",
  },
  atLimit: {
    icon: ConcurrencyIcon,
    text: "text-concurrency",
    tint: "bg-concurrency/10",
    border: "border-concurrency/30",
    rail: "bg-concurrency",
  },
  paused: {
    icon: PauseIcon,
    text: "text-amber-300 light:text-amber-600",
    tint: "bg-amber-300/10",
    border: "border-amber-300/30",
    rail: "bg-amber-300",
  },
  needsDeploy: {
    icon: DeploymentsIcon,
    text: "text-deployments",
    tint: "bg-deployments/10",
    border: "border-deployments/30",
    rail: "bg-deployments",
  },
  wontStart: {
    icon: NoSymbolIcon,
    text: "text-error",
    tint: "bg-error/10",
    border: "border-error/40",
    rail: "bg-error",
  },
};

/** The group in place of the run status: icon and name, the API status in the tooltip. */
export function NotStartedStatus({
  notStarted,
  className,
}: {
  notStarted: NotStarted;
  className?: string;
}) {
  const style = GROUP_STYLES[notStarted.group];
  const Icon = style.icon;
  return (
    <SimpleTooltip
      button={
        <span className={cn("flex items-center gap-1", className)}>
          <Icon className={cn("size-4 shrink-0", style.text)} />
          <span className={style.text}>{notStarted.label}</span>
        </span>
      }
      content={
        <span className="flex flex-col gap-1">
          <span>{notStarted.reason}</span>
          <span className="text-text-dimmed">API status: {notStarted.apiStatus}</span>
        </span>
      }
    />
  );
}

function Deadline({
  at,
  now,
  expired,
  className,
}: {
  at: Date;
  now: number;
  expired?: boolean;
  className?: string;
}) {
  const far = Math.abs(at.getTime() - now) > 12 * 60 * 60 * 1000;
  const time = (
    <span className="text-text-bright">
      <DateTime date={at} includeSeconds={false} includeDate={far} />
    </span>
  );
  // A deadline that has passed on a run that's still waiting: the expiry check hasn't reached it.
  return (
    <span className={cn("text-text-dimmed", className)}>
      {expired ? (
        <>Expired {time}</>
      ) : at.getTime() <= now ? (
        <>Its expiry time passed at {time}, so it will expire shortly</>
      ) : (
        <>
          Expires {time} if it hasn't started, in {shortDuration(at.getTime() - now)}
        </>
      )}
    </span>
  );
}

function StartsAt({ at, now }: { at: Date; now: number }) {
  const far = Math.abs(at.getTime() - now) > 12 * 60 * 60 * 1000;
  return (
    <span className="text-text-dimmed">
      Starts{" "}
      <span className="text-text-bright">
        <DateTime date={at} includeSeconds={false} includeDate={far} />
      </span>
      {at.getTime() > now ? <>, in {shortDuration(at.getTime() - now)}</> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Actions: one component per action so every option offers the same ones with the same names.

function deployCommand(environmentType: string) {
  switch (environmentType) {
    case "DEVELOPMENT":
      return "npx trigger.dev@latest dev";
    case "STAGING":
      return "npx trigger.dev@latest deploy --env staging";
    case "PREVIEW":
      return "npx trigger.dev@latest deploy --env preview";
    default:
      return "npx trigger.dev@latest deploy";
  }
}

function Command({ command, className }: { command: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-7 min-w-0 items-center gap-2 rounded-sm border border-grid-bright bg-background-dimmed pl-2 pr-0.5",
        className
      )}
    >
      <span className="text-text-faint">$</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-text-bright">{command}</code>
      <CopyButton value={command} size="small" buttonVariant="minimal" />
    </div>
  );
}

function ActionButton({
  action,
  view,
  runFriendlyId,
  primary,
}: {
  action: NotStartedAction;
  view: RunWaitingView;
  runFriendlyId: string;
  primary: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const waitingPath = useWaitingPath(runFriendlyId);
  const runPath = v3RunPath(organization, project, environment, { friendlyId: runFriendlyId });
  const variant = primary ? "primary/small" : "secondary/small";
  const ns = view.notStarted;

  switch (action) {
    case "resumeQueue":
      if (!view.queue.friendlyId) return null;
      return (
        <QueuePauseResumeButton
          queue={{ id: view.queue.friendlyId, name: view.queue.name, paused: true }}
          variant={variant}
          formAction={waitingPath}
          disabled={!view.canManageQueues}
        />
      );
    case "resumeEnvironment":
      return (
        <LinkButton variant={variant} to={concurrencyPath(organization, project, environment)}>
          Resume environment
        </LinkButton>
      );
    case "billingLimits":
      return (
        <LinkButton variant={variant} to={v3BillingLimitsPath(organization)}>
          Billing limits
        </LinkButton>
      );
    case "contactUs":
      return (
        <LinkButton variant={variant} to="https://trigger.dev/contact">
          Contact us
        </LinkButton>
      );
    case "changeLimit":
      if (!view.queue.friendlyId) return null;
      return (
        <LinkButton
          variant={variant}
          to={concurrencyQueuePath(organization, project, environment, {
            friendlyId: view.queue.friendlyId,
          })}
        >
          Change limit
        </LinkButton>
      );
    case "openLimits":
      return (
        <LinkButton
          variant={variant}
          to={concurrencyLimitsPath(organization, project, environment)}
        >
          Concurrency limits
        </LinkButton>
      );
    case "seeRunning":
      if (ns.capacity?.scope === "limit") return null;
      return (
        <LinkButton
          variant={variant}
          to={v3RunsPath(organization, project, environment, {
            statuses: ["DEQUEUED", "EXECUTING"],
            queues: ns.capacity?.scope === "environment" ? undefined : [view.queue.name],
          })}
        >
          See running runs
        </LinkButton>
      );
    case "deploy":
    case "runDev":
      return <Command command={deployCommand(view.environmentType)} className="w-full" />;
    case "replay":
      return (
        <Dialog>
          <DialogTrigger asChild>
            <Button
              variant={primary ? "danger/small" : "secondary/small"}
              LeadingIcon={ArrowUturnLeftIcon}
            >
              Replay on current version
            </Button>
          </DialogTrigger>
          <ReplayRunDialog runFriendlyId={runFriendlyId} failedRedirect={runPath} />
        </Dialog>
      );
    case "cancel":
      return (
        <Dialog>
          <DialogTrigger asChild>
            <Button variant={variant}>Cancel run</Button>
          </DialogTrigger>
          <CancelRunDialog runFriendlyId={runFriendlyId} redirectPath={runPath} />
        </Dialog>
      );
    case "statusPage":
      return (
        <LinkButton variant={variant} to="https://status.trigger.dev">
          Status page
        </LinkButton>
      );
    case "viewDeployment":
      if (!view.deployingVersion) return null;
      return (
        <LinkButton
          variant={variant}
          to={v3DeploymentPath(
            organization,
            project,
            environment,
            { shortCode: view.deployingVersion.shortCode },
            0
          )}
        >
          View deployment
        </LinkButton>
      );
  }
}

function Actions({
  view,
  runFriendlyId,
  className,
}: {
  view: RunWaitingView;
  runFriendlyId: string;
  className?: string;
}) {
  const actions = view.notStarted.actions;
  const commands = actions.filter((a) => a === "deploy" || a === "runDev");
  const buttons = actions.filter((a) => a !== "deploy" && a !== "runDev");
  if (actions.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {commands.map((a) => (
        <ActionButton
          key={a}
          action={a}
          view={view}
          runFriendlyId={runFriendlyId}
          primary={false}
        />
      ))}
      {buttons.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {buttons.map((a, i) => (
            <ActionButton
              key={a}
              action={a}
              view={view}
              runFriendlyId={runFriendlyId}
              primary={i === 0 && a !== "cancel"}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Investigate({ view, runFriendlyId }: { view: RunWaitingView; runFriendlyId: string }) {
  const group = view.notStarted.group;
  const cause = view.notStarted.cause;
  if (cause === "queued" || cause === "versionDeploying" || cause === "externalExpired") {
    return null;
  }
  return (
    <InvestigateButton
      prompt={
        group === "needsDeploy" || group === "wontStart"
          ? pendingVersionRunPrompt(runFriendlyId)
          : waitingRunPrompt(runFriendlyId, view.queue.name)
      }
      className="self-start"
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Small visuals for the checked rows: slots for queues and keys, version marks for versions.

function Slots({ running, limit, tone }: { running: number; limit: number; tone: string }) {
  if (limit > 0 && limit <= 24) {
    return (
      <div
        className="flex flex-wrap items-center gap-0.5"
        role="img"
        aria-label={`${running} of ${limit} running`}
      >
        {Array.from({ length: limit }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-2.5 w-1.5 shrink-0 rounded-[2px]",
              i < running ? tone : "border border-charcoal-550 light:border-charcoal-300"
            )}
          />
        ))}
      </div>
    );
  }
  const pct = limit ? Math.min(100, (running / limit) * 100) : 0;
  return (
    <div
      className="relative h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-grid-bright"
      role="img"
      aria-label={`${running} of ${limit} running`}
    >
      <span className={cn("absolute inset-y-0 left-0", tone)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The capacity that holds the run: its running slots, then the runs queued behind them. */
function CapacityLane({
  capacity,
  tone,
}: {
  capacity: NonNullable<NotStarted["capacity"]>;
  tone: string;
}) {
  const MAX_PIPS = 20;
  const queued = capacity.queued;
  return (
    <div className="flex flex-col gap-1 pt-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Slots running={capacity.running} limit={capacity.limit} tone={tone} />
        {queued > 0 ? (
          <div
            className="flex flex-wrap items-center gap-0.5"
            role="img"
            aria-label={`${queued} queued`}
          >
            <span className="mr-1 h-3 w-px bg-charcoal-550" />
            {Array.from({ length: Math.min(queued, MAX_PIPS) }, (_, i) => (
              <span
                key={i}
                className="size-1.5 shrink-0 rounded-full border border-charcoal-500 light:border-charcoal-300"
              />
            ))}
            {queued > MAX_PIPS ? (
              <span className="ml-0.5 text-xxs tabular-nums text-text-dimmed">
                +{(queued - MAX_PIPS).toLocaleString()}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex gap-3 text-xxs tabular-nums text-text-dimmed">
        <span>
          {capacity.running.toLocaleString()} of {capacity.limit.toLocaleString()} running
        </span>
        {queued > 0 ? <span>{queued.toLocaleString()} queued</span> : null}
      </div>
    </div>
  );
}

function Time({ at, now, seconds = false }: { at: Date; now: number; seconds?: boolean }) {
  const far = Math.abs(at.getTime() - now) > 12 * 60 * 60 * 1000;
  return <DateTime date={at} includeSeconds={seconds} includeDate={far} />;
}

/** A delayed run's wait as a line: triggered, now, when it starts, and for a debounced run
 * when it was first due and the latest a later trigger can push it to; the TTL deadline after. */
function ScheduleStrip({ view, now }: { view: RunWaitingView; now: number }) {
  const ns = view.notStarted;
  if (!ns.startsAt) return null;
  const from = view.createdAt.getTime();
  const due = ns.startsAt.getTime();
  const first = ns.debounce?.originalStartsAt?.getTime();
  const latest = ns.debounce?.latestStartsAt?.getTime();
  const deadline = ns.deadline?.getTime();
  const to = Math.max(due, latest ?? 0, deadline ?? 0, now);
  const pct = (t: number) =>
    `${Math.min(100, Math.max(0, ((t - from) / Math.max(1, to - from)) * 100))}%`;
  const mark = "absolute top-1/2 -translate-x-1/2 -translate-y-1/2";

  return (
    <div className="flex flex-col gap-1.5 pt-1.5">
      <div className="relative mx-1 h-3" role="img" aria-label="Schedule">
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-grid-bright" />
        {latest && latest > due ? (
          <span
            className="absolute top-1/2 h-0 -translate-y-1/2 border-t border-dashed border-charcoal-500"
            style={{ left: pct(due), width: `calc(${pct(latest)} - ${pct(due)})` }}
          />
        ) : null}
        <span
          className="absolute left-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-text-dimmed"
          style={{ width: pct(Math.min(now, due)) }}
        />
        <span className={cn(mark, "size-1.5 rounded-full bg-text-dimmed")} style={{ left: 0 }} />
        {first ? (
          <SimpleTooltip
            button={
              <span
                className={cn(mark, "block h-2.5 w-px bg-charcoal-500")}
                style={{ left: pct(first) }}
              />
            }
            content="First due, before a later trigger pushed it back"
          />
        ) : null}
        {latest ? (
          <span
            className={cn(mark, "h-2.5 w-0.5 rounded-full bg-charcoal-400")}
            style={{ left: pct(latest) }}
          />
        ) : null}
        {deadline ? (
          <span
            className={cn(mark, "h-2.5 w-0.5 rounded-full bg-warning")}
            style={{ left: pct(deadline) }}
          />
        ) : null}
        <span
          className={cn(
            mark,
            "size-3 rounded-full border-2 border-text-bright bg-background-bright"
          )}
          style={{ left: pct(due) }}
        />
      </div>
      <div className="relative mx-1 h-3 text-xxs text-text-dimmed" aria-hidden>
        <StripLabel at={0}>Triggered</StripLabel>
        <StripLabel at={(due - from) / Math.max(1, to - from)}>Starts</StripLabel>
        {latest ? (
          <StripLabel at={(latest - from) / Math.max(1, to - from)}>Latest</StripLabel>
        ) : null}
        {deadline ? (
          <StripLabel at={(deadline - from) / Math.max(1, to - from)}>Expires</StripLabel>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {ns.debounce ? (
          <>
            <dt className="text-text-dimmed">Debounce key</dt>
            <dd className="truncate font-mono text-text-bright">{ns.debounce.key}</dd>
          </>
        ) : null}
        {first ? (
          <>
            <dt className="text-text-dimmed">First due</dt>
            <dd className="text-text-bright">
              <Time at={new Date(first)} now={now} seconds />
            </dd>
            <dt className="text-text-dimmed">Now due</dt>
            <dd className="text-text-bright">
              <Time at={ns.startsAt} now={now} seconds />
              <span className="text-text-dimmed">, pushed back {shortDuration(due - first)}</span>
            </dd>
          </>
        ) : null}
        {latest ? (
          <>
            <dt className="text-text-dimmed">Latest start</dt>
            <dd className="text-text-bright">
              <Time at={new Date(latest)} now={now} />
              <span className="text-text-dimmed">, no trigger can push it later</span>
            </dd>
          </>
        ) : null}
        {deadline ? (
          <>
            <dt className="text-text-dimmed">Expires</dt>
            <dd className="text-text-bright">
              <Time at={new Date(deadline)} now={now} />
              <span className="text-text-dimmed">, if it hasn't started by then</span>
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/** A label under a point on the schedule strip, kept inside the strip at either end. */
function StripLabel({ at, children }: { at: number; children: ReactNode }) {
  const f = Math.min(1, Math.max(0, at));
  return (
    <span
      className={cn(
        "absolute top-0 whitespace-nowrap",
        f < 0.1 ? "" : f > 0.9 ? "-translate-x-full" : "-translate-x-1/2"
      )}
      style={{ left: `${f * 100}%` }}
    >
      {children}
    </span>
  );
}

/** The version the run needs: its locked one, else the environment's current one. */
function targetVersion(view: RunWaitingView): WaitingVersion | undefined {
  return view.versions.find((v) => v.locked) ?? view.versions.find((v) => v.current);
}

function versionTitle(v: WaitingVersion, task: string) {
  return v.hasTask && v.hasQueue
    ? `${v.version} has ${task}`
    : !v.hasTask
      ? `${v.version} doesn't have ${task}`
      : `${v.version} doesn't have this run's queue`;
}

function VersionMark({ v, ring }: { v: WaitingVersion; ring?: string }) {
  const ok = v.hasTask && v.hasQueue;
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full",
        ok
          ? "bg-success text-background-bright"
          : "border border-charcoal-500 text-text-dimmed light:border-charcoal-300",
        ring && `ring-1 ring-offset-1 ring-offset-background-bright ${ring}`
      )}
    >
      {ok ? <CheckIcon className="size-3" /> : <XMarkIcon className="size-3" />}
    </span>
  );
}

/** The last few versions as small marks, the one the run needs ringed, wrapping when narrow. */
function VersionMarks({ view }: { view: RunWaitingView }) {
  const target = targetVersion(view);
  const current = view.versions.find((v) => v.current)?.version;
  const now = useNow(30_000);
  if (view.versions.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {view.versions.map((v) => (
        <span key={v.version} className="flex items-center gap-1">
          <SimpleTooltip
            button={<VersionMark v={v} ring={v === target ? "ring-text-dimmed" : undefined} />}
            content={`${versionTitle(v, view.taskIdentifier)}${v.locked ? " (this run is locked to it)" : ""}, deployed ${shortDuration(now - v.at.getTime())} ago`}
          />
          <VersionLabel
            version={v.version}
            currentVersion={current}
            className={cn(
              "text-xxs tabular-nums",
              v === target ? "text-text-bright" : "text-text-dimmed"
            )}
          />
          {v.locked ? <LockClosedIcon className="size-2.5 text-text-dimmed" /> : null}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Checked, one by one. A card with the group as an icon and title, the main action as a
// full-width button, and under a disclosure the list of everything we checked along the run's
// path (environment, CLI, queue, key, version), so "it's not you" is shown, not claimed.

export function NotStartedCard({
  initial,
  runFriendlyId,
}: {
  initial: RunWaitingView;
  runFriendlyId: string;
}) {
  const view = useLiveNotStarted(initial, runFriendlyId);
  const now = useNow();
  if (!view) return null;
  const ns = view.notStarted;
  const style = GROUP_STYLES[ns.group];
  const Icon = style.icon;
  const checks = pathChecks(view, now);

  return (
    <div
      className={cn(
        "flex flex-col rounded-md border",
        style.border,
        ns.group === "wontStart" ? style.tint : "bg-background-bright"
      )}
    >
      <div className="flex gap-3 p-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md border",
            style.border,
            "bg-background-bright"
          )}
        >
          <Icon className={cn("size-5", style.text)} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <SimpleTooltip
              button={<span className={cn("text-base font-medium", style.text)}>{ns.label}</span>}
              content={`API status: ${ns.apiStatus}`}
            />
            <span className="text-xs tabular-nums text-text-dimmed">
              {shortDuration(
                (ns.cause === "externalExpired" && ns.deadline ? ns.deadline.getTime() : now) -
                  view.createdAt.getTime()
              )}
            </span>
          </div>
          <p className="text-sm text-text-bright">{ns.reason}</p>
          <p className="text-xs text-text-dimmed">
            {ns.startsAt ? <StartsAt at={ns.startsAt} now={now} /> : ns.startsWhen}
          </p>
          {ns.deadline && ns.group !== "delayed" ? (
            <Deadline
              at={ns.deadline}
              now={now}
              expired={ns.cause === "externalExpired"}
              className="text-xs"
            />
          ) : null}
          {ns.capacity ? <CapacityLane capacity={ns.capacity} tone={style.rail} /> : null}
          {ns.group === "delayed" ? <ScheduleStrip view={view} now={now} /> : null}
        </div>
      </div>
      {ns.actions.length ? (
        <Actions view={view} runFriendlyId={runFriendlyId} className="px-3 pb-3" />
      ) : null}
      {checks.length ? (
        <Disclosure defaultOpen={ns.group === "startingSoon"}>
          {({ open }) => (
            <div className="border-t border-grid-bright bg-background-bright/60">
              <Disclosure.Button className="flex w-full items-center gap-1 px-3 py-2 text-xs text-text-dimmed hover:text-text-bright">
                <ChevronRightIcon className={cn("size-4 transition", open && "rotate-90")} />
                What we checked
                <span className="ml-auto flex items-center gap-0.5">
                  {checks.map((c) => (
                    <span
                      key={c.label}
                      className={cn(
                        "size-1.5 rounded-full",
                        c.state === "ok"
                          ? "bg-success"
                          : c.state === "holds"
                            ? style.rail
                            : c.state === "busy"
                              ? "bg-text-dimmed"
                              : "bg-charcoal-500"
                      )}
                    />
                  ))}
                </span>
              </Disclosure.Button>
              <Disclosure.Panel as="ul" className="flex flex-col pb-2">
                {checks.map((c) => (
                  <li
                    key={c.label}
                    className="grid grid-cols-[1rem_5.5rem_1fr] items-center gap-2 px-3 py-1 text-xs"
                  >
                    <CheckMark state={c.state} tone={style.text} />
                    <span className="text-text-dimmed">{c.label}</span>
                    <span
                      className={cn(
                        "flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1",
                        c.state === "holds" || c.state === "busy"
                          ? "text-text-bright"
                          : "text-text-dimmed"
                      )}
                    >
                      <span className="min-w-0">{c.value}</span>
                      {c.extra}
                    </span>
                  </li>
                ))}
              </Disclosure.Panel>
            </div>
          )}
        </Disclosure>
      ) : null}
      <div className="empty:hidden px-3 pb-3">
        <Investigate view={view} runFriendlyId={runFriendlyId} />
      </div>
    </div>
  );
}

type Check = {
  label: string;
  value: ReactNode;
  state: "ok" | "holds" | "busy" | "unknown";
  extra?: ReactNode;
};

function CheckMark({ state, tone }: { state: Check["state"]; tone: string }) {
  if (state === "ok") return <CheckIcon className="size-3.5 text-success" />;
  if (state === "holds") return <XMarkIcon className={cn("size-3.5", tone)} />;
  if (state === "busy") return <Spinner color="muted" className="size-3" />;
  return <span className="mx-auto size-1 rounded-full bg-charcoal-500" />;
}

const PAUSED_BY: Record<string, string> = {
  BILLING_LIMIT: "Paused by your billing limit",
  ADMIN_BAN: "Paused by Trigger.dev",
};

function count(n: number) {
  return n.toLocaleString();
}

function running(n: number, limit: number | null) {
  return limit === null
    ? `${count(n)} running, no limit`
    : `${count(n)} of ${count(limit)} running`;
}

function pathChecks(view: RunWaitingView, now: number): Check[] {
  const ns = view.notStarted;
  const checks: Check[] = [];
  const isDev = view.environmentType === "DEVELOPMENT";
  const atLimitTone = GROUP_STYLES.atLimit.rail;

  // A delayed run waits for a time; its strip says everything.
  if (ns.group === "delayed") return [];

  // An expired run: only the stored reason is known now.
  if (ns.cause === "externalExpired") {
    return [
      {
        label: "Version",
        value: view.pending?.externalDeploymentId
          ? `Deployment ${view.pending.externalDeploymentId} never arrived`
          : "Your app's deployment never arrived",
        state: "holds",
      },
    ];
  }

  const envHolds = ns.cause === "envLimit";
  // Without live counts the environment's running count isn't known: show its limit only.
  const liveCounts = view.queue.queued !== null;
  checks.push({
    label: "Environment",
    value: view.env?.paused
      ? (PAUSED_BY[view.env.pauseSource ?? ""] ?? "Paused by your team")
      : view.env
        ? !liveCounts
          ? `Limit of ${count(view.env.baseLimit)} running, live count not available`
          : view.env.limit > view.env.baseLimit &&
              (envHolds || view.env.running > view.env.baseLimit)
            ? `${count(view.env.running)} running, limit ${count(view.env.baseLimit)} bursting up to ${count(view.env.limit)}`
            : `${count(view.env.running)} of ${count(view.env.baseLimit)} running`
        : "Not checked",
    state:
      ns.cause === "envPaused" ||
      ns.cause === "billingPaused" ||
      ns.cause === "adminPaused" ||
      envHolds
        ? "holds"
        : view.env && liveCounts
          ? "ok"
          : "unknown",
    extra:
      view.env && !view.env.paused && (envHolds || ns.group === "atLimit") ? (
        <Slots
          running={view.env.running}
          limit={view.env.limit}
          tone={envHolds ? atLimitTone : "bg-queues"}
        />
      ) : null,
  });

  if (isDev) {
    checks.push({
      label: "trigger dev",
      value: ns.cause === "devDisconnected" ? "Not running" : "Connected",
      state: ns.cause === "devDisconnected" ? "holds" : "ok",
    });
  }

  const deployGroup = ns.group === "needsDeploy" || ns.group === "wontStart";
  if (!deployGroup || ns.cause === "devDisconnected") {
    const q = view.queue;
    const queued = q.queued !== null && q.queued > 0 ? `, ${count(q.queued)} queued` : "";
    if (view.key) {
      // Keyed runs: the queue row is the cap across every key; the key row is this key's pool.
      const total = view.total;
      checks.push({
        label: "Queue",
        value: q.paused
          ? `${q.name}, paused`
          : total
            ? `${q.name}, ${count(total.running)} of ${count(total.limit)} running across every key`
            : q.running !== null
              ? `${q.name}, ${count(q.running)} running across every key, no total limit`
              : q.name,
        // Every full limit along the path holds the run, not only the one named in the title.
        state:
          ns.cause === "queuePaused" || (total && total.running >= total.limit) ? "holds" : "ok",
        extra: total ? (
          <Slots
            running={total.running}
            limit={total.limit}
            tone={total.running >= total.limit ? atLimitTone : "bg-queues"}
          />
        ) : null,
      });
      const k = view.key;
      checks.push({
        label: "Key",
        value: `${k.key}, ${running(k.running, k.limit)}${k.queued > 0 ? `, ${count(k.queued)} queued` : ""}`,
        state: ns.cause === "keyLimit" ? "holds" : "ok",
        extra:
          k.limit !== null ? (
            <Slots
              running={k.running}
              limit={k.limit}
              tone={ns.cause === "keyLimit" ? atLimitTone : "bg-queues"}
            />
          ) : null,
      });
    } else {
      checks.push({
        label: "Queue",
        value: q.paused
          ? `${q.name}, paused${queued}`
          : q.running !== null
            ? `${q.name}, ${running(q.running, q.limit)}${queued}`
            : q.name,
        state:
          ns.cause === "queuePaused" || ns.cause === "queueLimit"
            ? "holds"
            : q.running !== null || !q.paused
              ? "ok"
              : "unknown",
        extra:
          q.limit !== null && q.running !== null ? (
            <Slots
              running={q.running}
              limit={q.limit}
              tone={ns.cause === "queueLimit" ? atLimitTone : "bg-queues"}
            />
          ) : null,
      });
    }
  }

  // Named limits the run also needs a slot in. Every full one holds it, not only the one in
  // the title.
  if (!deployGroup) {
    for (const named of view.limits) {
      const pool = named.perKey;
      const total = named.total;
      const poolFull = pool !== null && pool.running >= pool.limit;
      const totalFull = total !== null && total.running >= total.limit;
      const shown = poolFull || !total ? pool : total;
      checks.push({
        label: "Limit",
        value: named.paused
          ? `${named.name}, paused`
          : [
              named.name,
              pool
                ? `${pool.key ? `key ${pool.key} ` : ""}${count(pool.running)} of ${count(pool.limit)} running`
                : null,
              total ? `${count(total.running)} of ${count(total.limit)} across every key` : null,
            ]
              .filter(Boolean)
              .join(", "),
        state: named.paused || poolFull || totalFull ? "holds" : "ok",
        extra:
          shown && !named.paused ? (
            <Slots
              running={shown.running}
              limit={shown.limit}
              tone={poolFull || totalFull ? atLimitTone : "bg-queues"}
            />
          ) : null,
      });
    }
  }

  if (ns.cause === "versionDeploying" && view.deployingVersion) {
    const d = view.deployingVersion;
    checks.push({
      label: "Version",
      value: `${d.version}, ${d.status.toLowerCase()} for ${shortDuration(now - d.since.getTime())}`,
      state: "busy",
    });
  }

  // How long runs here usually wait, next to how long this one has: the honest way to say
  // "this is normal" or "this isn't".
  if (ns.group === "startingSoon" && view.usualWait?.p50Ms != null) {
    const { p50Ms, p95Ms } = view.usualWait;
    checks.push({
      label: "Usual wait",
      value: `${shortDuration(p50Ms)} typically${p95Ms != null ? `, ${shortDuration(p95Ms)} at most` : ""}, last hour`,
      state: ns.cause === "quiet" ? "holds" : "ok",
      extra: (
        <span className={ns.cause === "quiet" ? "text-text-bright" : undefined}>
          this run {shortDuration(now - view.createdAt.getTime())}
        </span>
      ),
    });
  }

  // Without recent waits to compare against, still say how long is too long.
  if (ns.cause === "quiet" && view.usualWait?.p50Ms == null) {
    checks.push({
      label: "Waited",
      value: `${shortDuration(now - view.createdAt.getTime())}, runs with nothing holding them start within seconds`,
      state: "holds",
    });
  }

  // A queued run's version is only checked when it's dequeued, so there's nothing to show yet.
  if (deployGroup && ns.cause !== "devDisconnected") {
    checks.push({
      label: "Version",
      value: view.versions.length ? (
        <VersionMarks view={view} />
      ) : ns.cause === "externalDeployment" ? (
        "Waiting for your app's deployment"
      ) : (
        "Nothing deployed yet"
      ),
      state: "holds",
    });
  }

  return checks;
}
