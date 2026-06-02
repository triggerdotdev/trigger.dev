// Page → suggested prompts. Imported by frontend components, so keep it free
// of server-side dependencies.

const DEFAULT_PROMPTS = [
  "How do retries work?",
  "Where do I configure concurrency?",
  "How do I deploy my task?",
];

export const SUGGESTED_PROMPTS: Record<string, string[]> = {
  runs: [
    "How do I filter runs?",
    "How do I replay a failed run?",
    "What do the run statuses mean?",
  ],
  errors: [
    "How do I debug task errors?",
    "How do I set up error alerts?",
    "What causes SYSTEM_FAILURE?",
  ],
  deployments: [
    "How do I set up CI/CD deployments?",
    "How do preview branches work?",
    "How do I rollback a deployment?",
  ],
  schedules: [
    "How do I create a cron schedule?",
    "How does timezone handling work?",
    "Can I pause a schedule?",
  ],
  "environment-variables": [
    "How do environment variables work?",
    "How do I sync env vars from Vercel?",
    "Can I use different values per environment?",
  ],
  query: [
    "How does TRQL work?",
    "Show me example queries",
    "How do I query run metrics?",
  ],
};

export function getPrompts(pageId: string): string[] {
  return SUGGESTED_PROMPTS[pageId] ?? DEFAULT_PROMPTS;
}