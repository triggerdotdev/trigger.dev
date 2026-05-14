import type { UIMessage } from "@ai-sdk/react";
import { memo } from "react";
import {
  AssistantResponse,
  ChatBubble,
  ToolUseRow,
} from "~/components/runs/v3/ai/AIChatMessages";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";

// ---------------------------------------------------------------------------
// AgentMessageView — renders an AI SDK UIMessage[] conversation.
//
// Extracted from the playground route so it can be reused on the run details
// page when the user picks the Agent view.
//
// UIMessage part types (AI SDK):
//   text            — markdown text content
//   reasoning       — model reasoning/thinking
//   tool-{name}     — tool call with input/output/state
//   source-url      — citation link
//   source-document — citation document reference
//   file            — file attachment (image, etc.)
//   step-start      — visual separator between steps
//   data-{name}     — custom data parts (rendered as a small popover)
// ---------------------------------------------------------------------------

export function AgentMessageView({ messages }: { messages: UIMessage[] }) {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[800px] flex-col gap-2">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </div>
  );
}

// Memoized so stable messages (anything older than the one currently
// streaming) don't re-render on every chunk. This matters a lot during
// `resumeStream()` history replay, where each re-render would otherwise
// re-run Prism highlighting on every tool-call CodeBlock in the list.
//
// Default shallow prop comparison is fine: AI SDK's useChat keeps stable
// references for messages that haven't changed, so only the last message
// (the one receiving new chunks) re-renders.
export const MessageBubble = memo(function MessageBubble({
  message,
}: {
  message: UIMessage;
}) {
  if (message.role === "user") {
    const text =
      message.parts
        ?.filter((p) => p.type === "text")
        .map((p) => (p as { type: "text"; text: string }).text)
        .join("") ?? "";

    return (
      <div className="flex min-w-0 justify-end">
        <div className="max-w-[80%] rounded-lg bg-indigo-600 px-4 py-2.5 text-sm text-white">
          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</div>
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    const hasContent = message.parts && message.parts.length > 0;
    if (!hasContent) return null;

    return (
      <div className="space-y-2">
        {message.parts?.map((part, i) => renderPart(part, i))}
      </div>
    );
  }

  return null;
});

export function renderPart(part: UIMessage["parts"][number], i: number) {
  const p = part as any;
  const type = part.type as string;

  // Text — markdown rendered via AssistantResponse
  if (type === "text") {
    return p.text ? <AssistantResponse key={i} text={p.text} headerLabel="" /> : null;
  }

  // Reasoning — amber-bordered italic block
  if (type === "reasoning") {
    return (
      <div key={i} className="border-l-2 border-amber-500/40 pl-2">
        <ChatBubble>
          <div className="whitespace-pre-wrap text-xs italic text-amber-200/70">
            {p.text ?? ""}
          </div>
        </ChatBubble>
      </div>
    );
  }

  // Tool call — type: "tool-{name}" with toolCallId, input, output, state
  if (type.startsWith("tool-")) {
    const toolName = type.slice(5);

    // Sub-agent tool: output is a UIMessage with parts
    const isSubAgent =
      p.output != null && typeof p.output === "object" && Array.isArray(p.output.parts);

    // For sub-agent tools, show the last text part as the "output" tab
    // (mirrors what toModelOutput typically sends to the parent LLM)
    // instead of dumping the full UIMessage JSON.
    let resultOutput: string | undefined;
    if (isSubAgent) {
      const lastText = (p.output.parts as any[])
        .filter((part: any) => part.type === "text" && part.text)
        .pop();
      resultOutput = lastText?.text ?? undefined;
    } else if (p.output != null) {
      resultOutput =
        typeof p.output === "string" ? p.output : JSON.stringify(p.output, null, 2);
    }

    return (
      <ToolUseRow
        key={i}
        tool={{
          toolCallId: p.toolCallId ?? `tool-${i}`,
          toolName,
          inputJson: JSON.stringify(p.input ?? {}, null, 2),
          resultOutput,
          resultSummary:
            p.state === "input-streaming" || p.state === "input-available"
              ? "calling..."
              : p.state === "output-error"
              ? `error: ${p.errorText ?? "unknown"}`
              : undefined,
          subAgent: isSubAgent
            ? {
                parts: p.output.parts,
                isStreaming: p.state === "output-available" && p.preliminary === true,
              }
            : undefined,
        }}
      />
    );
  }

  // Source URL — clickable citation link
  if (type === "source-url") {
    return (
      <div key={i} className="text-xs">
        <a
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-400 underline hover:text-indigo-300"
        >
          {p.title || p.url}
        </a>
      </div>
    );
  }

  // Source document — citation label
  if (type === "source-document") {
    return (
      <div key={i} className="text-xs text-text-dimmed">
        {p.title}
        {p.mediaType ? ` (${p.mediaType})` : ""}
      </div>
    );
  }

  // File — render as image if image type, otherwise as download link
  if (type === "file") {
    const isImage = typeof p.mediaType === "string" && p.mediaType.startsWith("image/");
    if (isImage) {
      return (
        <img
          key={i}
          src={p.url}
          alt={p.filename ?? "file"}
          className="max-h-64 rounded border border-charcoal-650"
        />
      );
    }
    return (
      <div key={i} className="text-xs">
        <a
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-400 underline hover:text-indigo-300"
        >
          {p.filename ?? "Download file"}
        </a>
      </div>
    );
  }

  // Step start — subtle dashed separator with centered label
  if (type === "step-start") {
    return (
      <div key={i} className="flex items-center gap-2 py-0.5">
        <div className="flex-1 border-t border-dashed border-charcoal-650" />
        <span className="text-[10px] text-charcoal-500">step</span>
        <div className="flex-1 border-t border-dashed border-charcoal-650" />
      </div>
    );
  }

  // Data parts — type: "data-{name}", show as labeled JSON popover
  if (type.startsWith("data-")) {
    const dataName = type.slice(5);
    return <DataPartPopover key={i} name={dataName} data={p.data} />;
  }

  return null;
}

function DataPartPopover({ name, data }: { name: string; data: unknown }) {
  const formatted = JSON.stringify(data, null, 2);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-charcoal-650 bg-charcoal-800 px-1.5 py-0.5 font-mono text-[10px] text-text-dimmed transition-colors hover:border-charcoal-500 hover:text-text-bright"
        >
          <span className="text-purple-400">{name}</span>
          <span className="text-charcoal-500">{"{}"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-md p-0" align="start" sideOffset={4}>
        <div className="flex items-center justify-between border-b border-charcoal-650 px-2.5 py-1.5">
          <span className="text-[10px] font-medium text-text-dimmed">data-{name}</span>
        </div>
        <div className="max-h-60 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <pre className="p-2.5 text-[11px] leading-relaxed text-text-bright">{formatted}</pre>
        </div>
      </PopoverContent>
    </Popover>
  );
}
