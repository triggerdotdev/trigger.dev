import {
  v3RunsPath,
  v3ErrorsPath,
  v3DeploymentsPath,
  v3BatchesPath,
  v3SchedulesPath,
  v3EnvironmentVariablesPath,
  v3ApiKeysPath,
  v3QueuesPath,
  v3TestPath,
  v3LogsPath,
  v3SessionsPath,
  v3AgentsPath,
  v3ModelsPath,
  v3PromptsPath,
  v3ProjectAlertsPath,
  v3ProjectSettingsPath,
  branchesPath,
  concurrencyPath,
  regionsPath,
  queryPath,
} from "~/utils/pathBuilder";

export interface PageEntry {
  id: string;
  keywords: string[];
  description: string;
  pathFn: (org: { slug: string }, project: { slug: string }, env: { slug: string }) => string;
}

export const PAGE_REGISTRY: PageEntry[] = [
  {
    id: "runs",
    keywords: ["runs", "task runs", "executions", "jobs", "run list"],
    description: "Task runs list — view, filter, and manage all task runs",
    pathFn: (org, project, env) => v3RunsPath(org, project, env),
  },
  {
    id: "errors",
    keywords: ["errors", "error groups", "failures", "exceptions", "bugs"],
    description: "Error groups — see grouped errors across tasks with counts and trends",
    pathFn: (org, project, env) => v3ErrorsPath(org, project, env),
  },
  {
    id: "deployments",
    keywords: ["deployments", "deploys", "versions", "releases"],
    description: "Deployments — view deployment history, promote, and rollback versions",
    pathFn: (org, project, env) => v3DeploymentsPath(org, project, env),
  },
  {
    id: "batches",
    keywords: ["batches", "batch runs", "batch triggers"],
    description: "Batches — view and monitor batch trigger operations",
    pathFn: (org, project, env) => v3BatchesPath(org, project, env),
  },
  {
    id: "schedules",
    keywords: ["schedules", "cron", "scheduled tasks", "recurring"],
    description: "Schedules — create, edit, and manage scheduled task triggers",
    pathFn: (org, project, env) => v3SchedulesPath(org, project, env),
  },
  {
    id: "environment-variables",
    keywords: ["env vars", "environment variables", "secrets", "config", "configuration"],
    description: "Environment variables — configure secrets and config values per environment",
    pathFn: (org, project, env) => v3EnvironmentVariablesPath(org, project, env),
  },
  {
    id: "api-keys",
    keywords: ["api keys", "tokens", "authentication", "secret keys"],
    description: "API keys — manage server and public API keys for each environment",
    pathFn: (org, project, env) => v3ApiKeysPath(org, project, env),
  },
  {
    id: "queues",
    keywords: ["queues", "concurrency", "queue management"],
    description: "Queues — view queue status, set concurrency limits, pause queues",
    pathFn: (org, project, env) => v3QueuesPath(org, project, env),
  },
  {
    id: "test",
    keywords: ["test", "testing", "test tasks", "trigger test", "playground"],
    description: "Test — trigger test runs for your tasks with custom payloads",
    pathFn: (org, project, env) => v3TestPath(org, project, env),
  },
  {
    id: "logs",
    keywords: ["logs", "log viewer", "logging", "log lines"],
    description: "Logs — search and filter log output from task runs",
    pathFn: (org, project, env) => v3LogsPath(org, project, env),
  },
  {
    id: "sessions",
    keywords: ["sessions", "chat sessions", "agent sessions"],
    description: "Sessions — view active and past chat agent sessions",
    pathFn: (org, project, env) => v3SessionsPath(org, project, env),
  },
  {
    id: "agents",
    keywords: ["agents", "ai agents", "chat agents"],
    description: "Agents — view registered chat agents and their status",
    pathFn: (org, project, env) => v3AgentsPath(org, project, env),
  },
  {
    id: "models",
    keywords: ["models", "ai models", "llm", "model registry"],
    description: "Models — view LLM model usage, costs, and performance",
    pathFn: (org, project, env) => v3ModelsPath(org, project, env),
  },
  {
    id: "prompts",
    keywords: ["prompts", "prompt management", "prompt versions"],
    description: "Prompts — manage versioned prompts, create overrides, promote versions",
    pathFn: (org, project, env) => v3PromptsPath(org, project, env),
  },
  {
    id: "alerts",
    keywords: ["alerts", "notifications", "alert rules"],
    description: "Alerts — configure alert rules for task failures and performance",
    pathFn: (org, project, env) => v3ProjectAlertsPath(org, project, env),
  },
  {
    id: "settings",
    keywords: ["settings", "project settings", "general settings"],
    description: "Settings — general project configuration and integrations",
    pathFn: (org, project, env) => v3ProjectSettingsPath(org, project, env),
  },
  {
    id: "branches",
    keywords: ["branches", "preview branches", "git branches"],
    description: "Branches — manage preview branch environments",
    pathFn: (org, project, env) => branchesPath(org, project, env),
  },
  {
    id: "concurrency",
    keywords: ["concurrency", "concurrency limits", "parallel"],
    description: "Concurrency — view and configure task concurrency limits",
    pathFn: (org, project, env) => concurrencyPath(org, project, env),
  },
  {
    id: "regions",
    keywords: ["regions", "deployment regions", "geography"],
    description: "Regions — configure deployment regions for task execution",
    pathFn: (org, project, env) => regionsPath(org, project, env),
  },
  {
    id: "query",
    keywords: ["query", "trql", "query editor", "search runs"],
    description: "Query — write and execute TRQL queries against your task data",
    pathFn: (org, project, env) => queryPath(org, project, env),
  },
];