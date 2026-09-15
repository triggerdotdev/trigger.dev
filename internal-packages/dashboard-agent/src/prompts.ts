import {
  dashboardAgentModel,
  dashboardAgentSummaryModel,
  dashboardAgentTitleModel,
} from "./model-provider";
import { prompts } from "@trigger.dev/sdk";
import {
  DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
  DASHBOARD_AGENT_SYSTEM_PROMPT,
  DASHBOARD_AGENT_WATCH_PROMPT,
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
  model: `anthropic:${dashboardAgentModel()}`,
  content: DASHBOARD_AGENT_SYSTEM_PROMPT,
});

// Code mode: used for turns where the current project has a connected GitHub
// repo, so the agent has the source-reading tools too.
export const codeSystemPrompt = prompts.define({
  id: "dashboard-agent-system-code",
  description:
    "System prompt for the in-dashboard agent when the project's GitHub repo is connected.",
  model: `anthropic:${dashboardAgentModel()}`,
  content: DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
});

// Appended to either system prompt for a turn whose client enables watches.
export const watchSystemPrompt = prompts.define({
  id: "dashboard-agent-system-watches",
  description: "Watch guidance, appended for turns where the dashboard agent can schedule watches.",
  model: `anthropic:${dashboardAgentModel()}`,
  content: DASHBOARD_AGENT_WATCH_PROMPT,
});

export const titlePrompt = prompts.define({
  id: "dashboard-agent-title",
  description: "Generates a short title for a dashboard agent conversation.",
  model: `anthropic:${dashboardAgentTitleModel()}`,
  content: `You write a short, descriptive title for a conversation between a user and the Trigger.dev dashboard agent.

Rules:
- 3 to 6 words.
- No surrounding quotes and no trailing punctuation.
- Capture the user's intent, not the assistant's answer.
- Plain text only.

Reply with only the title.`,
});

/** The compaction summariser's instruction, told exactly what it may not drop. */
export const DASHBOARD_AGENT_SUMMARY_PROMPT = `You are compacting a support conversation between a user and an agent that reads a Trigger.dev dashboard, so the agent can keep going with a shorter history.

Write a summary in under 400 words, as notes rather than prose. Keep, in this order:
1. What the user is trying to do, in their own terms, and anything they asked to be remembered.
2. Facts already established, with the run ids, queue names, task identifiers, error fingerprints and numbers they rest on. Never restate a number you cannot see.
3. Any investigation that is open: its investigationId, its title and its current outcome.
4. Any watch the transcript records — what it was set up to watch, and what it said if it reported. Write it as what the transcript recorded, never as what is true now: a watch can expire or be cancelled without saying so here, so never present one as current.
5. What was asked most recently and what is still unanswered.

Drop tool mechanics, retries, and anything already superseded. Do not add advice, and do not invent anything that is not in the transcript. Everything you write is a record of what the transcript said, not a claim about the present.`;

export const summaryPrompt = prompts.define({
  id: "dashboard-agent-summary",
  description: "Compacts a long dashboard agent conversation into notes the agent continues from.",
  model: `anthropic:${dashboardAgentSummaryModel()}`,
  content: DASHBOARD_AGENT_SUMMARY_PROMPT,
});
