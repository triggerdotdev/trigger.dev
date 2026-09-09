import {
  DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
  DASHBOARD_AGENT_SYSTEM_PROMPT,
  DASHBOARD_AGENT_WATCH_PROMPT,
  DASHBOARD_AGENT_WATCH_TOOL_NAMES,
  dashboardAgentCodeToolSchemas,
  dashboardAgentToolSchemas,
} from "./tool-schemas";

/**
 * What a turn's prompt and tool set are, from its mode and the watch flag — pure, so
 * the webapp's head-start step composes the same prefix the agent run does.
 *
 * Kept free of the SDK runtime (only `tool-schemas`) for the same bundle reason
 * `prompt-prefix.ts` is.
 */

export type DashboardAgentMode = "assistant" | "code";
export type DashboardAgentPromptOptions = { watchEnabled?: boolean };

/** The one joiner both sides use, so a resolved prompt composes like the defaults do. */
export function composeSystemPrompt(baseText: string, watchText: string): string {
  return `${baseText}\n\n${watchText}`;
}

/**
 * The default system prompt text for a turn. The agent run resolves the managed
 * versions of the same two pieces and composes them the same way.
 */
export function systemPromptFor(
  mode: DashboardAgentMode,
  options: DashboardAgentPromptOptions = {}
): string {
  const base = mode === "code" ? DASHBOARD_AGENT_CODE_SYSTEM_PROMPT : DASHBOARD_AGENT_SYSTEM_PROMPT;
  return options.watchEnabled ? composeSystemPrompt(base, DASHBOARD_AGENT_WATCH_PROMPT) : base;
}

/** The exact schemas, in the exact key order, the turn registers executes for. */
export function toolSchemasFor(
  mode: DashboardAgentMode,
  options: DashboardAgentPromptOptions = {}
) {
  const schemas = mode === "code" ? dashboardAgentCodeToolSchemas : dashboardAgentToolSchemas;
  if (options.watchEnabled) return schemas;
  return Object.fromEntries(
    Object.entries(schemas).filter(
      ([name]) => !(DASHBOARD_AGENT_WATCH_TOOL_NAMES as readonly string[]).includes(name)
    )
  ) as typeof schemas;
}
