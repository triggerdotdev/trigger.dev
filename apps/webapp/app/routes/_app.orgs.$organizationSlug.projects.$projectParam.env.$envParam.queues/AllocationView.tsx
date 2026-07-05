import { Form, useNavigation } from "@remix-run/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { BigNumber } from "~/components/metrics/BigNumber";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Input } from "~/components/primitives/Input";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { getSeriesColor } from "~/components/code/chartColors";
import { QueueName } from "~/components/runs/v3/QueueName";
import { type Environment } from "~/presenters/v3/EnvironmentQueuePresenter.server";
import {
  type QueueAllocation,
  type QueueAllocationItem,
} from "~/presenters/v3/QueueAllocationPresenter.server";
import { cn } from "~/utils/cn";

type Drafts = Record<string, number>;

export function AllocationView({
  allocation,
  environment,
}: {
  allocation: QueueAllocation;
  environment: Environment;
}) {
  const [drafts, setDrafts] = useState<Drafts>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  const envLimit = environment.concurrencyLimit;
  const burstLimit = Math.round(envLimit * environment.burstFactor);

  useEffect(() => {
    if (navigation.state === "loading" || navigation.state === "idle") {
      setReviewOpen(false);
    }
  }, [navigation.state]);

  // After an apply revalidates the loader, drop drafts that now match the saved limits.
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const queue of allocation.queues) {
        if (next[queue.id] !== undefined && next[queue.id] === queue.limit) {
          delete next[queue.id];
        }
      }
      return next;
    });
  }, [allocation]);

  const draftLimit = (queue: QueueAllocationItem): number | null => drafts[queue.id] ?? queue.limit;

  const draftAllocated = allocation.queues.reduce((sum, queue) => {
    const limit = draftLimit(queue);
    return limit === null ? sum : sum + Math.min(limit, envLimit);
  }, 0);

  const changes = allocation.queues.filter(
    (queue) => drafts[queue.id] !== undefined && drafts[queue.id] !== queue.limit
  );

  const unlimitedCount = allocation.queues.filter((queue) => draftLimit(queue) === null).length;
  const allocationPct = envLimit > 0 ? Math.round((draftAllocated / envLimit) * 100) : 0;
  const overAllocated = draftAllocated > envLimit;

  const setDraft = (queue: QueueAllocationItem, value: string) => {
    setDrafts((prev) => {
      const next = { ...prev };
      if (value.trim() === "") {
        delete next[queue.id];
        return next;
      }
      const parsed = parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) return prev;
      if (parsed === queue.limit) {
        delete next[queue.id];
      } else {
        next[queue.id] = parsed;
      }
      return next;
    });
  };

  const changesPayload = useMemo(
    () =>
      JSON.stringify(changes.map((queue) => ({ friendlyId: queue.id, limit: drafts[queue.id] }))),
    [changes, drafts]
  );

  const colorByQueue = useMemo(() => {
    const map = new Map<string, string>();
    allocation.queues.forEach((queue, i) => map.set(queue.id, getSeriesColor(i)));
    return map;
  }, [allocation.queues]);
  const colorFor = (id: string) => colorByQueue.get(id) ?? "#878C99";

  // Busiest first: the queues you'd rebalance are the ones under load. Colors stay
  // keyed to the loader order so they don't shift as counts change.
  const tableQueues = useMemo(
    () => [...allocation.queues].sort((a, b) => b.running + b.queued - (a.running + a.queued)),
    [allocation.queues]
  );

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <BigNumber
          title="Environment limit"
          value={envLimit}
          suffix={environment.burstFactor > 1 ? `bursts up to ${burstLimit}` : undefined}
          suffixClassName="text-text-dimmed"
        />
        <BigNumber
          title="Allocated"
          value={draftAllocated}
          valueClassName={cn(overAllocated && "text-warning")}
          suffix={`${allocationPct}% of the environment limit`}
          suffixClassName={overAllocated ? "text-warning" : "text-text-dimmed"}
        />
        <BigNumber
          title="Queues"
          value={allocation.totalQueues}
          suffix={
            unlimitedCount > 0
              ? `${unlimitedCount} without a limit (can use up to ${envLimit})`
              : "all have limits"
          }
          suffixClassName="text-text-dimmed"
        />
      </div>

      <AllocationBar
        queues={allocation.queues}
        draftLimit={draftLimit}
        envLimit={envLimit}
        burstLimit={burstLimit}
        draftAllocated={draftAllocated}
        colorFor={colorFor}
      />

      {overAllocated && (
        <Callout variant="warning">
          The queue limits add up to more than the environment limit, so queues will compete for
          concurrency when the environment saturates. Reduce limits to guarantee each queue its
          allocation.
        </Callout>
      )}

      {allocation.truncated && (
        <Callout variant="info">
          Showing the first {allocation.queues.length} of {allocation.totalQueues} queues.
          Allocation totals only include the queues shown.
        </Callout>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="minimal/small"
          onClick={() => setDrafts({})}
          disabled={changes.length === 0 || isSubmitting}
        >
          Reset changes
        </Button>
        <div className="grow" />
        <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="primary/small"
              disabled={changes.length === 0 || isSubmitting}
            >
              Review {changes.length} change{changes.length === 1 ? "" : "s"}…
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>Apply queue limits</DialogHeader>
            <div className="max-h-64 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Queue</TableHeaderCell>
                    <TableHeaderCell alignment="right">Current</TableHeaderCell>
                    <TableHeaderCell alignment="right">New</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {changes.map((queue) => (
                    <TableRow key={queue.id}>
                      <TableCell>
                        <QueueName name={queue.name} type={queue.type} />
                      </TableCell>
                      <TableCell alignment="right">{queue.limit ?? "–"}</TableCell>
                      <TableCell alignment="right">{drafts[queue.id]}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Paragraph variant="small" className="mt-2">
              Limits apply immediately and are set as overrides, so they survive deploys until
              removed.
            </Paragraph>
            <Form method="post" className="mt-3 flex justify-end">
              <input type="hidden" name="action" value="allocation-apply" />
              <input type="hidden" name="changes" value={changesPayload} />
              <Button type="submit" variant="primary/medium" disabled={isSubmitting}>
                {isSubmitting
                  ? "Applying…"
                  : `Apply ${changes.length} change${changes.length === 1 ? "" : "s"}`}
              </Button>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Table containerClassName="border-t">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell alignment="right">Running</TableHeaderCell>
            <TableHeaderCell alignment="right">Queued</TableHeaderCell>
            <TableHeaderCell
              alignment="right"
              tooltip="The queue's concurrency limit. Queues without a limit can use up to the environment limit."
            >
              Limit
            </TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tableQueues.map((queue) => {
            const changed = drafts[queue.id] !== undefined && drafts[queue.id] !== queue.limit;
            return (
              <TableRow key={queue.id}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: colorFor(queue.id) }}
                    />
                    <QueueName name={queue.name} type={queue.type} paused={queue.paused} />
                    {queue.paused && (
                      <Badge variant="extra-small" className="text-warning">
                        Paused
                      </Badge>
                    )}
                    {queue.overridden && (
                      <Badge variant="extra-small" className="text-text-bright">
                        Override
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell alignment="right">{queue.running}</TableCell>
                <TableCell alignment="right">{queue.queued}</TableCell>
                <TableCell alignment="right">
                  <span className="flex items-center justify-end gap-2">
                    {changed && (
                      <Badge variant="extra-small" className="text-success">
                        {queue.limit ?? "–"} → {drafts[queue.id]}
                      </Badge>
                    )}
                    <Input
                      type="number"
                      min={0}
                      value={drafts[queue.id] ?? queue.limit ?? ""}
                      placeholder={String(envLimit)}
                      onChange={(e) => setDraft(queue, e.target.value)}
                      disabled={isSubmitting}
                      className="w-24"
                      variant="small"
                    />
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

const MAX_BAR_SEGMENTS = 24;

function AllocationBar({
  queues,
  draftLimit,
  envLimit,
  burstLimit,
  draftAllocated,
  colorFor,
}: {
  queues: QueueAllocationItem[];
  draftLimit: (queue: QueueAllocationItem) => number | null;
  envLimit: number;
  burstLimit: number;
  draftAllocated: number;
  colorFor: (id: string) => string;
}) {
  const limited = queues
    .map((queue) => ({ queue, limit: draftLimit(queue) }))
    .filter(
      (entry): entry is { queue: QueueAllocationItem; limit: number } =>
        typeof entry.limit === "number" && entry.limit > 0
    )
    .sort((a, b) => b.limit - a.limit);

  const top = limited.slice(0, MAX_BAR_SEGMENTS);
  const rest = limited.slice(MAX_BAR_SEGMENTS);
  const restTotal = rest.reduce((sum, entry) => sum + entry.limit, 0);
  const restRunning = rest.reduce(
    (sum, entry) => sum + Math.min(entry.queue.running, entry.limit),
    0
  );

  const hasBurst = burstLimit > envLimit;
  // The axis runs to the burst ceiling: allocations are guaranteed up to the env
  // limit, and everything between the limit and burst is shared overflow headroom.
  const scale = Math.max(draftAllocated, envLimit, burstLimit);
  if (scale === 0) return null;

  const free = Math.max(0, envLimit - draftAllocated);
  const limitMarkerPct = (envLimit / scale) * 100;
  const burstZoneWidthPct = ((Math.min(burstLimit, scale) - envLimit) / scale) * 100;

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <div className="relative h-3 w-full overflow-hidden rounded-sm bg-charcoal-750">
          {hasBurst && (
            <SimpleTooltip
              asChild
              button={
                <div
                  className="absolute inset-y-0"
                  style={{
                    left: `${limitMarkerPct}%`,
                    width: `${burstZoneWidthPct}%`,
                    backgroundImage:
                      "repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0 2px, transparent 2px 6px)",
                  }}
                />
              }
              content={`Shared burst headroom: beyond the environment limit, queues can burst up to ${burstLimit} combined`}
              disableHoverableContent
            />
          )}
          <div className="pointer-events-none absolute inset-0 flex gap-px">
            {top.map((entry) => (
              <BarSegment
                key={entry.queue.id}
                color={colorFor(entry.queue.id)}
                widthPct={(entry.limit / scale) * 100}
                usagePct={Math.min(entry.queue.running / entry.limit, 1) * 100}
                tooltip={
                  <QueueSegmentTooltip
                    queue={entry.queue}
                    limit={entry.limit}
                    envLimit={envLimit}
                    color={colorFor(entry.queue.id)}
                  />
                }
              />
            ))}
            {restTotal > 0 && (
              <BarSegment
                color="#878C99"
                widthPct={(restTotal / scale) * 100}
                usagePct={(restRunning / restTotal) * 100}
                tooltip={`${rest.length} more queues: ${restRunning} of ${restTotal} running`}
              />
            )}
          </div>
        </div>
        <div
          className="absolute inset-y-[-3px] w-px bg-text-bright"
          style={{ left: `${limitMarkerPct}%` }}
        />
      </div>
      <div className="relative h-4 text-xs text-text-dimmed">
        <span className="absolute left-0 top-0">
          {draftAllocated} allocated
          {free > 0 ? ` · ${free} unallocated` : ""}
        </span>
        {hasBurst ? (
          <>
            <span
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${limitMarkerPct}%` }}
            >
              Environment limit {envLimit}
            </span>
            <span className="absolute right-0 top-0">Burst {burstLimit}</span>
          </>
        ) : (
          <span className="absolute right-0 top-0">Environment limit {envLimit}</span>
        )}
      </div>
    </div>
  );
}

function QueueSegmentTooltip({
  queue,
  limit,
  envLimit,
  color,
}: {
  queue: QueueAllocationItem;
  limit: number;
  envLimit: number;
  color: string;
}) {
  const utilizationPct = limit > 0 ? Math.round((queue.running / limit) * 100) : 0;
  const sharePct = envLimit > 0 ? Math.round((limit / envLimit) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5 p-1 text-left">
      <span className="flex items-center gap-1.5">
        <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
        <QueueName name={queue.name} type={queue.type} paused={queue.paused} />
        {queue.paused && (
          <Badge variant="extra-small" className="text-warning">
            Paused
          </Badge>
        )}
      </span>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <span className="text-text-dimmed">Running</span>
        <span className="text-right tabular-nums text-text-bright">
          {queue.running} of {limit} ({utilizationPct}%)
        </span>
        <span className="text-text-dimmed">Queued</span>
        <span className="text-right tabular-nums text-text-bright">{queue.queued}</span>
        <span className="text-text-dimmed">Allocation</span>
        <span className="text-right tabular-nums text-text-bright">
          {sharePct}% of the environment limit
        </span>
      </div>
    </div>
  );
}

/** One queue's slice of the capacity bar: dim fill = allocation, solid fill = current usage. */
function BarSegment({
  color,
  widthPct,
  usagePct,
  tooltip,
}: {
  color: string;
  widthPct: number;
  usagePct: number;
  tooltip: ReactNode;
}) {
  return (
    <SimpleTooltip
      asChild
      button={
        <div
          className="pointer-events-auto relative h-full min-w-px overflow-hidden"
          style={{ width: `${widthPct}%`, backgroundColor: `${color}33` }}
        >
          {usagePct > 0 && (
            <div
              className="absolute inset-y-0 left-0"
              style={{ width: `${usagePct}%`, backgroundColor: color }}
            />
          )}
        </div>
      }
      content={tooltip}
      disableHoverableContent
    />
  );
}
