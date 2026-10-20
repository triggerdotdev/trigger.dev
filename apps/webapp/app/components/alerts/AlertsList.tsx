import {
  ArchiveBoxIcon,
  BellAlertIcon,
  BellSlashIcon,
  ExclamationTriangleIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { CheckMarkIcon } from "~/assets/icons/CheckMarkIcon";
import { EditPencilIcon } from "~/assets/icons/EditPencilIcon";
import { TrashIcon } from "~/assets/icons/TrashIcon";
import * as Ariakit from "@ariakit/react";
import { formatDistanceToNow } from "date-fns";
import { useFetcher, useNavigate } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import { CodeSquareIcon } from "~/assets/icons/CodeSquareIcon";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { AlertActivityCell } from "~/components/alerts/AlertActivityCell";
import { formatExpiresAt } from "~/components/alerts/formatExpiresAt";
import { AgentIcon } from "~/components/dashboard-agent/agent-identity";
import { alertInvestigatePrompt } from "~/components/dashboard-agent/investigate-prompts";
import { GatedMenuItem } from "./GatedMenuItem";
import { useDashboardAgent } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { RelativeDateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Icon } from "~/components/primitives/Icon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PaginationControls } from "~/components/primitives/Pagination";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
  PopoverVerticalEllipseTrigger,
} from "~/components/primitives/Popover";
import { SearchInput } from "~/components/primitives/SearchInput";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import {
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
} from "~/components/primitives/Select";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import {
  appliedSummary,
  TimeFilter,
  type TimeFilterApplyValues,
} from "~/components/runs/v3/SharedFilters";
import {
  type AlertEpisodeSummary,
  type AlertListRow,
  type AlertListRowStatus,
} from "~/presenters/v3/alertListRow";
import { AlertStatusBadge, AlertStatusBreakdown } from "./AlertStatusBadge";
import { AREA_ICON, AREA_LABEL, isAlertArea, WATCHING_TOOLTIP } from "./domainIcons";
import {
  DEFAULT_PERIOD,
  parseAlertsListSearchParams,
  serializeAlertsListFilters,
  type AreaFilterValue,
  MAX_LIST_ALERTS,
} from "./alertsListFilters";
import { useSearchParams } from "~/hooks/useSearchParam";

export function NewAlertButton({ prompt, path }: { prompt: string; path: string }) {
  const agent = useDashboardAgent();

  if (agent) {
    return (
      <Button
        type="button"
        variant="primary/small"
        LeadingIcon={PlusIcon}
        disabled={agent.open}
        onClick={() => agent.openWith(prompt, { source: "alerts" })}
      >
        New alert
      </Button>
    );
  }

  return (
    <LinkButton to={path} variant="primary/small" LeadingIcon={PlusIcon}>
      New alert
    </LinkButton>
  );
}

// ---- Filters -------------------------------------------------------------------

