// Matches the `withClientData` schema on the chat.agent definition.
export interface ClientData {
  userId: string;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  currentPage: string;
  currentParams?: Record<string, string>;
}

export interface ToolContext {
  clientData: ClientData;
  // Pre-built path objects for pathBuilder functions.
  org: { slug: string };
  project: { slug: string };
  env: { slug: string };
}

export function buildToolContext(clientData: ClientData): ToolContext {
  if (!clientData?.organizationSlug || !clientData?.projectSlug || !clientData?.environmentSlug) {
    throw new Error("Invalid clientData: missing organization, project, or environment slug");
  }
  return {
    clientData,
    org: { slug: clientData.organizationSlug },
    project: { slug: clientData.projectSlug },
    env: { slug: clientData.environmentSlug },
  };
}

// V1B Summaries — LLM-friendly, token-efficient versions of presenter results

export interface SpanSummary {
  id: string;
  message: string;
  isError: boolean;
  isPartial: boolean;
  duration?: number;
  level: string;
  // Friendly ID of the run this span triggered, if the span is itself a run.
  // Lets the agent drill into the child run (getRunDetails / getSpanDetails).
  runId?: string;
}

// Extracted exception from a span event or run error.
export interface SpanException {
  type?: string;
  message?: string;
  stackTrace?: string;
}

// Full detail of a single span (subtrace), tuned for LLM error investigation.
export interface SpanDetailSummary {
  spanId: string;
  // "span" = generic trace span; "run" = the span is itself a triggered run.
  kind: "span" | "run";
  message: string;
  isError: boolean;
  isCancelled?: boolean;
  level?: string;
  duration?: string;
  // For run-kind spans:
  runFriendlyId?: string;
  taskIdentifier?: string;
  status?: string;
  // The thing the agent actually wants when asked "why did this fail":
  exceptions: SpanException[];
  metadata?: string;
  properties?: string;
  output?: string;
}

export interface TraceSummary {
  rootStatus: string;
  totalSpans: number;
  spans: SpanSummary[];
  truncated: boolean;
}

export interface RunSummary {
  id: string;
  status: string;
  isFinished: boolean;
  startedAt?: string;
  completedAt?: string;
  duration?: string;
  parentRunId?: string;
  rootRunId?: string;
}

export interface RunWithTrace {
  run: RunSummary;
  trace?: TraceSummary;
}

export interface ErrorGroupSummary {
  fingerprint: string;
  message: string;
  taskIdentifier: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  status: string;
}

export interface ErrorDetailsSummary {
  fingerprint: string;
  message: string;
  taskIdentifier: string;
  stackTrace?: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  affectedRuns: Array<{
    runFriendlyId: string;
    status: string;
    occurredAt: string;
  }>;
}