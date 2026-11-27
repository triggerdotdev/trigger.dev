// A test delivery to the github endpoint, with the Targets tab open: it reached the github-events
// task, and the rail's timeline links to the run it started. The page frame is the endpoint
// page's (webhook-endpoint.tsx, from the dashboard's detail-page storybook); the content is drawn
// from source (the reference dashboard has no deliveries). The side menu is cropped off. The
// webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { ClipboardIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button, PageHeader, tableRow, th } from "./chrome";
import * as I from "./icons";
import { RunTimeline } from "./run-parts";
import { Group, Property, ResizableHandle, Tab } from "./detail-parts";

const DELIVERY = "whd_m4x8q2k7n5";
const RUN = "run_c8k2m4x9q7v3";
// DELIVERY_STATUS_COLOR.SUCCEEDED, the webapp's own hex.
const SUCCEEDED = "#28BF5C";

const link = "inline-text-link text-text-link inline-flex gap-0.5 items-center group";

function Succeeded() {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: SUCCEEDED }} />
      <span>Succeeded</span>
    </span>
  );
}

function RunLink({ size = "size-4" }: { size?: string }) {
  return (
    <span className={`${link} gap-1 font-mono text-xs`}>
      <I.RunsIcon className={`${size} text-runs`} />
      {RUN}
    </span>
  );
}

function Rail() {
  return (
    <div className="flex h-full flex-col gap-1.5 overflow-hidden bg-background-bright pb-4 pt-1">
      <Group title="Timeline">
        {/* DeliveryTimeline: Received, the routing time, Delivered and the run it started. */}
        <div className="mb-4 min-w-fit max-w-full border-b border-grid-dimmed pb-4">
          <RunTimeline
            done
            items={[
              { event: "Received", date: "25 Nov 10:24:31.218 am", marker: "start-cap" },
              { line: "84ms (routing)", thick: true },
              { event: "Delivered", date: "10:24:31.302 am", marker: "end-cap-thick" },
            ]}
          />
          <div className="grid grid-cols-[1.125rem_1fr] gap-1">
            <div />
            <div className="flex flex-col gap-0.5 pb-1">
              <RunLink size="size-3.5" />
            </div>
          </div>
        </div>
      </Group>
      <Group title="Details">
        <div className="flex flex-col gap-y-3">
          <Property label="Status">
            <Succeeded />
          </Property>
          <Property label="Endpoint">
            <span className={`${link} gap-1 font-mono`}>
              <I.WebhooksIcon className="size-4 text-webhooks" />
              github
            </span>
          </Property>
          <Property label="Run">
            <RunLink />
          </Property>
        </div>
      </Group>
    </div>
  );
}

// Table.tsx, "dimmed" variant with a sticky header.
const td = "table-cell align-middle text-xs text-text-dimmed px-3 py-3 text-left";

function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`${td} ${className}`}>{children}</div>;
}

export function WebhookDeliveryFigure() {
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background-dimmed">
      <PageHeader crumbs={["Endpoints", "github"]} title={DELIVERY} detail>
        <Button variant="docs" icon={I.BookIcon}>
          Webhooks docs
        </Button>
      </PageHeader>
      <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden bg-background-dimmed">
        <div className="flex items-end gap-4 border-b border-grid-bright bg-background-bright px-4 pb-3 pt-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="grid size-[46px] flex-none place-items-center rounded-md bg-background-hover">
              <I.WebhooksIcon className="size-5 text-webhooks" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="truncate min-w-0 text-text-bright font-mono text-[1.0625rem] font-medium leading-6">
                  {DELIVERY}
                </span>
                <div className="flex flex-none items-center gap-1 rounded size-6 justify-center text-text-faint">
                  <ClipboardIcon className="size-3.5" />
                </div>
                <div className="flex flex-none items-center gap-1.5">
                  <div className="grid place-items-center border border-border-bright rounded-sm px-1 h-4 text-xxs bg-background-bright text-blue-500 whitespace-nowrap">
                    Test
                  </div>
                </div>
                <div className="flex flex-none items-center text-sm">
                  <Succeeded />
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-text-dimmed">
                <span className="flex shrink-0 items-center gap-1">
                  <span>
                    On <span className="font-mono">github</span>
                  </span>
                </span>
                <span className="size-[3px] flex-none rounded-full bg-surface-control-hover" />
                <span className="flex shrink-0 items-center gap-1">25 Nov 2026, 10:24:31 am</span>
                <span className="size-[3px] flex-none rounded-full bg-surface-control-hover" />
                <span className="flex shrink-0 items-center gap-1">Processed in 84ms</span>
              </div>
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            <Button
              icon={I.RunsIcon}
              iconClassName="-mx-1 text-runs"
              mark="view-run"
              markBadge="below"
            >
              View run
            </Button>
            <Button variant="primary" icon={I.ArrowPathIcon}>
              Replay
            </Button>
          </div>
        </div>
        <div className="flex h-10 shrink-0 border-b border-grid-bright items-stretch gap-x-3 bg-background-bright px-4">
          <div className="flex min-w-0 flex-1 items-stretch gap-x-5">
            <Tab label="Event" />
            <Tab label="Headers" count="4" />
            <Tab label="Targets" count="1" selected mark="targets-tab" />
          </div>
        </div>
        <div className="flex w-full overflow-hidden h-full max-h-full">
          <div className="min-w-0 flex-1">
            <div className="h-full min-h-0 overflow-hidden">
              <div className="whitespace-nowrap overflow-hidden">
                <div className="table w-full">
                  <div className="table-header-group sticky top-0 z-10 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright bg-background-dimmed">
                    <div className={tableRow}>
                      <div className={th}>Target</div>
                      <div className={th}>Type</div>
                      <div className={th}>Status</div>
                      <div className={th}>Detail</div>
                      <div className={th}>Run</div>
                    </div>
                  </div>
                  <div className="table-row-group relative">
                    <div className={tableRow}>
                      <Td>
                        <span data-mark="target" className="font-mono text-xs">
                          github-events
                        </span>
                      </Td>
                      <Td>Task</Td>
                      <Td>
                        <Succeeded />
                      </Td>
                      <Td className="max-w-md whitespace-normal">
                        <span className="text-text-dimmed">None</span>
                      </Td>
                      <Td>
                        <span className="flex flex-col gap-0.5">
                          <span
                            data-mark="target-run"
                            className={`${link} w-fit font-mono text-xs`}
                          >
                            {RUN}
                          </span>
                        </span>
                      </Td>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <ResizableHandle />
          <div className="min-w-0" style={{ width: 320 }}>
            <Rail />
          </div>
        </div>
      </div>
    </div>
  );
}
