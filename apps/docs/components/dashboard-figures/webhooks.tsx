// The Webhooks page: the environment's endpoints, one with its signing secret still to set. Drawn
// from source (the reference dashboard has no endpoints); the activity column reuses the tasks
// list's ActivitySparkline (the same ActivityBarChart, with Succeeded and Failed colors). The
// webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { SparklesIcon } from "@heroicons/react/20/solid";
import type { ReactNode } from "react";
import {
  AppFrame,
  Button,
  Cell,
  PageHeader,
  Pagination,
  SearchField,
  SideMenu,
  tableHeader,
  tableRow,
  td,
  th,
} from "./chrome";
import * as I from "./icons";
import { ActivitySparkline } from "./task-parts";

type P = { className?: string };

type Endpoint = {
  id: string;
  source: string;
  url: string;
  ready: boolean;
  /** Succeeded and failed deliveries per hour over the last 24 hours; none: the blank state. */
  ok?: number[];
  failed?: number[];
  lastDelivery?: string;
};

const INGEST = "https://api.trigger.dev/webhooks/v1/ingest/";

const endpoints: Endpoint[] = [
  { id: "github", source: "github", url: `${INGEST}we_k3q8m2x7v9rt`, ready: false },
  {
    id: "payments",
    source: "stripe",
    url: `${INGEST}we_p4d9n6c2h8wz`,
    ready: true,
    ok: [3, 5, 2, 0, 1, 4, 6, 8, 5, 3, 7, 9, 12, 10, 8, 6, 9, 11, 7, 5, 4, 6, 3, 2],
    failed: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    lastDelivery: "25 Nov 2026, 10:42:18 am",
  },
  {
    id: "support-inbox",
    source: "slack",
    url: `${INGEST}we_t7j2r5b9f3ky`,
    ready: true,
    ok: [0, 0, 1, 0, 0, 0, 0, 2, 3, 1, 0, 2, 1, 0, 0, 1, 2, 0, 0, 1, 0, 0, 1, 0],
    lastDelivery: "25 Nov 2026, 9:58:03 am",
  },
];

/** TableHeaderCell with a tooltip: the label, then an info icon. */
function Th({ right, children }: { right?: boolean; children: string }) {
  return (
    <div className={right ? th.replace("text-left", "text-right") : th}>
      <div className={`flex items-center gap-1 ${right ? "justify-end" : ""}`}>
        {children}
        <div className="h-fit">
          <I.InformationCircleIcon className="size-3.5 text-text-dimmed flex-0" />
        </div>
      </div>
    </div>
  );
}

function Dot({ className }: P) {
  return <span className={`size-2 rounded-full ${className}`} />;
}

/** EndpointFilters' MultiSelectFilter trigger with nothing selected. */
function Filter({ icon, children }: { icon: ReactNode; children: string }) {
  return (
    <div className="flex h-6 items-center gap-1.5 rounded border border-charcoal-600 bg-secondary pl-1 pr-2 text-xs text-text-bright">
      {icon}
      <span>{children}</span>
    </div>
  );
}

function WebhooksToolbar() {
  return (
    <div className="flex items-start justify-between gap-x-2 p-2">
      <div className="flex flex-row flex-wrap items-center gap-1.5">
        <Filter icon={<I.StatusIcon className="size-4" />}>Status: Active</Filter>
        <Filter icon={<I.WebhooksIcon className="size-4 text-webhooks" />}>Subscriber</Filter>
        <Filter icon={<I.WebhooksIcon className="size-4 text-text-dimmed" />}>Source</Filter>
        <div className="w-56">
          <SearchField placeholder="Search tenant or external ref…" />
        </div>
      </div>
      <Pagination />
    </div>
  );
}

export function WebhooksFigure() {
  return (
    <AppFrame menu={<SideMenu active="Webhooks" open={[]} />}>
      <div className="grid h-full grid-rows-[auto_1fr]">
        <PageHeader title="Webhooks">
          <Button variant="docs" icon={I.BookIcon}>
            Webhooks docs
          </Button>
        </PageHeader>
        <div>
          <WebhooksToolbar />
          {/* Table.tsx's wrapper: whitespace-nowrap, scrolling sideways (clipped here). */}
          <div className="whitespace-nowrap overflow-hidden">
            <div className="table w-full">
              <div className={tableHeader}>
                <div className={tableRow}>
                  <Th>Endpoint</Th>
                  <Th>Source</Th>
                  <Th>Status</Th>
                  <Th>URL</Th>
                  <Th>Signing secret</Th>
                  <Th>Activity (24h)</Th>
                  <Th>Last delivery</Th>
                  <Th right>AI setup</Th>
                </div>
              </div>
              <div className="table-row-group relative">
                {endpoints.map((e, i) => (
                  <div key={e.id} className={tableRow}>
                    <Cell mark={i === 0 ? "endpoint" : undefined}>
                      <span className="flex flex-col">
                        <span className="flex items-center gap-1.5">
                          <I.WebhooksIcon className="size-4 flex-none text-webhooks" />
                          <span className="font-mono text-xs text-text-bright">{e.id}</span>
                        </span>
                      </span>
                    </Cell>
                    <Cell>
                      <span className="text-xs">{e.source}</span>
                    </Cell>
                    <Cell>
                      <span className="flex items-center gap-1.5">
                        <Dot className="bg-success" />
                        <span>Active</span>
                      </span>
                    </Cell>
                    {/* CopyableText, truncate: the copy button only shows on hover. */}
                    <div className={`${td} px-3 py-3 text-left max-w-[18rem]`}>
                      <span className="relative inline-flex h-6 items-center max-w-full pr-7 font-mono text-xs">
                        <span className="min-w-0 truncate">{e.url}</span>
                      </span>
                    </div>
                    <Cell mark={i === 0 ? "signing-secret" : undefined}>
                      <span className="flex items-center gap-1.5">
                        <Dot className={e.ready ? "bg-success" : "bg-warning"} />
                        <span className={e.ready ? undefined : "text-warning"}>
                          {e.ready ? "Ready" : "Needs secret"}
                        </span>
                      </span>
                    </Cell>
                    <Cell pad="px-3 py-1.5">
                      <div style={{ width: 146, height: 24 }}>
                        <ActivitySparkline ok={e.ok} failed={e.failed} />
                      </div>
                    </Cell>
                    <Cell>
                      {e.lastDelivery ? (
                        <span>{e.lastDelivery}</span>
                      ) : (
                        <span className="text-text-dimmed">None in 24h</span>
                      )}
                    </Cell>
                    <div className={`${td} px-3 py-3 text-right`}>
                      <span className="inline-flex">
                        <Button
                          variant="minimal"
                          icon={SparklesIcon}
                          iconClassName="size-3.5 text-text-dimmed"
                          mark={i === 0 ? "setup-prompt" : undefined}
                          markBadge="left"
                        >
                          Copy setup prompt
                        </Button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppFrame>
  );
}
