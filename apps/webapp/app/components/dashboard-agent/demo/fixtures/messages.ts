import type { UIMessage } from "@ai-sdk/react";
import type { ViewBlock } from "@internal/dashboard-agent-contracts";
import { demoId } from "../ids";

type Part = UIMessage["parts"][number];

function demoMessageId(name: string): string {
  return demoId(`msg-${name}`);
}

export function userMessage(name: string, text: string): UIMessage {
  return { id: demoMessageId(name), role: "user", parts: [{ type: "text", text }] };
}

export function assistantMessage(name: string, parts: Part[]): UIMessage {
  return { id: demoMessageId(name), role: "assistant", parts };
}

export function textPart(text: string): Part {
  return { type: "text", text, state: "done" };
}

export function streamingTextPart(text: string): Part {
  return { type: "text", text, state: "streaming" };
}

export function reasoningPart(text: string): Part {
  return { type: "reasoning", text, state: "done" };
}

export function toolPart(name: string, input: unknown, output: unknown, callName?: string): Part {
  return {
    type: `tool-${name}`,
    toolCallId: demoId(`call-${callName ?? name}`),
    state: "output-available",
    input,
    output,
  } as Part;
}

export function pendingToolPart(name: string, input: unknown, callName?: string): Part {
  return {
    type: `tool-${name}`,
    toolCallId: demoId(`call-${callName ?? name}`),
    state: "input-available",
    input,
  } as Part;
}

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

export function renderViewPart(blocks: ViewBlock[], callName?: string): Part {
  return toolPart("render_view", { blocks }, { blocks }, callName ?? "render-view");
}

export function sourceUrlPart(url: string, title: string): Part {
  return { type: "source-url", sourceId: demoId(`source-${title}`), url, title } as Part;
}
