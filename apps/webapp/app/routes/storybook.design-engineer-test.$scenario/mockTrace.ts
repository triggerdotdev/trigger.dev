import {
  formatErrorCauses,
  millisecondsToNanoseconds,
  type ExceptionEventProperties,
  type MachinePresetName,
  type SpanEvent,
  type TaskEventStyle,
  type TaskRunError,
} from "@trigger.dev/core/v3";
import type { TaskEventLevel, TaskRunStatus } from "@trigger.dev/database";
import type { SpanSummary } from "~/v3/eventRepository/eventRepository.types";
import { buildTraceView, type TraceViewEvent } from "~/v3/eventRepository/traceViewBuilder";
import { isFailedRunStatus } from "~/v3/taskStatus";

// Turns a hand-written scenario (a tree of runs, attempts, spans and logs) into the data the
// run page renders: the trace events for the tree and timeline, plus what the inspector shows
// for each span. Trace events go through the same `buildTraceView` the real page uses.
//
// Times are milliseconds. A node's `at` is relative to its parent's start; leave it out and the
// node starts right after its previous sibling finishes, the way sequential code runs.

type Ms = number;

type Placement = {
  /** Start time, in ms after the parent span started. Omit to follow the previous sibling. */
  at?: Ms;
  /** Gap after the previous sibling when `at` is omitted. Defaults to 1ms. */
  gap?: Ms;
};

type LogLevel = "info" | "warn" | "error";

type MockLog = Placement & {
  kind: "log";
  level: LogLevel;
  message: string;
  properties?: Record<string, unknown>;
};

type MockSpan = Placement & {
  kind: "span";
  message: string;
  /** Defaults to finishing just after the last child, or 0 for a span without children. */
  duration?: Ms;
  icon?: string;
  accessory?: TaskEventStyle["accessory"];
  isError?: boolean;
  properties?: Record<string, unknown>;
  /** Trigger spans list the runs they triggered in the inspector. */
  trigger?: "single" | "batch";
  /** Runs triggered by this span wait in the queue while this many are already running. */
  concurrencyLimit?: number;
  /** The run is checkpointed for the span's duration, e.g. while it waits on other runs. */
  checkpoints?: boolean;
  children?: MockNode[];
};

/** How busy the machine was, which shapes the host metrics recorded for the attempt. */
type AttemptLoad = "normal" | "cpu-bound" | "memory-climb";

type MockAttempt = {
  /** Cold attempts boot a new machine; warm ones reuse one that's already running. */
  startType: "cold" | "warm";
  /** Defaults to the run's machine. Attempts retried after running out of memory move up. */
  machine?: MachinePresetName;
  /** Boot time for the first attempt, the retry delay for later ones. */
  delay?: Ms;
  /** Defaults to finishing just after the last child. */
  duration?: Ms;
  /** Set when the attempt failed. */
  error?: TaskRunError;
  load?: AttemptLoad;
  children: MockNode[];
};

type MockRun = Placement & {
  kind: "run";
  task: string;
  /** Defaults to `src/trigger/<task>.ts`. */
  filePath?: string;
  /** Time between being triggered and being dequeued. */
  queuedFor?: Ms;
  attempts: MockAttempt[];
  payload: unknown;
  output?: unknown;
  /** The error the run failed with. Its status is derived from it. */
  error?: TaskRunError;
  machine?: MachinePresetName;
  maxAttempts?: number;
  maxDurationInSeconds?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  queue?: string;
  concurrencyKey?: string;
};

type MockNode = MockRun | MockSpan | MockLog;

// ---------------------------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------------------------

function codepath(text: string): TaskEventStyle["accessory"] {
  return { items: [{ text, variant: "normal" }], style: "codepath" };
}

function logNode(level: LogLevel) {
  return (
    message: string,
    properties?: Record<string, unknown>,
    placement?: Placement
  ): MockLog => ({
    kind: "log",
    level,
    message,
    properties,
    ...placement,
  });
}

/** `logger.info()` and friends. */
export const log = {
  info: logNode("info"),
  warn: logNode("warn"),
  error: logNode("error"),
};

type SpanOptions = Omit<MockSpan, "kind" | "message" | "children">;

/** A `logger.trace()` span, unless you pass another icon. */
export function span(message: string, options: SpanOptions = {}, children?: MockNode[]): MockSpan {
  return { kind: "span", message, icon: "trace", ...options, children };
}

/** An auto-instrumented HTTP request. These carry no icon of their own. */
export function httpRequest(
  method: string,
  url: string,
  options: SpanOptions & { status?: number } = {}
): MockSpan {
  const { status = 200, ...rest } = options;
  return {
    kind: "span",
    message: `${method} ${url}`,
    ...rest,
    properties: {
      http: { method, url, status_code: status },
      ...rest.properties,
    },
  };
}

/** The task's `run()` function. */
export function runFunction(children: MockNode[], options: SpanOptions = {}): MockSpan {
  return span("run()", { icon: "task-fn-run", ...options }, children);
}

