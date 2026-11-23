import {
  ArrowTopRightOnSquareIcon,
  BoltIcon,
  BoltSlashIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { type FetcherWithComponents, useFetcher, useRevalidator } from "@remix-run/react";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { type EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { type TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { Spinner } from "~/components/primitives/Spinner";
import { useToast } from "~/components/primitives/Toast";
import { useEnvironment, useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization, useOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject, useProject } from "~/hooks/useProject";
import type { loader as scheduleEditLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.edit.$scheduleParam/route";
import type { loader as scheduleNewLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route";
import { UpsertScheduleForm } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route";
import { cn } from "~/utils/cn";
import { v3EditSchedulePath, v3NewSchedulePath, v3RunsPath } from "~/utils/pathBuilder";

/*
 * Pieces of the schedule page and the scheduled task page: the create/edit dialog that drives the
 * existing schedule routes through fetchers, timing helpers and the action buttons.
 */

type RunRow = ComponentProps<typeof TaskRunsTable>["runs"][number];

type EnvironmentRow = ComponentProps<typeof EnvironmentCombo>["environment"] & {
  id: string;
};

/** A schedule as its page shows it (the schedule presenter's `schedule`). */
export type ScheduleDetail = {
  id: string;
  friendlyId: string;
  type: "DECLARATIVE" | "IMPERATIVE";
  taskIdentifier: string;
  cron: string;
  cronDescription: string;
  timezone: string;
  window?: string;
  windowSource?: "explicit" | "schedule_default";
  externalId: string | null;
  deduplicationKey: string | null;
  userProvidedDeduplicationKey: boolean;
  active: boolean;
  environments: EnvironmentRow[];
  runs: RunRow[];
  nextRuns: Array<{ nominalAt: Date; effectiveAt: Date }>;
};
type JsonResult = { ok: boolean; message?: string; active?: boolean };

/** Runs `handle` once per fetcher response, whatever else re-renders. */
export function useFetcherResult<T>(
  fetcher: { state: string; data: T | undefined },
  handle: (data: T) => void
) {
  const handled = useRef<unknown>(null);
  const handleRef = useRef(handle);
  useEffect(() => {
    handleRef.current = handle;
  });
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    handleRef.current(fetcher.data);
  }, [fetcher.state, fetcher.data]);
}

/**
 * The create or edit form, loaded from the existing new/edit routes and submitted to the
 * existing upsert action with `_format=json`, so the host page stays put.
 */
function useScheduleForm({
  mode,
  open,
  onSaved,
}: {
  /** A schedule's friendlyId to edit it, or "new". */
  mode: string | undefined;
  open: boolean;
  onSaved: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const newFetcher = useTypedFetcher<typeof scheduleNewLoader>();
  const editFetcher = useTypedFetcher<typeof scheduleEditLoader>();
  const loadNew = newFetcher.load;
  const loadEdit = editFetcher.load;
  const submitFetcher = useFetcher<JsonResult>();
  const toast = useToast();
  const revalidator = useRevalidator();

  const isNew = mode === "new";
  const path = !open
    ? undefined
    : isNew
      ? v3NewSchedulePath(organization, project, environment)
      : mode
        ? v3EditSchedulePath(organization, project, environment, { friendlyId: mode })
        : undefined;

  useEffect(() => {
    if (!path) return;
    if (isNew) loadNew(path);
    else loadEdit(path);
  }, [path, isNew, loadNew, loadEdit]);

  useFetcherResult(submitFetcher, (data) => {
    if (data.ok) {
      toast.success(data.message ?? (isNew ? "Schedule created" : "Schedule updated"));
      revalidator.revalidate();
      onSaved();
    } else if (data.message) toast.error(data.message);
  });

  const data = isNew ? newFetcher.data : editFetcher.data;
  const isStale =
    !isNew && !!editFetcher.data?.schedule && editFetcher.data.schedule.friendlyId !== mode;
  const ready = !!data && !isStale;

  return { data: ready ? data : undefined, submitFetcher, isNew };
}

/** The upsert form for `mode`, or a spinner while its route loads. */
function ScheduleForm({
  mode,
  open,
  layout,
  defaultTaskIdentifier,
  onCancel,
  onSaved,
}: {
  mode: string | undefined;
  open: boolean;
  layout: "panel" | "dialog";
  defaultTaskIdentifier?: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { data, submitFetcher, isNew } = useScheduleForm({ mode, open, onSaved });
  if (!data) {
    return (
      <div
        className={cn("flex items-center justify-center", layout === "panel" ? "h-full" : "h-96")}
      >
        <Spinner className="size-6" />
      </div>
    );
  }
  return (
    <UpsertScheduleForm
      key={mode}
      layout={layout}
      schedule={data.schedule}
      possibleTasks={data.possibleTasks}
      possibleEnvironments={data.possibleEnvironments}
      possibleTimezones={data.possibleTimezones}
      newSchedulePolicy={"newSchedulePolicy" in data ? data.newSchedulePolicy : undefined}
      showGenerateField={data.showGenerateField}
      defaultTaskIdentifier={isNew ? defaultTaskIdentifier : undefined}
      onCancel={onCancel}
      submitFetcher={submitFetcher}
    />
  );
}

/** Create and edit as a centered dialog, like New alert and New environment variables. */
export function ScheduleFormDialog({
  mode,
  onClose,
  defaultTaskIdentifier,
}: {
  /** "new", a schedule's friendlyId, or undefined when closed. */
  mode: string | undefined;
  onClose: () => void;
  defaultTaskIdentifier?: string;
}) {
  const open = mode !== undefined;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="gap-0 p-0 pt-2.5 md:max-w-3xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
        closeOnOutsideClick={false}
      >
        <DialogHeader className="px-4">
          {mode === "new"
            ? defaultTaskIdentifier
              ? `New schedule for ${defaultTaskIdentifier}`
              : "New schedule"
            : "Edit schedule"}
        </DialogHeader>
        <div className="mt-[1.0625rem]">
          {open ? (
            <ScheduleForm
              mode={mode}
              open={open}
              layout="dialog"
              defaultTaskIdentifier={defaultTaskIdentifier}
              onCancel={onClose}
              onSaved={onClose}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Timing ----------

/** "in 9m", "in 13h", "in 2d 4h", "in 4mo", "in 1y 2mo": short enough to sit under a tick. */
export function shortUntil(date: Date, now: number) {
  const ms = Math.max(0, date.getTime() - now);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest && hours < 6 ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days >= 365) {
    const years = Math.floor(days / 365);
    const months = Math.floor((days % 365) / 30.4);
    return months ? `in ${years}y ${months}mo` : `in ${years}y`;
  }
  if (days >= 60) return `in ${Math.round(days / 30.4)}mo`;
  const restHours = hours % 24;
  return restHours ? `in ${days}d ${restHours}h` : `in ${days}d`;
}

/**
 * The current time, ticking every 30s, for "in 12h" labels. `initial` is the loader's clock: the
 * server's page and the browser's first render then show the same times, where two readings of
 * the clock a few seconds apart can differ ("in 2m", "in 1m") and fail hydration.
 */
export function useNow(intervalMs = 30_000, initial?: number) {
  const [now, setNow] = useState(() => initial ?? Date.now());
  useEffect(() => {
    // The first tick comes straight after mount, so the loader's clock lasts one render.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

// ---------- Runs ----------

/**
 * The link to a schedule's runs. Outside a project (the storybook) it's inert, so the views
 * render with static data.
 */
function useRunLinks() {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();
  const ready = organization && project && environment;
  return {
    scheduleRuns: (schedule: { id: string }) =>
      ready ? scheduleRunsPath(organization, project, environment, schedule) : "#",
  };
}

function scheduleRunsPath(
  organization: ReturnType<typeof useOrganization>,
  project: ReturnType<typeof useProject>,
  environment: ReturnType<typeof useEnvironment>,
  schedule: { id: string }
) {
  return v3RunsPath(organization, project, environment, { scheduleId: schedule.id, period: "31d" });
}

export function OpenScheduleRunsLink({ schedule }: { schedule: { id: string } }) {
  const links = useRunLinks();
  return (
    <LinkButton
      variant="minimal/small"
      to={links.scheduleRuns(schedule)}
      TrailingIcon={ArrowTopRightOnSquareIcon}
    >
      Open in runs list
    </LinkButton>
  );
}

// ---------- Actions ----------

export function ScheduleToggleButton({
  schedule,
  actionPath,
  fetcher,
  variant = "secondary/small",
}: {
  schedule: Pick<ScheduleDetail, "active">;
  actionPath: string | undefined;
  fetcher: FetcherWithComponents<unknown>;
  variant?: "secondary/small" | "tertiary/small" | "minimal/small";
}) {
  const busy = fetcher.state !== "idle";
  return (
    <fetcher.Form method="post" action={actionPath}>
      <input type="hidden" name="_format" value="json" />
      <Button
        type="submit"
        variant={variant}
        LeadingIcon={busy ? Spinner : schedule.active ? BoltSlashIcon : BoltIcon}
        leadingIconClassName={schedule.active ? "text-text-dimmed" : "text-success"}
        name="action"
        value={schedule.active ? "disable" : "enable"}
        disabled={busy}
      >
        {schedule.active ? "Disable" : "Enable"}
      </Button>
    </fetcher.Form>
  );
}

export function ScheduleDeleteButton({
  schedule,
  actionPath,
  fetcher,
  trigger,
}: {
  schedule: Pick<ScheduleDetail, "friendlyId" | "externalId">;
  actionPath: string | undefined;
  fetcher: FetcherWithComponents<unknown>;
  trigger?: ReactNode;
}) {
  const busy = fetcher.state !== "idle";
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="danger/small" LeadingIcon={TrashIcon}>
            Delete…
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>Delete schedule</DialogHeader>
        <DialogDescription className="mt-3">
          Delete {schedule.externalId ? `the ${schedule.externalId} schedule` : schedule.friendlyId}
          ? Its future runs won't happen. This can't be reversed.
        </DialogDescription>
        <DialogFooter className="sm:justify-end">
          <fetcher.Form method="post" action={actionPath}>
            <input type="hidden" name="_format" value="json" />
            <Button
              type="submit"
              variant="danger/medium"
              LeadingIcon={busy ? Spinner : TrashIcon}
              name="action"
              value="delete"
              disabled={busy}
            >
              Delete schedule
            </Button>
          </fetcher.Form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ScheduleEditButton({
  onEdit,
  variant = "secondary/small",
}: {
  onEdit: () => void;
  variant?: "secondary/small" | "primary/small";
}) {
  return (
    <Button variant={variant} LeadingIcon={PencilSquareIcon} onClick={onEdit}>
      Edit…
    </Button>
  );
}
