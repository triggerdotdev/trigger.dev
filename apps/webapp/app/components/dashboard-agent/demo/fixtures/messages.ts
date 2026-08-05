/**
 * Builders for the fixture transcripts. These produce real `UIMessage` values, the
 * same shape `DashboardAgentMessages` gets from `useChat`, so fixtures render
 * through the production renderer with no adapter. Message ids are demo-namespaced
 * so a fixture id is never mistaken for a real one in a screenshot or bug report.
 */
import type { UIMessage } from "@ai-sdk/react";
import type { ViewBlock } from "@internal/dashboard-agent-contracts";
import { demoId } from "../ids";

type Part = UIMessage["parts"][number];

export function demoMessageId(name: string): string {
  return demoId(`msg-${name}`);
}

export function userMessage(name: string, text: string): UIMessage {
  return { id: demoMessageId(name), role: "user", parts: [{ type: "text", text }] };
}

export function assistantMessage(name: string, parts: Part[]): UIMessage {
  return { id: demoMessageId(name), role: "assistant", parts };
}

/** Markdown text, rendered through Streamdown by the shared renderer. */
export function textPart(text: string): Part {
  return { type: "text", text, state: "done" };
}

/** A text part still arriving. */
export function streamingTextPart(text: string): Part {
  return { type: "text", text, state: "streaming" };
}

export function reasoningPart(text: string): Part {
  return { type: "reasoning", text, state: "done" };
}

/** A finished tool call, rendered as an expandable tool row. */
export function toolPart(name: string, input: unknown, output: unknown, callName?: string): Part {
  return {
    type: `tool-${name}`,
    toolCallId: demoId(`call-${callName ?? name}`),
    state: "output-available",
    input,
    output,
  } as Part;
}

/** A tool call still in flight. */
export function pendingToolPart(name: string, input: unknown, callName?: string): Part {
  return {
    type: `tool-${name}`,
    toolCallId: demoId(`call-${callName ?? name}`),
    state: "input-available",
    input,
  } as Part;
}

/** A tool call that failed. */
export function failedToolPart(
  name: string,
  input: unknown,
  errorText: string,
  callName?: string
): Part {
  return {
    type: `tool-${name}`,
    toolCallId: demoId(`call-${callName ?? name}`),
    state: "output-error",
    input,
    errorText,
  } as Part;
}

/**
 * A completed `render_view` call. Its `{ blocks }` output is what the panel feeds
 * to the view catalog, so this is how a fixture puts a real catalog card on screen.
 */
export function renderViewPart(blocks: ViewBlock[], callName?: string): Part {
  return toolPart("render_view", { blocks }, { blocks }, callName ?? "render-view");
}

/** A docs citation, rendered as a source link under the answer. */
export function sourceUrlPart(url: string, title: string): Part {
  return { type: "source-url", sourceId: demoId(`source-${title}`), url, title } as Part;
}