/** A lifecycle hook registered in `trigger.config.ts`, e.g. `onStart()`. */
export function hook(
  name: "init" | "onStart" | "onSuccess" | "onFailure" | "onComplete" | "cleanup",
  duration: Ms,
  placement?: Placement
): MockSpan {
  return span(`${name}()`, {
    icon: `task-hook-${name}`,
    accessory: codepath("global"),
    duration,
    ...placement,
  });
}

/** `wait.for()`. Short waits keep the machine running, which the SDK warns about. */
export function waitFor(seconds: number, placement?: Placement): MockSpan {
  return span(
    "wait.for()",
    {
      icon: "wait",
      accessory: codepath(`${seconds} ${seconds === 1 ? "second" : "seconds"}`),
      duration: seconds * 1000 + 2,
      checkpoints: seconds > 5,
      ...placement,
    },
    seconds <= 5
      ? [log.warn("Waits of 5s or less count towards compute usage.", undefined, { at: 1 })]
      : undefined
  );
}

/** `task.triggerAndWait()`. The child run is created shortly after the call. */
export function triggerAndWait(child: MockRun, placement?: Placement): MockSpan {
  return span(
    "triggerAndWait()",
    {
      icon: "trigger",
      accessory: codepath(child.task),
      trigger: "single",
      checkpoints: true,
      ...placement,
    },
    [{ ...child, at: child.at ?? 72 }]
  );
}

/** `task.batchTriggerAndWait()`. The child runs are created together. */
export function batchTriggerAndWait(
  task: string,
  children: MockRun[],
  options: Placement & Pick<MockSpan, "concurrencyLimit"> = {}
): MockSpan {
  return span(
    "batchTriggerAndWait()",
    { icon: "trigger", accessory: codepath(task), trigger: "batch", checkpoints: true, ...options },
    children.map((child, index) => ({ ...child, at: child.at ?? 64 + index * 7 }))
  );
}

/** `batch.triggerAndWait()`, which can trigger runs of different tasks. */
export function batchTriggerAndWaitTasks(children: MockRun[], placement?: Placement): MockSpan {
  return span(
    "batch.triggerAndWait()",
    { icon: "trigger", trigger: "batch", checkpoints: true, ...placement },
    children.map((child, index) => ({ ...child, at: child.at ?? 64 + index * 7 }))
  );
}

export type RunOptions = Omit<MockRun, "kind" | "task">;

export function run(task: string, options: RunOptions): MockRun {
  return { kind: "run", task, ...options };
}

export function attempt(
  startType: MockAttempt["startType"],
  children: MockNode[],
  options: Omit<MockAttempt, "startType" | "children"> = {}
): MockAttempt {
  return { startType, children, ...options };
}

// ---------------------------------------------------------------------------------------------
// The world every scenario runs in
// ---------------------------------------------------------------------------------------------

export const mockOrganization = {
  id: "cmf4q2w8r0000l70a3xk9d1zp",
  slug: "acme-4f2a",
  title: "Acme",
};

export const mockProject = {
  id: "cmf4q2wc10002l70ap8s6n2vb",
  slug: "storefront-Xk3P",
  name: "storefront",
  externalRef: "proj_kxqvbtnzrmhwsjpldyce",
};

export const mockEnvironment = {
  id: "cmf4q2wfj0004l70a7mhe5c0q",
  slug: "prod",
  type: "PRODUCTION" as const,
};

const deployment = {
  id: "cmg9x4k2v0011qa0f8z3b6wte",
  shortCode: "j8t2zq4x",
  version: "20261006.4",
  sdkVersion: "4.7.3",
  runtime: "node-22",
  runtimeVersion: "22.20.0",
};

const region = { name: "eu-central-1", location: "europe" };

// Published cloud prices, converted to cents per millisecond.
const machines: Record<
  MachinePresetName,
  { title: string; cpu: number; memory: number; centsPerMs: number }
