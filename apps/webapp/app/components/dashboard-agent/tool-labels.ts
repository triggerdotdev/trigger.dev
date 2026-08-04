/**
 * What a tool call is called while it is still running.
 *
 * An in-flight tool call shows a pending pill, and the pill needs one short
 * phrase saying what the agent is doing — not the tool's identifier. The phrases
 * are written from the reader's side ("Reading the run", not "get_run"), present
 * tense, no trailing ellipsis: the pill adds that.
 *
 * A tool that isn't in the map keeps the old wording, `Running <name>`, so a new
 * tool is readable before anyone gets round to naming it here.
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

/** The pending pill's label for a tool, by its name (no `tool-` prefix). */
export function toolPendingLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? `Running ${toolName}`;
}
