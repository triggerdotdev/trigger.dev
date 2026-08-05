/**
 * What a tool call is called while it is still running, for the pending pill.
 *
 * Phrases are written from the reader's side ("Reading the run", not "get_run"),
 * present tense, with no trailing ellipsis since the pill adds one. A tool that
 * isn't in the map falls back to `Running <name>`.
 */

const TOOL_LABELS: Record<string, string> = {
  list_projects: "Listing projects",
  list_environments: "Listing environments",
  list_tasks: "Listing tasks",
  list_runs: "Looking through runs",
  get_run: "Reading the run",
  get_run_trace: "Reading the run's trace",
  list_errors: "Looking through errors",
  get_error: "Reading the error",
  get_query_schema: "Reading the data schema",
  run_query: "Running a query",
  ask_support: "Asking support",
  render_view: "Rendering a card",
  get_report: "Building the health report",
  get_queue: "Reading the queue",
  list_deploys: "Looking through deploys",
  get_deploy: "Reading the deploy",
  correlate_version: "Correlating versions",
  search_docs: "Searching the docs",
  get_current_page: "Reading the current page",
  navigate_to: "Opening the page",
  schedule_watch: "Filling in a watch",
  list_alerts: "Listing alerts",
  create_alert: "Creating an alert",
  delete_alert: "Deleting an alert",
  // Code mode.
  get_repo_info: "Reading the repo",
  list_files: "Listing files",
  read_file: "Reading a file",
  search_code: "Searching the code",
};

/** Takes the tool's name without the `tool-` prefix. */
export function toolPendingLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? `Running ${toolName}`;
}
