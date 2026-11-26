// The trace of a convert-video run, cropped to the tree and its timeline: child task runs nested
// under their triggerAndWait() spans, with Prisma, HTTP and AWS SDK spans from instrumentations.
// Drawn from source and the old OpenTelemetry screenshot, updated for the task code the page shows;
// the webapp files it mirrors are its `sources` in lib/dashboard-figures.ts.
import { TraceView, type TraceRow } from "./run-parts";

const rows: TraceRow[] = [
  {
    kind: "task",
    label: "convert-video",
    depth: 0,
    open: true,
    root: true,
    status: "completed",
    start: 0,
    duration: 7400,
  },
  {
    kind: "attempt",
    label: "Attempt 1",
    depth: 1,
    open: true,
    status: "cold",
    start: 571,
    duration: 6800,
    events: [10, 420],
  },
  { kind: "function", label: "run()", depth: 2, open: true, start: 575, duration: 6790 },
  {
    kind: "trigger",
    label: "triggerAndWait()",
    badge: "process-video",
    depth: 3,
    open: true,
    start: 600,
    duration: 3500,
  },
  {
    kind: "task",
    label: "process-video",
    depth: 4,
    open: true,
    status: "completed",
    start: 650,
    duration: 3000,
  },
  {
    kind: "attempt",
    label: "Attempt 1",
    depth: 5,
    open: true,
    status: "cold",
    start: 1150,
    duration: 2100,
    events: [660, 900],
  },
  { kind: "function", label: "run()", depth: 6, open: true, start: 1155, duration: 2085 },
  {
    kind: "prisma",
    label: "prisma:client:operation",
    depth: 7,
    open: true,
    start: 1160,
    duration: 53,
  },
  { kind: "prisma", label: "prisma:client:serialize", depth: 8, start: 1162, duration: 0.3 },
  { kind: "prisma", label: "prisma:client:connect", depth: 8, start: 1165, duration: 27 },
  { kind: "prisma", label: "prisma:engine", depth: 8, closed: true, start: 1193, duration: 20 },
  { kind: "span", label: "GET", depth: 7, start: 1215, duration: 420 },
  { kind: "span", label: "ffmpeg", depth: 7, start: 1640, duration: 1100 },
  // The SDK gives offloaded payloads a "cloud-upload" icon, which RunIcon draws as its info icon.
  { kind: "log", label: "store.uploadOutput", depth: 6, start: 2745, duration: 480 },
  { kind: "log", label: "store.downloadPayload", depth: 4, start: 3660, duration: 410 },
  {
    kind: "trigger",
    label: "triggerAndWait()",
    badge: "upload-to-s3",
    depth: 3,
    open: true,
    start: 4110,
    duration: 2200,
  },
  {
    kind: "task",
    label: "upload-to-s3",
    depth: 4,
    open: true,
    status: "completed",
    start: 4160,
    duration: 2100,
  },
  {
    kind: "attempt",
    label: "Attempt 1",
    depth: 5,
    open: true,
    status: "cold",
    start: 5720,
    duration: 520,
    events: [4170, 5600],
  },
  { kind: "function", label: "run()", depth: 6, open: true, start: 5725, duration: 510 },
  { kind: "span", label: "S3.PutObject", depth: 7, start: 5735, duration: 495 },
  {
    kind: "prisma",
    label: "prisma:client:operation",
    depth: 3,
    closed: true,
    start: 6320,
    duration: 41,
  },
  {
    kind: "trigger",
    label: "triggerAndWait()",
    badge: "send-user-email",
    depth: 3,
    closed: true,
    start: 6370,
    duration: 980,
  },
];

export function RunTraceInstrumentedFigure() {
  return (
    <div className="h-full bg-background-dimmed">
      <TraceView rows={rows} total={7400} footer={false} />
    </div>
  );
}
