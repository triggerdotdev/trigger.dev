import { prompts } from "@trigger.dev/sdk";
import {
  DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
  DASHBOARD_AGENT_MODEL,
  DASHBOARD_AGENT_SYSTEM_PROMPT,
} from "./tool-schemas";

/**
 * Managed prompts for the dashboard agent. Defining them here registers them
 * with the resource catalog, so the CLI syncs them to the dashboard's Prompts
 * page on deploy — where the text, model, and config become versionable and
 * overridable without a redeploy. The `model` is a `"provider:model-id"` string
 * resolved at runtime through the provider registry in `dashboard-agent.ts`.
 *
 * The system prompt's default text lives in `tool-schemas.ts` (a light module)
 * so the head-start route can use the same default without importing the SDK
 * runtime. A dashboard override only affects the agent run.
 */

export const systemPrompt = prompts.define({
  id: "dashboard-agent-system",
  description: "System prompt for the in-dashboard Trigger.dev agent.",
  model: `anthropic:${DASHBOARD_AGENT_MODEL}`,
  content: DASHBOARD_AGENT_SYSTEM_PROMPT,
});

// Code mode: used for turns where the current project has a connected GitHub
// repo, so the agent has the source-reading tools too.
export const codeSystemPrompt = prompts.define({
  id: "dashboard-agent-system-code",
  description:
    "System prompt for the in-dashboard agent when the project's GitHub repo is connected.",
  model: `anthropic:${DASHBOARD_AGENT_MODEL}`,
  content: DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
});

export const titlePrompt = prompts.define({
  id: "dashboard-agent-title",
  description: "Generates a short title for a dashboard agent conversation.",
  model: "anthropic:claude-haiku-4-5",
  content: `You write a short, descriptive title for a conversation between a user and the Trigger.dev dashboard agent.

Rules:
- 3 to 6 words.
- No surrounding quotes and no trailing punctuation.
- Capture the user's intent, not the assistant's answer.
- Plain text only.

Reply with only the title.`,
});
