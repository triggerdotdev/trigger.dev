import { DateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";

export type RecentlyQueuedEntry = {
  runId: string;
  status: "QUEUED" | "DRAINING" | "FAILED" | "DONE";
  createdAt: string | Date;
};

// Runs the mollifier has buffered but the drainer hasn't yet materialised
// into Postgres. Without this surface they're invisible to the dashboard
// during the buffered window — the paginated runs list is PG-only. We
// render a compact header section so operators can see in-flight buffered
// entries at a glance while still scrolling the regular list below.
export function RecentlyQueuedSection({ entries }: { entries: RecentlyQueuedEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="border-b border-grid-dimmed bg-charcoal-850 px-3 py-3">
      <Header3 className="mb-2">Recently queued ({entries.length})</Header3>
      <Paragraph variant="extra-small/dimmed" className="mb-2">
        Triggers accepted into the burst buffer. They&apos;ll appear in the list below once the
        drainer materialises them.
      </Paragraph>
      <ul className="space-y-1 text-text-bright">
        {entries.map((entry) => (
          <li key={entry.runId} className="flex items-center gap-3 text-xs">
            <span className="font-mono">{entry.runId}</span>
            <span
              className={
                entry.status === "FAILED"
                  ? "text-error"
                  : entry.status === "DRAINING"
                    ? "text-warning"
                    : "text-text-dimmed"
              }
            >
              {entry.status === "FAILED"
                ? "Failed"
                : entry.status === "DRAINING"
                  ? "Draining"
                  : "Queued"}
            </span>
            <DateTime date={entry.createdAt} />
          </li>
        ))}
      </ul>
    </div>
  );
}
