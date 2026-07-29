/**
 * Where a navigate goes, as a dashboard path.
 *
 * A `trigger://` target is resolved server-side (`resolveTriggerUri.server.ts`,
 * reached through the panel's `resolve` action) — this module handles the two
 * client-side halves: the runs-list filters a navigate intent carries, and links
 * that arrived as absolute URLs into our own origin.
 */
import {
  agentIntentSchema,
  type AgentIntent,
  type RunFilters,
} from "@internal/dashboard-agent-contracts";

// The filter keys are already the runs page's own URL params (see
// `TaskRunListSearchFilters`), with one exception: the page reads absolute
// window bounds as epoch milliseconds while an intent carries ISO strings.
const EPOCH_MS_KEYS = new Set(["from", "to"]);

/** A resolved path with the intent's filters applied as search params. */
export function appendRunFilters(path: string, filters?: RunFilters): string {
  if (!filters) return path;
  // A base is needed to parse a relative path; only pathname + search is used.
  const url = new URL(path, "https://dashboard.invalid");

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    if (EPOCH_MS_KEYS.has(key)) {
      const epochMs = Date.parse(String(value));
      if (!Number.isNaN(epochMs)) url.searchParams.set(key, String(epochMs));
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) if (entry) url.searchParams.append(key, entry);
      continue;
    }
    if (typeof value === "boolean") {
      if (value) url.searchParams.set(key, "true");
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return `${url.pathname}${url.search}`;
}

/**
 * The path to navigate to for a link into our own origin, or null when the link
 * leaves the dashboard (those keep their new tab).
 *
 * The agent cites dashboard resources as absolute URLs, and an absolute URL is
 * rendered as an external link — a new tab for a page that belongs in this one.
 */
export function sameOriginPath(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

type ToolPart = { type?: string; state?: string; toolCallId?: string; output?: unknown };
type ToolMessage = { id: string; parts?: ReadonlyArray<unknown> };

/**
 * The navigate intents from completed `navigate_to` tool calls the host hasn't
 * honoured yet.
 *
 * The tool returns an intent rather than performing the navigation, so the panel
 * is what actually moves the user — otherwise the agent says "you're now on the
 * page" and nothing happened. `seen` is mutated with the calls handled, and is
 * seeded with the transcript loaded at mount so opening an old chat never
 * navigates on history.
 */
export function pendingNavigateIntents(
  messages: ReadonlyArray<ToolMessage>,
  seen: Set<string>
): AgentIntent[] {
  const intents: AgentIntent[] = [];

  for (const message of messages) {
    const parts = message.parts ?? [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as ToolPart;
      if (part?.type !== "tool-navigate_to" || part.state !== "output-available") continue;

      const key = part.toolCallId ?? `${message.id}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const output = part.output as { intent?: unknown } | undefined;
      const parsed = agentIntentSchema.safeParse(output?.intent);
      if (parsed.success && parsed.data.kind === "navigate") intents.push(parsed.data);
    }
  }

  return intents;
}
