export const siteDescription =
  "Trigger.dev is an open source background jobs framework that lets you write reliable workflows in plain async code. Run long-running AI tasks, handle complex background jobs, and build AI agents with built-in queuing, automatic retries, and real-time monitoring. No timeouts, elastic scaling, and zero infrastructure management required.";

/** The llms-full slice for each top-level docs section, e.g. `api-reference.txt`. */
export const sectionFile = (section: string) =>
  `${section
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}.txt`;
