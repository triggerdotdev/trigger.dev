// A fetch-todos run on the run page with an auto-instrumented GET span selected: the trace on the
// left, and the span inspector with its timeline, message and HTTP properties. Drawn from source
// and the old auto-instrumentation screenshot; the webapp files it mirrors are its `sources` in
// lib/dashboard-figures.ts.
import { RunPageBody } from "./run-page";
import {
  CodeBlock,
  CompletedStatus,
  MessageProperty,
  RunHeader,
  RunTimeline,
  SpanInspector,
  type TraceRow,
} from "./run-parts";

const rows: TraceRow[] = [
  {
    kind: "task",
    label: "fetch-todos",
    depth: 0,
    open: true,
    root: true,
    status: "completed",
    start: 0,
    duration: 1100,
  },
  {
    kind: "attempt",
    label: "Attempt 1",
    depth: 1,
    open: true,
    status: "cold",
    start: 800,
    duration: 184,
    events: [10, 340],
  },
  { kind: "function", label: "run()", depth: 2, open: true, start: 802, duration: 181 },
  { kind: "span", label: "GET", depth: 3, selected: true, start: 805, duration: 147 },
  { kind: "span", label: "GET", depth: 3, start: 955, duration: 27 },
  { kind: "log", label: "Fetched todo", depth: 3, start: 990 },
];

export function RunPageSpanFigure() {
  return (
    <div className="flex h-full flex-col bg-background-dimmed">
      <RunHeader runId="run_cmie5r1t9000207l4c3n8vk2a" />
      <RunPageBody
        trace={rows}
        total={1100}
        inspector={
          <SpanInspector kind="span" title="GET">
            <CompletedStatus />
            <RunTimeline
              items={[
                { event: "Started", date: "25 Nov 10:42:07.805 am", marker: "start-cap-thick" },
                { line: "147 milliseconds", thick: true },
                { event: "Finished", date: "10:42:07.952 am", marker: "end-cap-thick" },
              ]}
            />
            <MessageProperty message="GET" />
            <CodeBlock
              title="Properties"
              value={{
                http: {
                  request: { method: "GET", method_original: "GET" },
                  response: { status_code: 200 },
                },
                url: {
                  full: "https://example.com/todos/1",
                  path: "/todos/1",
                  query: "",
                  scheme: "https",
                },
                server: { address: "example.com", port: 443 },
              }}
            />
          </SpanInspector>
        }
      />
    </div>
  );
}