const STATUS_OPTIONS: { value: AlertListRowStatus; label: string }[] = [
  { value: "needs_attention", label: "Needs attention" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

function StatusFilter({
  selected,
  onChange,
}: {
  selected: AlertListRowStatus[];
  onChange: (values: AlertListRowStatus[]) => void;
}) {
  const icon = <StatusIcon className="size-4 border-text-bright" />;

  const trigger =
    selected.length === 0 ? (
      <SelectTrigger
        icon={icon}
        variant="secondary/small"
        tooltipTitle="Filter by status"
        className="pl-1.5"
      >
        <span className="ml-1">Status</span>
      </SelectTrigger>
    ) : (
      <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
        <AppliedFilter
          label="Status"
          icon={icon}
          value={appliedSummary(
            selected.map((s) => STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s)
          )}
          onRemove={() => onChange([])}
          variant="secondary/small"
        />
      </Ariakit.Select>
    );

  return (
    <SelectProvider
      value={selected}
      setValue={(v) => onChange(v as AlertListRowStatus[])}
      virtualFocus={true}
    >
      {trigger}
      <SelectPopover className="min-w-0 max-w-[min(240px,var(--popover-available-width))]">
        <SelectList>
          {STATUS_OPTIONS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

export const AREA_OPTIONS: { value: AreaFilterValue; label: string }[] = [
  { value: "queues", label: "Queues" },
  { value: "errors", label: "Errors" },
  { value: "runs", label: "Runs" },
  { value: "health", label: "Health" },
  { value: "unknown", label: "Unknown" },
];

function AreaFilter({
  selected,
  onChange,
}: {
  selected: AreaFilterValue[];
  onChange: (values: AreaFilterValue[]) => void;
}) {
  const icon = <CodeSquareIcon className="size-4" />;

  const trigger =
    selected.length === 0 ? (
      <SelectTrigger
        icon={icon}
        variant="secondary/small"
        tooltipTitle="Filter by what's watched"
        className="pl-1.5"
      >
        <span className="ml-1">Watching</span>
      </SelectTrigger>
    ) : (
      <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
        <AppliedFilter
          label="Watching"
          icon={icon}
          value={appliedSummary(
            selected.map((s) => AREA_OPTIONS.find((o) => o.value === s)?.label ?? s)
          )}
          onRemove={() => onChange([])}
          variant="secondary/small"
        />
      </Ariakit.Select>
    );

  return (
    <SelectProvider
      value={selected}
      setValue={(v) => onChange(v as AreaFilterValue[])}
      virtualFocus={true}
    >
      {trigger}
      <SelectPopover className="min-w-0 max-w-[min(240px,var(--popover-available-width))]">
        <SelectList>
          {AREA_OPTIONS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

export function AlertsListMenuContent({
  hasLegacyAlerts,
  channelsTo,
  legacyTo,
  onSelect,
}: {
  hasLegacyAlerts: boolean;
  channelsTo: string;
  legacyTo: string;
  onSelect?: () => void;
}) {
  return (
    <>
      <PopoverMenuItem to={channelsTo} icon={BellAlertIcon} title="Channels" onClick={onSelect} />
      {hasLegacyAlerts && (
        <PopoverMenuItem
          to={legacyTo}
          icon={ArchiveBoxIcon}
          title="Legacy alerts"
          onClick={onSelect}
        />
      )}
    </>
  );
}

function AlertsListMenu({
  hasLegacyAlerts,
  channelsTo,
  legacyTo,
}: {
  hasLegacyAlerts: boolean;
  channelsTo: string;
  legacyTo: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverVerticalEllipseTrigger aria-label="More" />
      <PopoverContent align="end" className="min-w-44 p-1">
        <AlertsListMenuContent
          hasLegacyAlerts={hasLegacyAlerts}
          channelsTo={channelsTo}
          legacyTo={legacyTo}
          onSelect={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function FiltersBar({
  search,
  statuses,
  onStatusesChange,
  areas,
  onAreasChange,
  period,
  from,
  to,
  onPeriodChange,
  onClearFilters,
  newAlertButton,
}: {
  search: string;
  statuses: AlertListRowStatus[];
  onStatusesChange: (values: AlertListRowStatus[]) => void;
  areas: AreaFilterValue[];
  onAreasChange: (values: AreaFilterValue[]) => void;
  period: string | undefined;
  from: number | undefined;
  to: number | undefined;
  onPeriodChange: (values: TimeFilterApplyValues) => void;
  onClearFilters: () => void;
  newAlertButton: React.ReactNode;
}) {
  const hasFilters =
    search.length > 0 || statuses.length > 0 || areas.length > 0 || period !== "7d";

  return (
    <div className="flex items-start justify-between gap-x-2 border-b border-grid-bright p-2">
      <div className="flex flex-row flex-wrap items-center gap-1.5">
        <SearchInput placeholder="Search alerts…" resetParams={["page"]} />
        <StatusFilter selected={statuses} onChange={onStatusesChange} />
        <AreaFilter selected={areas} onChange={onAreasChange} />
        <TimeFilter
          defaultPeriod="7d"
          period={period}
          from={from?.toString()}
          to={to?.toString()}
          labelName="Occurred"
          onValueChange={onPeriodChange}
        />
        {hasFilters && (
          <Button
            variant="minimal/small"
            LeadingIcon={XMarkIcon}
            tooltip="Clear all filters"
            className="-ml-1 group-hover/button:bg-transparent"
            leadingIconClassName="group-hover/button:text-text-bright"
            onClick={() => {
              onClearFilters();
            }}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{newAlertButton}</div>
    </div>
  );
}

// ---- Episode line + domain cell ------------------------------------------------

function episodeText(episode: AlertEpisodeSummary | undefined): string | null {
  if (!episode) return null;
  if (episode.kind === "raised" && episode.recoveredAt) {
    return "recovered · safe to resolve";
  }
  return null;
}

function AreaCell({ area }: { area: string }) {
  if (!isAlertArea(area)) {
    return (
      <Badge variant="small" className="capitalize">
        {area}
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-text-dimmed">
      <Icon icon={AREA_ICON[area]} className="size-3.5 shrink-0" />
      {AREA_LABEL[area]}
    </span>
  );
}

function QuietFor({ date }: { date: Date | string }) {
  const realDate = useMemo(() => (typeof date === "string" ? new Date(date) : date), [date]);
  const [text, setText] = useState(() => formatDistanceToNow(realDate));
  useEffect(() => {
    const id = setInterval(() => setText(formatDistanceToNow(realDate)), 60_000);
    return () => clearInterval(id);
  }, [realDate]);
  return <span suppressHydrationWarning>quiet for {text}</span>;
}

export function LastActivityCell({ alert }: { alert: AlertListRow }) {
  if (!alert.lastEventAt) return <span className="text-text-dimmed">–</span>;
  if (alert.status === "active" && alert.lastEventAt) {
    return <QuietFor date={alert.lastEventAt} />;
  }
  return <RelativeDateTime date={alert.lastActivityAt} capitalize={false} />;
}

// ---- Row actions ---------------------------------------------------------------

function RowConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmVariant,
  confirmIcon,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant: "primary/medium" | "danger/medium";
  confirmIcon: typeof CheckMarkIcon;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>{title}</DialogHeader>
        <DialogDescription className="mt-3">{description}</DialogDescription>
        <DialogFooter className="sm:justify-end">
          <Button
            variant={confirmVariant}
            LeadingIcon={confirmIcon}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AlertActionsPopoverContent({
  alert,
  canWrite,
  canDelete,
  onClose,
  onResolve,
  onStop,
  onActivate,
  onEdit,
  onDelete,
}: {
  alert: AlertListRow;
  canWrite: boolean;
  canDelete: boolean;
  onClose: () => void;
  onResolve: () => void;
  onStop: () => void;
  onActivate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const agent = useDashboardAgent();
  const then = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <div>
      <PopoverSectionHeader title="Alert actions" />
      <div className="flex flex-col gap-1 p-1">
        {alert.status === "needs_attention" && (
          <GatedMenuItem
            allowed={canWrite}
            icon={CheckMarkIcon}
            leadingIconClassName="text-success"
            title="Mark as Resolved"
            onClick={then(onResolve)}
          />
        )}
        {alert.status === "active" && (
          <GatedMenuItem
            allowed={canWrite}
            icon={BellSlashIcon}
            title="Mark as Inactive"
            onClick={then(onStop)}
          />
        )}
        {alert.status === "inactive" ? (
          <>
            <GatedMenuItem
              allowed={canWrite}
              icon={CheckMarkIcon}
              leadingIconClassName="text-success"
              title="Activate"
              onClick={then(onActivate)}
            />
            <hr className="my-0.5 border-grid-bright" />
          </>
        ) : (
          <>
            <hr className="my-0.5 border-grid-bright" />
            <GatedMenuItem
              allowed={canWrite}
              icon={EditPencilIcon}
              title="Edit"
              onClick={then(onEdit)}
            />
          </>
        )}
        {alert.status === "inactive" && (
          <GatedMenuItem
            allowed={canWrite && canDelete}
            icon={TrashIcon}
            title="Delete"
            onClick={then(onDelete)}
          />
        )}
        {agent && (
          <PopoverMenuItem
            icon={AgentIcon}
            title="Investigate"
            onClick={then(() =>
              agent.openWith(
                alertInvestigatePrompt({
                  alertId: alert.id,
                  capabilityKey: alert.capabilityKey,
                  environmentId: alert.environmentId,
                  scope: alert.scope,
                  name: alert.name,
                  capabilityTitle: alert.capabilityTitle,
                  conditionSummary: alert.conditionSummary,
                })
              )
            )}
          />
        )}
      </div>
    </div>
  );
}

export function AlertActionsCell({
  alert,
  alertPath,
  canWrite,
  canDelete,
}: {
  alert: AlertListRow;
  alertPath: string;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const agent = useDashboardAgent();

  const openEdit = (activate: boolean) =>
    agent
      ? agent.openEditAlert({
          alertId: alert.id,
          name: alert.name,
          conditionSummary: alert.conditionSummary,
          notifiers: (alert.notifierKeys ?? []).map((key) => ({ key })),
          expiresAt: alert.expiresAt ? new Date(alert.expiresAt).toISOString() : null,
          activate,
        })
      : navigate(`${alertPath}?edit=1${activate ? "&activate=1" : ""}`);

  const submitAction = (action: string) => {
    const formData = new FormData();
    formData.set("action", action);
    formData.set("id", alert.id);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <>
      <TableCellMenu
        isSticky
        // oxlint-disable-next-line react/no-unstable-nested-components -- render prop, not a component definition.
        popoverContent={(close) => (
          <AlertActionsPopoverContent
            alert={alert}
            canWrite={canWrite}
            canDelete={canDelete}
            onClose={close}
            onResolve={() => submitAction("resolve")}
            onStop={() => submitAction("stop")}
            onActivate={() => openEdit(true)}
            onEdit={() => openEdit(false)}
            onDelete={() => setDeleteOpen(true)}
          />
        )}
      />
      <RowConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete alert"
        description="Are you sure you want to delete this alert? This can't be reversed."
        confirmLabel="Delete"
        confirmVariant="danger/medium"
        confirmIcon={TrashIcon}
        onConfirm={() => submitAction("delete")}
      />
    </>
  );
}

// ---- Row -----------------------------------------------------------------------

function AlertGroupRow({
  alert,
  alertPath,
  canWrite,
  canDelete,
}: {
  alert: AlertListRow;
  alertPath: string;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const episode = episodeText(alert.episode);

  return (
    <TableRow>
      <TableCell to={alertPath}>
        <span className="flex items-center gap-1.5">
          <AlertStatusBadge status={alert.status} extra={episode} />
          {alert.hasChannelIssue ? (
            <SimpleTooltip
              button={<ExclamationTriangleIcon className="size-4 text-warning" />}
              content="A notification channel needs attention. Edit the alert's channels."
              className="max-w-[230px]"
              disableHoverableContent
            />
          ) : null}
        </span>
      </TableCell>
      <TableCell to={alertPath} className="font-mono">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="max-w-[14rem] truncate text-text-bright" title={alert.name}>
              {alert.name}
            </span>
          </span>
        </span>
      </TableCell>
      <TableCell to={alertPath} className="whitespace-nowrap">
        <AreaCell area={alert.area} />
      </TableCell>
      <TableCell to={alertPath} className="whitespace-nowrap text-xs text-text-dimmed">
        {formatExpiresAt(
          alert.expiresAt != null && typeof alert.expiresAt === "string"
            ? new Date(alert.expiresAt)
            : alert.expiresAt
        )}
      </TableCell>
      <TableCell to={alertPath} className="whitespace-nowrap text-xs text-text-dimmed">
        <LastActivityCell alert={alert} />
      </TableCell>
      <TableCell to={alertPath} actionClassName="py-1.5">
        <AlertActivityCell stateBuckets={alert.stateBuckets} />
      </TableCell>
      <AlertActionsCell
        alert={alert}
        alertPath={alertPath}
        canWrite={canWrite}
        canDelete={canDelete}
      />
    </TableRow>
  );
}

// ---- Filtering + sorting -------------------------------------------------------

function useAlertsFilters() {
  const { value, replace } = useSearchParams();
  const parsed = parseAlertsListSearchParams(
    new URLSearchParams(
      ["statuses", "areas", "period", "from", "to"].flatMap((key) => {
        const v = value(key);
        return v ? [[key, v]] : [];
      })
    )
  );
  const statuses = parsed.statuses as AlertListRowStatus[];
  const { areas, period, from, to } = parsed;
  const search = value("search") ?? "";
  const resetPage = { page: undefined };
  const setStatuses = (v: AlertListRowStatus[]) =>
    replace({ ...serializeAlertsListFilters({ statuses: v }), ...resetPage });
  const setAreas = (v: AreaFilterValue[]) =>
    replace({ ...serializeAlertsListFilters({ areas: v }), ...resetPage });
  const setPeriod = (v: TimeFilterApplyValues) =>
    replace({ ...serializeAlertsListFilters(v), ...resetPage });
  const clearFilters = () =>
    replace({
      ...serializeAlertsListFilters({ statuses: [], areas: [], period: DEFAULT_PERIOD }),
      search: undefined,
      ...resetPage,
    });

  return {
    search,
    statuses,
    setStatuses,
    areas,
    setAreas,
    period,
    from,
    to,
    setPeriod,
    clearFilters,
  };
}

// ---- Main list -----------------------------------------------------------------

export function AlertsList({
  alerts,
  newAlertPath,
  newAlertPrompt,
  alertPath,
  canWrite,
  canDelete,
  hasLegacyAlerts,
  channelsTo,
  legacyTo,
  page,
  totalPages,
  truncated,
}: {
  alerts: AlertListRow[];
  hasLegacyAlerts: boolean;
  channelsTo: string;
  legacyTo: string;
  page: number;
  totalPages: number;
  truncated: boolean;
  newAlertPath: string;
  newAlertPrompt: string;
  alertPath: (alertId: string) => string;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const filters = useAlertsFilters();
  const hasFilters =
    filters.search.length > 0 ||
    filters.statuses.length > 0 ||
    filters.areas.length > 0 ||
    filters.period !== DEFAULT_PERIOD ||
    filters.from !== undefined ||
    filters.to !== undefined;

  return (
    <div className="grid max-h-full min-h-full grid-rows-[auto_1fr_auto]">
      <div>
        <FiltersBar
          search={filters.search}
          statuses={filters.statuses}
          onStatusesChange={filters.setStatuses}
          areas={filters.areas}
          onAreasChange={filters.setAreas}
          period={filters.period}
          from={filters.from}
          to={filters.to}
          onPeriodChange={filters.setPeriod}
          onClearFilters={filters.clearFilters}
          newAlertButton={
            <>
              <NewAlertButton prompt={newAlertPrompt} path={newAlertPath} />
              <AlertsListMenu
                hasLegacyAlerts={hasLegacyAlerts}
                channelsTo={channelsTo}
                legacyTo={legacyTo}
              />
            </>
          }
        />
        {truncated && (
          <Paragraph variant="small" className="border-b border-grid-bright px-3 py-1.5">
            Showing the {MAX_LIST_ALERTS} most recent alerts — narrow the filters.
          </Paragraph>
        )}
      </div>
      {alerts.length === 0 ? (
        hasFilters ? (
          <MainCenteredContainer className="max-w-md">
            <InfoPanel
              title="No alerts match these filters"
              icon={BellAlertIcon}
              iconClassName="text-alerts"
              panelClassName="max-w-md"
              accessory={
                <Button
                  variant="secondary/small"
                  LeadingIcon={XMarkIcon}
                  onClick={filters.clearFilters}
                >
                  Clear filters
                </Button>
              }
            >
              Try a different search, status, area or time range.
            </InfoPanel>
          </MainCenteredContainer>
        ) : (
          <MainCenteredContainer className="max-w-md">
            <InfoPanel
              title="Create your first alert"
              icon={BellAlertIcon}
              iconClassName="text-alerts"
              panelClassName="max-w-md"
            >
              Alerts watch what matters and tell you when it changes: a queue backing up, a task's
              failure rate climbing, a new error appearing, or your environment's health degrading.
              They notify you in chat, by email, in Slack, or through a webhook.
            </InfoPanel>
          </MainCenteredContainer>
        )
      ) : (
        <Table containerClassName="max-h-full pb-10" showTopBorder={false}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell
                tooltip={<AlertStatusBreakdown />}
                disableTooltipHoverableContent
                tooltipContentClassName="max-w-sm"
              >
                Status
              </TableHeaderCell>
              <TableHeaderCell
                tooltip="The alert's name and what it watches."
                disableTooltipHoverableContent
                tooltipContentClassName="max-w-sm"
              >
                Alert
              </TableHeaderCell>
              <TableHeaderCell
                tooltip={WATCHING_TOOLTIP}
                disableTooltipHoverableContent
                tooltipContentClassName="max-w-xs"
              >
                Watching
              </TableHeaderCell>
              <TableHeaderCell>Expires</TableHeaderCell>
              <TableHeaderCell>Last occurred</TableHeaderCell>
              <TableHeaderCell>Activity</TableHeaderCell>
              <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {alerts.map((alert) => (
              <AlertGroupRow
                key={alert.id}
                alert={alert}
                alertPath={alertPath(alert.id)}
                canWrite={canWrite}
                canDelete={canDelete}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {totalPages > 1 && (
        <div className="flex justify-end border-t border-grid-bright p-2">
          <PaginationControls currentPage={page} totalPages={totalPages} />
        </div>
      )}
    </div>
  );
}
