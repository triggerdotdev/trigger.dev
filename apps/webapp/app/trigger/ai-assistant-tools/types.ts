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