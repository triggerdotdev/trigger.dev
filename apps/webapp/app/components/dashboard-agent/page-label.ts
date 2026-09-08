// Display text only. The full pathname still reaches the agent in
// `clientData.currentPage`.

import type { AgentPage, AgentPageContext } from "./page-context-types";

const FALLBACK_LABEL = "Dashboard";

// `other` is the unclassified kind, so it resolves from the path instead.
const KIND_LABELS: Record<Exclude<AgentPage["kind"], "other">, string> = {
  runs: "Runs",
  run: "Run detail",
  errors: "Errors",
  error: "Error detail",
  queues: "Queues",
  queue: "Queue detail",
  deployments: "Deployments",
  deployment: "Deployment detail",
  tasks: "Tasks",
  task: "Task detail",
  schedule: "Schedule detail",
  batches: "Batches",
  batch: "Batch detail",
  test: "Test",
  alerts: "Alerts",
  apikeys: "API keys",
  envvars: "Environment variables",
  concurrency: "Concurrency",
  regions: "Regions",
  settings: "Settings",
  waitpoints: "Waitpoints",
  bulkactions: "Bulk actions",
  branches: "Branches",
  logs: "Logs",
  limits: "Limits",
  query: "Query",
  dashboards: "Dashboards",
  agents: "Agents",
  playground: "Playground",
  prompts: "Prompts",
  models: "Models",
  sessions: "Sessions",
};

// Only sections whose label isn't the prettified segment need an entry.
const SECTION_LABELS: Record<string, string> = {
  agents: "Agents",
  alerts: "Alerts",
  apikeys: "API keys",
  batches: "Batches",
  "bulk-actions": "Bulk actions",
  branches: "Branches",
  concurrency: "Concurrency",
  dashboards: "Dashboards",
  deployments: "Deployments",
  "dev-branches": "Branches",
  "environment-variables": "Environment variables",
  errors: "Errors",
  limits: "Limits",
  logs: "Logs",
  metrics: "Metrics",
  models: "Models",
  playground: "Playground",
  prompts: "Prompts",
  query: "Query",
  queues: "Queues",
  regions: "Regions",
  runs: "Runs",
  schedules: "Schedules",
  sessions: "Sessions",
  settings: "Settings",
  tasks: "Tasks",
  test: "Test",
  versions: "Versions",
  waitpoints: "Waitpoints",
};

function prettifySegment(segment: string): string {
  const words = segment.replace(/[-_]+/g, " ").trim();
  if (!words) return FALLBACK_LABEL;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// An env path is always `/orgs/{org}/projects/{project}/env/{slug}/{section}`, so both
// markers sit at fixed indexes. A branch slug is index 5 and can never be read as the marker.
const ENV_MARKER_INDEX = 4;
const ENV_SECTION_INDEX = 6;

// Env-scoped paths label off the section after `env/{slug}`; anything else falls
// back to its last segment.
export function pageLabelFromPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return FALLBACK_LABEL;

  if (
    segments[0] === "orgs" &&
    segments[2] === "projects" &&
    segments[ENV_MARKER_INDEX] === "env"
  ) {
    const section = segments[ENV_SECTION_INDEX];
    if (!section) return "Overview";
    return SECTION_LABELS[section] ?? prettifySegment(section);
  }

  const last = segments[segments.length - 1];
  return last ? (SECTION_LABELS[last] ?? prettifySegment(last)) : FALLBACK_LABEL;
}

export function agentPageLabel(
  pageContext: AgentPageContext | undefined,
  pathname: string
): string {
  const page = pageContext?.page;
  if (page && page.kind !== "other") {
    return KIND_LABELS[page.kind] ?? pageLabelFromPath(pathname);
  }
  // Prefer the path the `other` page carries: it is what the agent was told.
  return pageLabelFromPath(page?.kind === "other" && page.path ? page.path : pathname);
}

/**
 * The one entity a detail page is about, for the chat's context line.
 *
 * Secondary ids are deliberately absent: a run detail names the run, not its task, and
 * `batches.latestFailedBatchId` describes a row in a list rather than the page's subject.
 */
const ENTITY_ID_FIELD: Partial<Record<AgentPage["kind"], string>> = {
  run: "runId",
  error: "fingerprint",
  queue: "name",
  deployment: "version",
  task: "taskId",
  schedule: "scheduleId",
  batch: "batchId",
  test: "taskId",
  waitpoints: "tokenId",
  bulkactions: "bulkActionId",
  agents: "agentId",
  playground: "agentId",
  prompts: "slug",
  models: "modelId",
  sessions: "sessionId",
  dashboards: "title",
};

// The segment after the section on an env-scoped path, e.g. `…/env/dev/runs/run_abc123`.
const ENV_DETAIL_INDEX = 7;

export function entityIdFromPath(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (
    segments[0] !== "orgs" ||
    segments[2] !== "projects" ||
    segments[ENV_MARKER_INDEX] !== "env"
  ) {
    return undefined;
  }
  // No section means the env root, which is about no entity.
  if (!segments[ENV_SECTION_INDEX]) return undefined;
  return segments[ENV_DETAIL_INDEX] || undefined;
}

/**
 * `undefined` on list and overview pages, so the context line simply omits the segment.
 * A classified page answers from its own context; only `other` falls back to the path.
 */
export function agentPageEntityId(
  pageContext: AgentPageContext | undefined,
  pathname: string
): string | undefined {
  const page = pageContext?.page;
  if (page && page.kind !== "other") {
    const field = ENTITY_ID_FIELD[page.kind];
    if (!field) return undefined;
    const value = (page as Record<string, unknown>)[field];
    return typeof value === "string" && value ? value : undefined;
  }
  return entityIdFromPath(page?.kind === "other" && page.path ? page.path : pathname);
}
