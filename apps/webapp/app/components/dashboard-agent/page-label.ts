// One human label for "where the user is", used by the context banner.
//
// Two sources: a route that describes itself yields a `page.kind` we can label
// exactly, everything else falls back to the URL. This module only produces
// display text; the full pathname still goes to the agent untouched in
// `clientData.currentPage`.

import type { AgentPage, AgentPageContext } from "./page-context-types";

/** Shown when we can't work out anything better. */
const FALLBACK_LABEL = "Dashboard";

// `other` is the "we didn't classify this route" kind, so it carries no label
// of its own and resolves from the path instead.
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

// The dashboard's env-level sections, keyed by their path segment. Only the ones
// whose label isn't the prettified segment strictly need an entry.
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

/**
 * Label a dashboard path. Env-scoped paths (`/orgs/x/projects/y/env/dev/runs`)
 * label off the section that follows `env/{slug}`; the env root is "Overview".
 * Anything else (org settings, account pages) falls back to its last segment.
 */
export function pageLabelFromPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return FALLBACK_LABEL;

  const envIndex = segments.lastIndexOf("env");
  if (envIndex !== -1) {
    // `env` is followed by the env slug, then the section (if any).
    const section = segments[envIndex + 2];
    if (!section) return "Overview";
    return SECTION_LABELS[section] ?? prettifySegment(section);
  }

  const last = segments[segments.length - 1];
  return last ? (SECTION_LABELS[last] ?? prettifySegment(last)) : FALLBACK_LABEL;
}

/** The banner's label: the structured page kind when there is one, else the path. */
export function agentPageLabel(
  pageContext: AgentPageContext | undefined,
  pathname: string
): string {
  const page = pageContext?.page;
  if (page && page.kind !== "other") {
    return KIND_LABELS[page.kind] ?? pageLabelFromPath(pathname);
  }
  // An `other` page carries the raw path it couldn't classify. Prefer it over the
  // location, since it's what the agent was told.
  return pageLabelFromPath(page?.kind === "other" && page.path ? page.path : pathname);
}
