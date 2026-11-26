// The trace of a finished parent-task run, cropped to the tree and its timeline: its logs, a wait,
// and a triggerAndWait() with the child-task run nested under it. Drawn from source and the old
// run log screenshot; the webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { TraceView, type TraceRow } from "./run-parts";

const rows: TraceRow[] = [
  {
    kind: "task",
    label: "parent-task",
    depth: 0,
    open: true,
    root: true,
    status: "completed",
    start: 0,
    duration: 19300,
  },
  {
    kind: "attempt",
    label: "Attempt 1",
    depth: 1,
    open: true,
    status: "cold",
    start: 230,
    duration: 18600,
    events: [20, 130],
  },
  { kind: "function", label: "run()", depth: 2, open: true, start: 240, duration: 18580 },
  { kind: "log", label: "Parent task payload", depth: 3, start: 280 },
  { kind: "warn", label: "You've been warned", depth: 3, start: 285 },
  { kind: "log", label: "This is the parent task context", depth: 3, start: 290 },
  { kind: "log", label: "This is an info message", depth: 3, start: 295 },
  { kind: "error", label: "This is an error message", depth: 3, start: 300 },
  {
    kind: "wait",
    label: "wait.for()",
    badge: "6 seconds",
    depth: 3,
    start: 450,
    duration: 5900,
  },
  {
    kind: "trigger",
    label: "triggerAndWait()",
    badge: "child-task",
    depth: 3,
    open: true,
    start: 6380,
    duration: 11900,
  },
  {
    kind: "task",
    label: "child-task",
    depth: 4,
    open: true,
    status: "completed",
    start: 6500,
    duration: 11300,
  },
  {
    kind: "attempt",
    label: "Attempt 1",
    depth: 5,
    open: true,
    status: "cold",
    start: 7330,
    duration: 10200,
    events: [6560, 6680],
  },
  { kind: "function", label: "run()", depth: 6, open: true, start: 7340, duration: 10180 },
  { kind: "log", label: "Child task payload", depth: 7, start: 7380 },
  {
    kind: "wait",
    label: "wait.for()",
    badge: "10 seconds",
    depth: 7,
    start: 7700,
    duration: 9800,
  },
  { kind: "log", label: "Child task finished", depth: 7, start: 17520 },
  { kind: "log", label: "Child task response", depth: 3, start: 18640 },
  { kind: "trigger", label: "trigger()", depth: 3, start: 18850, duration: 332 },
];

export function RunTraceFigure() {
  return (
    <div className="h-full bg-background-dimmed">
      <TraceView rows={rows} total={19300} footer={false} />
    </div>
  );
}
