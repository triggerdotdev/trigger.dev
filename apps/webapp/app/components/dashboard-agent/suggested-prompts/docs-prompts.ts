/** The evergreen explain and docs chips, shared across pages. */
import type { SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { def } from "./prompt-chips";

export const EXPLAIN_PAGE = def(
  "explain-page",
  "Explain this page",
  "Explain what this page shows and what I can do here."
);
export const DOCS_GENERIC = def(
  "docs-generic",
  "How do I use Trigger.dev?",
  "How do I get started with Trigger.dev? Point me at the docs."
);
export const DOCS_RETRIES = def(
  "docs-retries",
  "How do retries work?",
  "How do retries work in Trigger.dev?"
);
export const DOCS_ERRORS = def(
  "docs-errors",
  "How do I handle errors?",
  "How do I catch and handle errors in Trigger.dev tasks?"
);
export const DOCS_CONCURRENCY = def(
  "docs-concurrency",
  "How does concurrency work?",
  "How do queues and concurrency limits work in Trigger.dev?"
);
export const DOCS_DEPLOYS = def(
  "docs-deploys",
  "How do deploys work?",
  "How do deployments and versions work in Trigger.dev?"
);
export const DOCS_TASKS = def(
  "docs-tasks",
  "How do I write a task?",
  "How do I write and structure a task in Trigger.dev?"
);
export const DOCS_SCHEDULES = def(
  "docs-schedules",
  "How do schedules work?",
  "How do cron schedules work in Trigger.dev?"
);
export const DOCS_BATCHES = def(
  "docs-batches",
  "How do I trigger a batch?",
  "How do I trigger a batch of runs, and how do I read the results?"
);
export const DOCS_TRIGGERING = def(
  "docs-triggering",
  "How do I trigger a task?",
  "How do I trigger a task, and what options can I pass with the payload?"
);
export const DOCS_ALERTS = def(
  "docs-alerts",
  "How do I set up alerts?",
  "How do alerts work, and which failures can I be notified about?"
);
export const DOCS_AUTH = def(
  "docs-auth",
  "How do I authenticate?",
  "How do I authenticate the SDK with an API key?"
);
export const DOCS_ENVVARS = def(
  "docs-envvars",
  "How do I set env vars?",
  "How do environment variables work, and how do I read one inside a task?"
);
export const DOCS_REGIONS = def(
  "docs-regions",
  "How do I pick a region?",
  "How do I choose which region a task runs in?"
);
export const DOCS_ENVIRONMENTS = def(
  "docs-environments",
  "How do environments work?",
  "How do projects and environments work in Trigger.dev?"
);
export const DOCS_WAITPOINTS = def(
  "docs-waitpoints",
  "How do wait tokens work?",
  "How do wait tokens work, and how do I complete one?"
);
export const DOCS_BULK_ACTIONS = def(
  "docs-bulk-actions",
  "How do I replay runs in bulk?",
  "How do I cancel or replay a lot of runs at once?"
);
export const DOCS_BRANCHES = def(
  "docs-branches",
  "How do preview branches work?",
  "How do preview branches work in Trigger.dev?"
);
export const DOCS_LOGS = def(
  "docs-logs",
  "How do I log from a task?",
  "How do I write logs from a task, and how long are they kept?"
);
export const DOCS_LIMITS = def(
  "docs-limits",
  "What are the limits?",
  "What limits apply to my environment, and which ones can I raise?"
);
export const DOCS_QUERY = def(
  "docs-query",
  "How do I write a query?",
  "How do I write a query over my runs and metrics?"
);
export const DOCS_DASHBOARDS = def(
  "docs-dashboards",
  "How do dashboards work?",
  "How do I build a metrics dashboard out of my own queries?"
);
export const DOCS_AGENTS = def(
  "docs-agents",
  "How do I build an agent?",
  "How do I build an agent with Trigger.dev?"
);
export const DOCS_PROMPTS = def(
  "docs-prompts",
  "How do managed prompts work?",
  "How do managed prompts and prompt versions work?"
);
export const DOCS_MODELS = def(
  "docs-models",
  "How do I configure a model?",
  "How do I choose and configure an LLM model in a task?"
);
export const DOCS_SESSIONS = def(
  "docs-sessions",
  "How do sessions work?",
  "How do agent sessions work, and when do they expire?"
);

export const GENERIC_PROMPTS: SuggestedPrompt[] = [EXPLAIN_PAGE, DOCS_GENERIC];