> = {
  micro: { title: "Micro", cpu: 0.25, memory: 0.25, centsPerMs: 0.00000169 },
  "small-1x": { title: "Small 1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.00000338 },
  "small-2x": { title: "Small 2x", cpu: 1, memory: 1, centsPerMs: 0.00000675 },
  "medium-1x": { title: "Medium 1x", cpu: 1, memory: 2, centsPerMs: 0.0000085 },
  "medium-2x": { title: "Medium 2x", cpu: 2, memory: 4, centsPerMs: 0.000017 },
  "large-1x": { title: "Large 1x", cpu: 4, memory: 8, centsPerMs: 0.000034 },
  "large-2x": { title: "Large 2x", cpu: 8, memory: 16, centsPerMs: 0.000068 },
};

const RUN_INVOCATION_COST_IN_CENTS = 0.0025;
const DEFAULT_MAX_DURATION_IN_SECONDS = 3600;

// ---------------------------------------------------------------------------------------------
// What the page renders
// ---------------------------------------------------------------------------------------------

export type MockTraceEvent = TraceViewEvent;

type MockRunRelationship = { taskIdentifier: string; friendlyId: string; spanId: string };

/** What the inspector shows for a span that is a task run. Mirrors `SpanRun`. */
export type MockRunDetails = {
  friendlyId: string;
  spanId: string;
  taskIdentifier: string;
  status: TaskRunStatus;
  createdAt: Date;
  startedAt: Date;
  executedAt: Date;
  updatedAt: Date;
  completedAt: Date;
  isFinished: boolean;
  isError: boolean;
  ttl: string | null;
  version: string;
  sdkVersion: string;
  runtime: string;
  runtimeVersion: string;
  isTest: boolean;
  idempotencyKey?: string;
  idempotencyKeyScope?: string;
  idempotencyKeyStatus?: "active" | "inactive" | "expired";
  idempotencyKeyExpiresAt?: Date;
  queue: { name: string; concurrencyKey: string | null };
  tags: string[];
  maxDurationInSeconds: number;
  machinePreset: MachinePresetName;
  region: { name: string; location: string | null };
  baseCostInCents: number;
  costInCents: number;
  usageDurationMs: number;
  engine: "V2";
  payload: string;
  payloadType: string;
  output?: string;
  outputType: string;
  error?: TaskRunError;
  relationships: {
    root?: MockRunRelationship & { isParent: boolean };
    parent?: MockRunRelationship;
  };
  batch?: { friendlyId: string };
  context: string;
  metadata?: string;
};

/**
 * Host metrics for one attempt, in the 10-second buckets the platform already records
 * (`process.cpu.utilization`, `process.memory.usage`, `nodejs.heap.used` and
 * `nodejs.event_loop.utilization` in the metrics table). The run page doesn't show them yet.
 */
type MockAttemptMetrics = {
  machine: MachinePresetName;
  /** vCPUs available to the attempt. */
  cpu: number;
  /** Memory available to the attempt, in GB. */
  memoryGb: number;
  samples: Array<{
    /** Start of the bucket, in ms after the attempt started. */
    offsetMs: number;
    /** Share of the machine's vCPUs in use, 0–1. */
    cpuUtilization: number;
    /** Resident memory, in bytes. */
    memoryBytes: number;
    heapUsedBytes: number;
    /** 1 means the event loop never got a break. */
    eventLoopUtilization: number;
  }>;
};

/** What the inspector shows for any other span. Mirrors `Span`. */
export type MockSpanDetails = {
  spanId: string;
  parentId: string | undefined;
  message: string;
  isError: boolean;
  isPartial: boolean;
  isCancelled: boolean;
  level: TaskEventLevel;
  startTime: Date;
  /** Nanoseconds. */
  duration: number;
  events: SpanEvent[];
  style: TaskEventStyle;
  properties: string | undefined;
  triggeredRuns: Array<{
    friendlyId: string;
    taskIdentifier: string;
    spanId: string;
    createdAt: Date;
    status: TaskRunStatus;
  }>;
  /** Only set on attempts. */
  metrics?: MockAttemptMetrics;
};

export type MockSpanEntry =
  | { type: "run"; run: MockRunDetails }
  | { type: "span"; span: MockSpanDetails };

export type RunPageScenario = {
  /** The run the page is for, as the page header sees it. */
  run: {
    friendlyId: string;
    spanId: string;
    status: TaskRunStatus;
    isFinished: boolean;
    completedAt: Date;
  };
  trace: {
    events: MockTraceEvent[];
    /** Nanoseconds. */
    duration: number;
    rootStartedAt: Date | undefined;
    rootSpanStatus: "executing" | "completed" | "failed";
    /** Nanoseconds the root run spent queued. */
    queuedDuration: number;
  };
  spans: Record<string, MockSpanEntry>;
};

// ---------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------

const DEFAULT_QUEUED_FOR = 110;
/** A queued run is dequeued this long after a slot frees up. */
const DEQUEUE_LATENCY_MS = 18;
/** Boot time between being dequeued and the first attempt starting. */
const COLD_START_MS = 1240;
const WARM_START_MS = 64;
/** A waiting parent resumes shortly after its children finish. */
const TRIGGER_RESUME_MS = 24;
const METRICS_BUCKET_MS = 10_000;
const MB = 1024 * 1024;

export function buildRunPageScenario({
  seed,
  triggeredAt,
  run: rootRun,
}: {
  /** Makes the generated ids and metrics stable, so server and client renders match. */
  seed: number;
  triggeredAt: Date;
  run: MockRun;
}): RunPageScenario {
  const ids = createIdGenerator(seed);
  const root = placeRun(rootRun, 0, ids);

  const ctx: EmitContext = {
    ids,
    root,
    spans: [],
    entries: {},
    queueIds: new Map(),
    date: (offset) => new Date(triggeredAt.getTime() + offset),
  };
  emitRun(root, { spanId: undefined, runId: root.friendlyId }, ctx);

  const view = buildTraceView(ctx.spans, {
    rootSpanId: root.id,
    runFriendlyId: root.friendlyId,
    isAgentRun: false,
    // Admins see extra startup events; the scenarios show what customers see.
    isAdmin: false,
  });

  return {
    run: {
      friendlyId: root.friendlyId,
      spanId: root.id,
      status: root.status,
      isFinished: true,
      completedAt: ctx.date(root.end),
    },
    trace: {
      events: view.events,
      duration: view.duration,
      rootStartedAt: view.rootStartedAt,
      rootSpanStatus: view.rootSpanStatus,
      queuedDuration: millisecondsToNanoseconds(root.dequeuedAt - root.start),
    },
    spans: ctx.entries,
  };
}

type IdGenerator = ReturnType<typeof createIdGenerator>;

function createIdGenerator(seed: number) {
  const random = seededRandom(seed);
  const pick = (alphabet: string, length: number) =>
    Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  const hex = "0123456789abcdef";
  const alphanumeric = "0123456789abcdefghijklmnopqrstuvwxyz";
  const cuid = () => `cm${pick(alphanumeric, 23)}`;

  return {
    random,
    cuid,
    spanId: () => pick(hex, 16),
    runId: () => `run_${cuid()}`,
    batchId: () => `batch_${cuid()}`,
  };
}

// mulberry32
function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Layout: absolute start and end times (ms after the root run was triggered) for every node.

type PlacedLog = { kind: "log"; node: MockLog; id: string; start: Ms; end: Ms };

type PlacedSpan = {
  kind: "span";
  node: MockSpan;
  id: string;
  start: Ms;
  end: Ms;
  children: Placed[];
  batchId?: string;
};

type PlacedAttempt = {
  node: MockAttempt;
  id: string;
  number: number;
  machine: MachinePresetName;
  start: Ms;
  end: Ms;
  children: Placed[];
  /** When the run was checkpointed, so wasn't using its machine. */
  suspended: Array<{ start: Ms; end: Ms }>;
};

type PlacedRetryDelay = {
  id: string;
  number: number;
  start: Ms;
  end: Ms;
  afterOutOfMemory: boolean;
  nextMachine?: MachinePresetName;
};

type PlacedRun = {
  kind: "run";
  node: MockRun;
  id: string;
  friendlyId: string;
  start: Ms;
  end: Ms;
  dequeuedAt: Ms;
  executedAt: Ms;
  attempts: PlacedAttempt[];
  retryDelays: PlacedRetryDelay[];
  status: TaskRunStatus;
};

type Placed = PlacedLog | PlacedSpan | PlacedRun;

function placeChildren(
  nodes: MockNode[],
  parentStart: Ms,
  ids: IdGenerator,
  concurrencyLimit?: number
) {
  let cursor = parentStart;
  let end = parentStart;
  // When each run holding one of the queue's slots finishes.
  let running: Ms[] = [];

  const placed = nodes.map((node) => {
    const start = node.at !== undefined ? parentStart + node.at : cursor + (node.gap ?? 1);
    let result: Placed;

    if (node.kind === "run" && concurrencyLimit !== undefined) {
      let queuedFor = node.queuedFor ?? DEFAULT_QUEUED_FOR;
      running = running
        .filter((finishedAt) => finishedAt > start + queuedFor)
        .sort((a, b) => a - b);
      const freedSlot = running.length >= concurrencyLimit ? running.shift() : undefined;
      if (freedSlot !== undefined) {
        queuedFor = Math.max(queuedFor, freedSlot + DEQUEUE_LATENCY_MS - start);
      }
      result = placeRun({ ...node, queuedFor }, start, ids);
      running.push(result.end);
    } else {
      result = placeNode(node, start, ids);
    }

    cursor = result.end;
    end = Math.max(end, result.end);
    return result;
  });

  return { placed, end };
}

function placeNode(node: MockNode, start: Ms, ids: IdGenerator): Placed {
  switch (node.kind) {
    case "log": {
      return { kind: "log", node, id: ids.spanId(), start, end: start };
    }
    case "span": {
      const id = ids.spanId();
      const batchId = node.trigger === "batch" ? ids.batchId() : undefined;
      const { placed, end } = placeChildren(node.children ?? [], start, ids, node.concurrencyLimit);
      const duration =
        node.duration ??
        (placed.length > 0 ? end - start + (node.trigger ? TRIGGER_RESUME_MS : 1) : 0);
      return { kind: "span", node, id, start, end: start + duration, children: placed, batchId };
    }
    case "run": {
      return placeRun(node, start, ids);
    }
  }
}

function placeRun(node: MockRun, start: Ms, ids: IdGenerator): PlacedRun {
  const id = ids.spanId();
  const friendlyId = ids.runId();
  const dequeuedAt = start + (node.queuedFor ?? DEFAULT_QUEUED_FOR);
  const executedAt = dequeuedAt + 36;
  const runMachine = node.machine ?? "small-1x";

  const attempts: PlacedAttempt[] = [];
  const retryDelays: PlacedRetryDelay[] = [];

  node.attempts.forEach((attempt, index) => {
    const previous = attempts.at(-1);
    const machine = attempt.machine ?? runMachine;
    const bootTime = attempt.startType === "cold" ? COLD_START_MS : WARM_START_MS;

    let attemptStart = executedAt + (attempt.delay ?? bootTime);
    if (previous) {
      const delayStart = previous.end + 92;
      const delayEnd = delayStart + (attempt.delay ?? 1000);
      retryDelays.push({
        id: ids.spanId(),
        number: index,
        start: delayStart,
        end: delayEnd,
        afterOutOfMemory: isOutOfMemoryError(previous.node.error),
        nextMachine: machine !== previous.machine ? machine : undefined,
      });
      attemptStart = delayEnd + bootTime;
    }

    const attemptId = ids.spanId();
    const { placed, end } = placeChildren(attempt.children, attemptStart, ids);
    attempts.push({
      node: attempt,
      id: attemptId,
      number: index + 1,
      machine,
      start: attemptStart,
      end: attempt.duration !== undefined ? attemptStart + attempt.duration : end + 3,
      children: placed,
      suspended: suspendedIntervals(placed),
    });
  });

  return {
    kind: "run",
    node,
    id,
    friendlyId,
    start,
    end: (attempts.at(-1)?.end ?? executedAt) + 7,
    dequeuedAt,
    executedAt,
    attempts,
    retryDelays,
    status: node.error ? statusForError(node.error) : "COMPLETED_SUCCESSFULLY",
  };
}

// While a run is checkpointed its machine is released, so that time isn't billed and records
// no metrics.
function suspendedIntervals(children: Placed[]): Array<{ start: Ms; end: Ms }> {
  return children.flatMap((child) => {
    if (child.kind !== "span") {
      return [];
    }
    if (child.node.checkpoints) {
      return [{ start: child.start, end: child.end }];
    }
    return suspendedIntervals(child.children);
  });
}

/** How long the attempt used its machine. */
function activeDuration(attempt: PlacedAttempt) {
  return attempt.suspended.reduce(
    (total, interval) => total - (interval.end - interval.start),
    attempt.end - attempt.start
  );
}

// Mirrors runStatusFromError in the run engine, for a production environment.
function statusForError(error: TaskRunError): TaskRunStatus {
  if (error.type !== "INTERNAL_ERROR") {
    return "COMPLETED_WITH_ERRORS";
  }

  switch (error.code) {
    case "MAX_DURATION_EXCEEDED":
      return "TIMED_OUT";
    case "TASK_RUN_STALLED_EXECUTING":
    case "TASK_RUN_STALLED_EXECUTING_WITH_WAITPOINTS":
    case "TASK_RUN_UNCAUGHT_EXCEPTION":
      return "COMPLETED_WITH_ERRORS";
    case "TASK_PROCESS_OOM_KILLED":
    case "TASK_PROCESS_MAYBE_OOM_KILLED":
    case "TASK_PROCESS_SIGSEGV":
    case "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE":
    case "TASK_RUN_CRASHED":
      return "CRASHED";
    default:
      return "SYSTEM_FAILURE";
  }
}

function isOutOfMemoryError(error: TaskRunError | undefined) {
  return (
    error?.type === "INTERNAL_ERROR" &&
    (error.code === "TASK_PROCESS_OOM_KILLED" || error.code === "TASK_PROCESS_MAYBE_OOM_KILLED")
  );
}

// Mirrors createExceptionPropertiesFromError, which records a failed attempt on its span.
function exceptionFromError(error: TaskRunError): ExceptionEventProperties {
  switch (error.type) {
    case "BUILT_IN_ERROR":
      return {
        type: error.name,
        message: `${error.message}${formatErrorCauses(error.causes)}`,
        stacktrace: `${error.stackTrace}${formatErrorCauses(error.causes, { stackTrace: true })}`,
      };
    case "INTERNAL_ERROR":
      return {
        type: "Internal error",
        message: [error.code, error.message].filter(Boolean).join(": "),
        stacktrace: error.stackTrace,
      };
    case "CUSTOM_ERROR":
    case "STRING_ERROR":
      return { type: "Error", message: error.raw };
  }
}

// Emitting: the span summaries the trace view is built from, and an inspector entry per span.

type EmitContext = {
  ids: IdGenerator;
  root: PlacedRun;
  spans: SpanSummary[];
  entries: Record<string, MockSpanEntry>;
  queueIds: Map<string, string>;
  /** The wall-clock time of an offset. */
  date: (offset: Ms) => Date;
};

type Parent = {
  spanId: string | undefined;
  /** The run the span belongs to. */
  runId: string;
  attemptNumber?: number;
  /** Set for the direct children of a failed attempt. */
  inFailedAttempt?: boolean;
  /** The closest run above the span. */
  run?: PlacedRun;
  /** Set for the runs a batch trigger span created. */
  batchId?: string;
};

type SpanInput = {
  id: string;
  parent: Parent;
  message: string;
  style: TaskEventStyle;
  level?: TaskEventLevel;
  start: Ms;
  end: Ms;
  isError?: boolean;
  events?: SpanEvent[];
  properties?: Record<string, unknown>;
  triggeredRuns?: MockSpanDetails["triggeredRuns"];
  metrics?: MockAttemptMetrics;
};

function pushSpan(input: SpanInput, ctx: EmitContext) {
  const { id, parent, message, style, level = "TRACE", start, end, isError = false } = input;
  const events = input.events ?? [];
  const startTime = ctx.date(start);
  const duration = millisecondsToNanoseconds(end - start);

  ctx.spans.push({
    id,
    parentId: parent.spanId,
    runId: parent.runId,
    data: {
      message,
      style,
      events,
      startTime,
      duration,
      isError,
      isPartial: false,
      isCancelled: false,
      isDebug: false,
      level,
      attemptNumber: parent.attemptNumber,
    },
  });

  ctx.entries[id] = {
    type: "span",
    span: {
      spanId: id,
      parentId: parent.spanId,
      message,
      isError,
      isPartial: false,
      isCancelled: false,
      level,
      startTime,
      duration,
      events,
      style,
      properties: input.properties ? JSON.stringify(input.properties, null, 2) : undefined,
      triggeredRuns: input.triggeredRuns ?? [],
      metrics: input.metrics,
    },
  };
}

function emitChildren(children: Placed[], parent: Parent, ctx: EmitContext) {
  // Siblings are listed in start order, like a trace read back from the event store.
  for (const child of [...children].sort((a, b) => a.start - b.start)) {
    switch (child.kind) {
      case "log":
        emitLog(child, parent, ctx);
        break;
      case "span":
        emitSpan(child, parent, ctx);
        break;
      case "run":
        emitRun(child, parent, ctx);
        break;
    }
  }
}

const logStyles: Record<LogLevel, { icon: string; level: TaskEventLevel }> = {
  info: { icon: "info", level: "INFO" },
  warn: { icon: "warn", level: "WARN" },
  error: { icon: "error", level: "ERROR" },
};

function emitLog(placed: PlacedLog, parent: Parent, ctx: EmitContext) {
  const { icon, level } = logStyles[placed.node.level];
  pushSpan(
    {
      id: placed.id,
      parent,
      message: placed.node.message,
      style: { icon },
      level,
      start: placed.start,
      end: placed.end,
      properties: placed.node.properties,
    },
    ctx
  );
}

function emitSpan(placed: PlacedSpan, parent: Parent, ctx: EmitContext) {
  const { node } = placed;
  const triggered = placed.children.filter((child): child is PlacedRun => child.kind === "run");

  let properties = node.properties;
  if (node.trigger === "single" && triggered[0]) {
    properties = { runId: triggered[0].friendlyId };
  } else if (node.trigger === "batch") {
    properties = { batchId: placed.batchId, runCount: triggered.length };
  }

  pushSpan(
    {
      id: placed.id,
      parent,
      message: node.message,
      style: { icon: node.icon, accessory: node.accessory },
      start: placed.start,
      end: placed.end,
      // An error thrown in run() fails the attempt it ran in.
      isError: node.isError || (parent.inFailedAttempt === true && node.icon === "task-fn-run"),
      properties,
      triggeredRuns: triggered.map((child) => ({
        friendlyId: child.friendlyId,
        taskIdentifier: child.node.task,
        spanId: child.id,
        createdAt: ctx.date(child.start),
        status: child.status,
      })),
    },
    ctx
  );

  emitChildren(
    placed.children,
    { ...parent, spanId: placed.id, inFailedAttempt: false, batchId: placed.batchId },
    ctx
  );
}

function emitRun(placed: PlacedRun, parent: Parent, ctx: EmitContext) {
  const { node } = placed;

  ctx.spans.push({
    id: placed.id,
    parentId: parent.spanId,
    runId: placed.friendlyId,
    data: {
      message: node.task,
      style: { icon: "task", variant: "primary" },
      events: [],
      startTime: ctx.date(placed.start),
      duration: millisecondsToNanoseconds(placed.end - placed.start),
      isError: isFailedRunStatus(placed.status),
      isPartial: false,
      isCancelled: false,
      isDebug: false,
      level: "TRACE",
    },
  });
  ctx.entries[placed.id] = { type: "run", run: runDetails(placed, parent, ctx) };

  const runParent: Parent = { spanId: placed.id, runId: placed.friendlyId, run: placed };
  const steps = [
    ...placed.attempts.map((attempt) => ({ start: attempt.start, attempt })),
    ...placed.retryDelays.map((retryDelay) => ({ start: retryDelay.start, retryDelay })),
  ].sort((a, b) => a.start - b.start);

  for (const step of steps) {
    if ("attempt" in step) {
      emitAttempt(step.attempt, placed, runParent, ctx);
    } else {
      const { retryDelay } = step;
      pushSpan(
        {
          id: retryDelay.id,
          parent: runParent,
          message: `Retry #${retryDelay.number} delay${retryDelay.afterOutOfMemory ? " after OOM" : ""}`,
          style: { icon: "play" },
          start: retryDelay.start,
          end: retryDelay.end,
          properties: {
            retryAt: ctx.date(retryDelay.end).toISOString(),
            ...(retryDelay.nextMachine ? { nextMachine: retryDelay.nextMachine } : {}),
          },
        },
        ctx
      );
    }
  }
}

function emitAttempt(attempt: PlacedAttempt, run: PlacedRun, runParent: Parent, ctx: EmitContext) {
  const { error } = attempt.node;
  const events: SpanEvent[] = attempt.number === 1 ? startupEvents(attempt, run, ctx) : [];
  if (error) {
    events.push({
      name: "exception",
      time: ctx.date(attempt.end),
      properties: { exception: exceptionFromError(error) },
    });
  }

  pushSpan(
    {
      id: attempt.id,
      parent: { ...runParent, attemptNumber: attempt.number },
      message: `Attempt ${attempt.number}`,
      style: { icon: "attempt", variant: attempt.node.startType },
      start: attempt.start,
      end: attempt.end,
      isError: error !== undefined,
      events,
      // The SDK records thrown errors on the attempt; a killed process can't.
      properties:
        error?.type === "BUILT_IN_ERROR"
          ? { error: { message: error.message, name: error.name, stackTrace: error.stackTrace } }
          : undefined,
      metrics: attemptMetrics(attempt, ctx.ids.random),
    },
    ctx
  );

  emitChildren(
    attempt.children,
    {
      ...runParent,
      spanId: attempt.id,
      attemptNumber: attempt.number,
      inFailedAttempt: error !== undefined,
    },
    ctx
  );
}

// The run's startup, recorded on its first attempt. Customers see when it was dequeued and,
// for a cold start, when the process launched.
function startupEvents(attempt: PlacedAttempt, run: PlacedRun, ctx: EmitContext): SpanEvent[] {
  const startEvent = (offset: Ms, properties: Record<string, unknown>): SpanEvent => ({
    name: "trigger.dev/start",
    time: ctx.date(offset),
    properties,
  });
  const file = run.node.filePath ?? `src/trigger/${run.node.task}.ts`;

  const events = [
    startEvent(run.dequeuedAt + 4, { duration: 0, event: "dequeue" }),
    startEvent(run.dequeuedAt + 11, { duration: 71, event: "create_attempt" }),
  ];

  if (attempt.node.startType === "cold") {
    events.push(
      startEvent(run.dequeuedAt + 96, { duration: 612, event: "pod_scheduled" }),
      startEvent(attempt.start - 318, { duration: 287, event: "fork" }),
      startEvent(attempt.start - 9, { duration: 4, event: "import", file })
    );
  } else {
    events.push(startEvent(attempt.start - 6, { duration: 2, event: "import", file }));
  }

  return events;
}

function attemptMetrics(attempt: PlacedAttempt, random: () => number): MockAttemptMetrics {
  const machine = machines[attempt.machine];
  const memoryLimit = machine.memory * 1024 * MB;
  const duration = attempt.end - attempt.start;
  const jitter = (spread: number) => (random() - 0.5) * spread;
  const ratio = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;

  const bucketOffsets = Array.from(
    { length: Math.max(1, Math.ceil(duration / METRICS_BUCKET_MS)) },
    (_, index) => index * METRICS_BUCKET_MS
  ).filter(
    (offset) =>
      !attempt.suspended.some(
        ({ start, end }) => attempt.start + offset >= start && attempt.start + offset < end
      )
  );

  const samples = bucketOffsets.map((offsetMs) => {
    // How far through the attempt the bucket ends, so a climb peaks in the last one.
    const progress = Math.min(1, (offsetMs + METRICS_BUCKET_MS) / duration);

    switch (attempt.node.load ?? "normal") {
      case "cpu-bound": {
        const memoryBytes = Math.round((290 + jitter(30)) * MB);
        return {
          offsetMs,
          cpuUtilization: ratio(0.97 + jitter(0.05)),
          memoryBytes,
          heapUsedBytes: Math.round(memoryBytes * 0.62),
          eventLoopUtilization: ratio(0.99 + jitter(0.02)),
        };
      }
      case "memory-climb": {
        const memoryBytes = Math.round(180 * MB + (memoryLimit - 180 * MB) * progress ** 1.6);
        return {
          offsetMs,
          // Garbage collection works harder as the heap fills up.
          cpuUtilization: ratio(0.42 + 0.5 * progress + jitter(0.06)),
          memoryBytes,
          heapUsedBytes: Math.round(memoryBytes * 0.84),
          eventLoopUtilization: ratio(0.4 + 0.55 * progress + jitter(0.05)),
        };
      }
      case "normal": {
        const memoryBytes = Math.round((150 + random() * 45) * MB);
        return {
          offsetMs,
          cpuUtilization: ratio(0.08 + random() * 0.2),
          memoryBytes,
          heapUsedBytes: Math.round(memoryBytes * 0.38),
          eventLoopUtilization: ratio(0.1 + random() * 0.25),
        };
      }
    }
  });

  return { machine: attempt.machine, cpu: machine.cpu, memoryGb: machine.memory, samples };
}

function runDetails(placed: PlacedRun, parent: Parent, ctx: EmitContext): MockRunDetails {
  const { node, attempts } = placed;
  const lastAttempt = attempts.at(-1);
  const machine = lastAttempt?.machine ?? node.machine ?? "small-1x";
  const usageDurationMs = attempts.reduce((total, a) => total + activeDuration(a), 0);
  const costInCents = attempts.reduce(
    (total, a) => total + activeDuration(a) * machines[a.machine].centsPerMs,
    0
  );
  const queueName = node.queue ?? `task/${node.task}`;
  const isError = isFailedRunStatus(placed.status);
  const parentRun = parent.run;
  const { root } = ctx;

  const relationships: MockRunDetails["relationships"] = parentRun
    ? {
        root: {
          taskIdentifier: root.node.task,
          friendlyId: root.friendlyId,
          spanId: root.id,
          isParent: parentRun === root,
        },
        parent: {
          taskIdentifier: parentRun.node.task,
          friendlyId: parentRun.friendlyId,
          spanId: parentRun.id,
        },
      }
    : {};

  let queueId = ctx.queueIds.get(queueName);
  if (!queueId) {
    queueId = `queue_${ctx.ids.cuid()}`;
    ctx.queueIds.set(queueName, queueId);
  }

  const context = {
    run: {
      id: placed.friendlyId,
      tags: node.tags ?? [],
      isTest: false,
      isReplay: false,
      createdAt: ctx.date(placed.start),
      startedAt: ctx.date(placed.dequeuedAt),
      ...(node.idempotencyKey ? { idempotencyKey: node.idempotencyKey } : {}),
      maxAttempts: node.maxAttempts ?? 3,
      version: deployment.version,
      maxDuration: node.maxDurationInSeconds ?? DEFAULT_MAX_DURATION_IN_SECONDS,
      ...(parentRun
        ? { parentTaskRunId: parentRun.friendlyId, rootTaskRunId: root.friendlyId }
        : {}),
    },
    attempt: {
      number: lastAttempt?.number ?? 1,
      startedAt: ctx.date(lastAttempt?.start ?? placed.executedAt),
    },
    task: { id: node.task, filePath: node.filePath ?? `src/trigger/${node.task}.ts` },
    queue: { id: queueId, name: queueName },
    organization: {
      id: mockOrganization.id,
      name: mockOrganization.title,
      slug: mockOrganization.slug,
    },
    project: {
      id: mockProject.id,
      name: mockProject.name,
      slug: mockProject.slug,
      ref: mockProject.externalRef,
    },
    machine: { name: machine, code: machine, ...machines[machine] },
    environment: mockEnvironment,
    deployment: {
      id: `deployment_${deployment.id}`,
      shortCode: deployment.shortCode,
      version: deployment.version,
      runtime: deployment.runtime,
      runtimeVersion: deployment.runtimeVersion,
    },
    ...(parent.batchId ? { batch: { id: parent.batchId } } : {}),
  };

  return {
    friendlyId: placed.friendlyId,
    spanId: placed.id,
    taskIdentifier: node.task,
    status: placed.status,
    createdAt: ctx.date(placed.start),
    startedAt: ctx.date(placed.dequeuedAt),
    executedAt: ctx.date(placed.executedAt),
    updatedAt: ctx.date(placed.end),
    completedAt: ctx.date(placed.end),
    isFinished: true,
    isError,
    ttl: null,
    version: deployment.version,
    sdkVersion: deployment.sdkVersion,
    runtime: deployment.runtime,
    runtimeVersion: deployment.runtimeVersion,
    isTest: false,
    ...(node.idempotencyKey
      ? {
          idempotencyKey: node.idempotencyKey,
          idempotencyKeyScope: "run",
          // Failed runs release their key so the work can be triggered again.
          idempotencyKeyStatus: isError ? ("inactive" as const) : ("active" as const),
          idempotencyKeyExpiresAt: ctx.date(placed.start + 30 * 24 * 60 * 60 * 1000),
        }
      : {}),
    queue: { name: queueName, concurrencyKey: node.concurrencyKey ?? null },
    tags: node.tags ?? [],
    maxDurationInSeconds: node.maxDurationInSeconds ?? DEFAULT_MAX_DURATION_IN_SECONDS,
    machinePreset: machine,
    region,
    baseCostInCents: RUN_INVOCATION_COST_IN_CENTS,
    costInCents,
    usageDurationMs,
    engine: "V2",
    payload: JSON.stringify(node.payload, null, 2),
    payloadType: "application/json",
    output:
      node.error === undefined && node.output !== undefined
        ? JSON.stringify(node.output, null, 2)
        : undefined,
    outputType: "application/json",
    error: node.error,
    relationships,
    batch: parent.batchId ? { friendlyId: parent.batchId } : undefined,
    context: JSON.stringify(context, null, 2),
    metadata: node.metadata ? JSON.stringify(node.metadata, null, 2) : undefined,
  };
}
