/**
 * `@internal/dashboard-agent-contracts` — the interfaces the dashboard agent, the
 * webapp, and the agent's datastore all speak.
 *
 * This package is a leaf, forever: zod is its only dependency. It must never
 * import `ai`, `@trigger.dev/sdk`, a database package, or anything from the
 * webapp, so both the task bundle and the webapp bundle can import it without
 * dragging a runtime along.
 */
export * from "./blocks.js";
export * from "./evidence.js";
export * from "./intent.js";
export * from "./page-context.js";
export * from "./run-filters.js";
export * from "./suggested-prompts.js";
export * from "./trigger-uri.js";
export * from "./watch.js";
