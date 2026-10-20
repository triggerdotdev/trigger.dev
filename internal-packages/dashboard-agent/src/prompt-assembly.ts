import type { AlertCreationDraft } from "@internal/dashboard-agent-contracts";
import type { ModelMessage } from "ai";
import {
  DASHBOARD_AGENT_ALERT_CREATION_EXCLUDED_TOOLS,
  DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
  DASHBOARD_AGENT_MONITORING_ALERT_TOOL_NAMES,
  DASHBOARD_AGENT_SYSTEM_PROMPT,
  DASHBOARD_AGENT_WATCH_PROMPT,
  DASHBOARD_AGENT_WATCH_TOOL_NAMES,
  dashboardAgentCodeToolSchemas,
  dashboardAgentToolSchemas,
  renderViewSchemaWithoutWatch,
} from "./tool-schemas";

/**
 * What a turn's prompt and tool set are, from its mode and the watch flag — pure, so
 * the webapp's head-start step composes the same prefix the agent run does.
 *
 * Kept free of the SDK runtime (only `tool-schemas`) for the same bundle reason
 * `prompt-prefix.ts` is.
 */

export type DashboardAgentMode = "assistant" | "code";
export type DashboardAgentScope = "default" | "alert_creation";
export type DashboardAgentPromptOptions = {
  watchEnabled?: boolean;
  scope?: DashboardAgentScope;
};

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
  const excluded = new Set<string>();
  const creating = options.scope === "alert_creation";
  if (!options.watchEnabled) {
    for (const name of DASHBOARD_AGENT_WATCH_TOOL_NAMES) excluded.add(name);
    if (!creating) {
      for (const name of DASHBOARD_AGENT_MONITORING_ALERT_TOOL_NAMES) excluded.add(name);
    }
  }
  if (creating) {
    for (const name of DASHBOARD_AGENT_ALERT_CREATION_EXCLUDED_TOOLS) excluded.add(name);
  }
  if (excluded.size === 0) return schemas;
  return Object.fromEntries(
    Object.entries(schemas)
      .filter(([name]) => !excluded.has(name))
      .map(([name, schema]) =>
        name === "render_view" && !options.watchEnabled
          ? [name, renderViewSchemaWithoutWatch]
          : [name, schema]
      )
  ) as typeof schemas;
}

/** Narrows a built tool set to the names `toolSchemasFor` registers for this turn. */
export function toolsForTurn<T extends Record<string, unknown>>(
  tools: T,
  mode: DashboardAgentMode,
  options: DashboardAgentPromptOptions = {}
): T {
  const allowed = toolSchemasFor(mode, options);
  return Object.fromEntries(Object.entries(tools).filter(([name]) => name in allowed)) as T;
}

export function alertDraftContextText(draft: AlertCreationDraft): string {
  return `Current alert draft (alert_creation scope): ${JSON.stringify(draft)}`;
}

/** Appends the creation draft to the turn's user message, after the cached prefix. */
export function withAlertDraftContext(
  messages: ModelMessage[],
  draft: AlertCreationDraft | undefined
): ModelMessage[] {
  const last = messages[messages.length - 1];
  if (!draft || last?.role !== "user") return messages;
  const note = { type: "text" as const, text: alertDraftContextText(draft) };
  const content =
    typeof last.content === "string"
      ? [{ type: "text" as const, text: last.content }, note]
      : [...last.content, note];
  return [...messages.slice(0, -1), { ...last, content }];
}
