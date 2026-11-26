// A finished hello-world run on the run page, without the side menu: the trace tree and its
// timeline, and the inspector open on the run's Overview. Drawn from source and the storybook
// run pages; the webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import type { ReactNode } from "react";
import {
  CodeBlock,
  CompletedStatus,
  ResizeHandle,
  RunHeader,
  RunInspector,
  RunTimeline,
  RunToolbar,
  TraceView,
  type TraceRow,
} from "./run-parts";

const rows: TraceRow[] = [
  {
    kind: "task",
    label: "hello-world",
    depth: 0,
    open: true,
    root: true,
    status: "completed",
    selected: true,
    start: 0,
    duration: 5800,
  },
  {
    kind: "attempt",
    label: "Attempt 1",
    depth: 1,
    open: true,
    status: "cold",
    start: 455,
    duration: 5310,
    events: [45, 280],
  },
  { kind: "function", label: "run()", depth: 2, open: true, start: 470, duration: 5280 },
  { kind: "log", label: "Hello, world!", depth: 3, start: 482 },
  {
    kind: "wait",
    label: "wait.for()",
    badge: "5 seconds",
    depth: 3,
    open: true,
    start: 490,
    duration: 5006,
  },
  { kind: "warn", label: "Waits of 5s or less count towards compute usage.", depth: 4, start: 495 },
];

/** The run page from the toolbar down: tree and timeline, then the inspector at 500px. */
export function RunPageBody({
  inspector,
  trace = rows,
  total = 5800,
}: {
  inspector: ReactNode;
  trace?: TraceRow[];
  /** The run's duration in ms. */
  total?: number;
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] overflow-hidden">
      <RunToolbar />
      <div className="flex w-full overflow-hidden h-full max-h-full min-h-0">
        <div className="min-w-0 flex-1">
          <div className="flex h-full flex-col overflow-hidden">
            <div className="min-h-0 flex-1">
              <TraceView rows={trace} total={total} />
            </div>
          </div>
        </div>
        <ResizeHandle />
        <div className="shrink-0 overflow-hidden" style={{ width: 500 }}>
          <div className="h-full">{inspector}</div>
        </div>
      </div>
    </div>
  );
}

export function RunPageFigure() {
  return (
    <div className="flex h-full flex-col bg-background-dimmed">
      <RunHeader runId="run_cmie3x7k2000107l4hq9s2bxd" />
      <RunPageBody
        inspector={
          <RunInspector task="hello-world" tab="Overview">
            <div className="flex flex-col gap-4 pt-3">
              <CompletedStatus />
              <RunTimeline
                done
                items={[
                  { event: "Triggered", date: "25 Nov 10:42:07.112 am", marker: "start-cap" },
                  { line: "Waited 45 milliseconds" },
                  { event: "Dequeued", date: "10:42:07.157 am", marker: "dot-hollow" },
                  { line: "410 milliseconds" },
                  { event: "Started", date: "10:42:07.567 am", marker: "start-cap-thick" },
                  { line: "5.3 seconds", thick: true },
                  { event: "Finished", date: "10:42:12.912 am", marker: "end-cap-thick" },
                ]}
              />
              <CodeBlock title="Payload" value={{ name: "world" }} />
              <CodeBlock title="Output" value={{ message: "Hello, world!" }} />
            </div>
          </RunInspector>
        }
      />
    </div>
  );
}
