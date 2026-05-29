import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardDocumentIcon,
  CodeBracketSquareIcon,
} from "@heroicons/react/20/solid";
import { Suspense, useEffect, useState } from "react";
import { CodeBlock } from "~/components/code/CodeBlock";
import { StreamdownRenderer } from "~/components/code/StreamdownRenderer";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import tablerSpritePath from "~/components/primitives/tabler-sprite.svg";
import type { DisplayItem, ToolUse } from "./types";

export type PromptLink = {
  slug: string;
  version?: string;
  path: string;
};

export function AIChatMessages({
  items,
  promptLink,
}: {
  items: DisplayItem[];
  promptLink?: PromptLink;
}) {
  return (
    <div className="flex flex-col gap-1">
      {items.map((item, i) => {
        switch (item.type) {
          case "system":
            return <SystemSection key={i} text={item.text} promptLink={promptLink} />;
          case "user":
            return <UserSection key={i} text={item.text} />;
          case "tool-use":
            return <ToolUseSection key={i} tools={item.tools} />;
          case "assistant":
            return <AssistantResponse key={i} text={item.text} />;
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section header (shared across all sections)
// ---------------------------------------------------------------------------

function SectionHeader({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <Header3>{label}</Header3>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function ChatBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-grid-bright bg-charcoal-750/50 px-3.5 py-2">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

function SystemSection({
  text,
  promptLink,
}: {
  text: string;
  promptLink?: PromptLink;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 150;
  const preview = isLong ? text.slice(0, 150) + "..." : text;
  const displayText = expanded || !isLong ? text : preview;

  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Header3>System</Header3>
          {promptLink && (
            <LinkButton to={promptLink.path} variant="minimal/small">
              <span className="flex items-center gap-1">
                <svg className="size-3.5 shrink-0 text-text-dimmed">
                  <use xlinkHref={`${tablerSpritePath}#tabler-file-text-ai`} />
                </svg>
                {promptLink.slug}
                {promptLink.version ? ` v${promptLink.version}` : ""}
              </span>
            </LinkButton>
          )}
        </div>
        {isLong && (
          <Button
            variant="minimal/small"
            onClick={() => setExpanded(!expanded)}
            LeadingIcon={expanded ? ChevronUpIcon : ChevronDownIcon}
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
          />
        )}
      </div>
      <ChatBubble>
        <div className="font-sans text-sm font-normal text-text-dimmed streamdown-container">
          <Suspense fallback={<span className="whitespace-pre-wrap">{displayText}</span>}>
            <StreamdownRenderer>{displayText}</StreamdownRenderer>
          </Suspense>
        </div>
      </ChatBubble>
    </div>
  );
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

function UserSection({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <SectionHeader label="User" />
      <ChatBubble>
        <div className="font-sans text-sm font-normal text-text-dimmed streamdown-container">
          <Suspense fallback={<span className="whitespace-pre-wrap">{text}</span>}>
            <StreamdownRenderer>{text}</StreamdownRenderer>
          </Suspense>
        </div>
      </ChatBubble>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assistant response (with markdown/raw toggle)
// ---------------------------------------------------------------------------

function isJsonString(value: string): boolean {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function AssistantResponse({
  text,
  headerLabel = "Assistant",
}: {
  text: string;
  headerLabel?: string;
}) {
  const isJson = isJsonString(text);
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (isJson) {
    return (
      <div className="flex flex-col gap-1.5 py-2.5">
        <SectionHeader label={headerLabel} />
        <CodeBlock
          code={text}
          maxLines={20}
          showLineNumbers={false}
          showCopyButton
          language="json"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <SectionHeader
        label={headerLabel}
        right={
          <div className="flex items-center">
            <Button
              variant="minimal/small"
              onClick={() => setMode(mode === "rendered" ? "raw" : "rendered")}
              LeadingIcon={CodeBracketSquareIcon}
            >
              {mode === "rendered" ? "Raw" : "Rendered"}
            </Button>
            <Button
              variant="minimal/small"
              onClick={handleCopy}
              LeadingIcon={copied ? CheckIcon : ClipboardDocumentIcon}
              leadingIconClassName={copied ? "text-green-500" : undefined}
            >
              Copy
            </Button>
          </div>
        }
      />
      {mode === "rendered" ? (
        <ChatBubble>
          <div className="streamdown-container min-w-0 font-sans text-sm font-normal text-text-dimmed [overflow-wrap:anywhere]">
            <Suspense fallback={<span className="whitespace-pre-wrap">{text}</span>}>
              <StreamdownRenderer>{text}</StreamdownRenderer>
            </Suspense>
          </div>
        </ChatBubble>
      ) : (
        <CodeBlock
          code={text}
          maxLines={20}
          showLineNumbers={false}
          showCopyButton={false}
          className="pl-2"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool use (merged calls + results)
// ---------------------------------------------------------------------------

function ToolUseSection({ tools }: { tools: ToolUse[] }) {
  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <SectionHeader label={tools.length === 1 ? "Tool call" : `Tool calls (${tools.length})`} />
      <div className="flex flex-col gap-2">
        {tools.map((tool) => (
          <ToolUseRow key={tool.toolCallId} tool={tool} />
        ))}
      </div>
    </div>
  );
}

type ToolTab = "input" | "output" | "details" | "agent";

export function ToolUseRow({ tool }: { tool: ToolUse }) {
  const hasInput = tool.inputJson !== "{}";
  const hasResult = !!tool.resultOutput;
  const hasDetails = !!tool.description || !!tool.parametersJson;
  const hasSubAgent = !!tool.subAgent;

  const availableTabs: ToolTab[] = [
    ...(hasSubAgent ? (["agent"] as const) : []),
    ...(hasInput ? (["input"] as const) : []),
    ...(hasResult ? (["output"] as const) : []),
    ...(hasDetails ? (["details"] as const) : []),
  ];

  const [activeTab, setActiveTab] = useState<ToolTab | null>(
    hasSubAgent ? "agent" : hasInput ? "input" : null
  );

  // Auto-select input tab when input arrives after initial render (e.g. streaming tool calls)
  useEffect(() => {
    if (!hasSubAgent && hasInput && activeTab === null) {
      setActiveTab("input");
    }
  }, [hasInput, hasSubAgent]);

  function handleTabClick(tab: ToolTab) {
    setActiveTab(activeTab === tab ? null : tab);
  }

  return (
    <div
      className={`rounded-sm border bg-charcoal-800/40 ${
        hasSubAgent ? "border-indigo-500/30" : "border-grid-bright"
      }`}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        {hasSubAgent && (
          <svg className="size-3.5 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z" />
          </svg>
        )}
        <code
          className={`font-mono text-xs ${hasSubAgent ? "text-indigo-300" : "text-text-bright"}`}
        >
          {tool.toolName}
        </code>
        {hasSubAgent && tool.subAgent?.isStreaming && (
          <span className="flex items-center gap-1 text-[10px] text-indigo-400">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-indigo-400" />
            streaming
          </span>
        )}
        {tool.resultSummary && (
          <span className="ml-auto text-[10px] text-text-dimmed">{tool.resultSummary}</span>
        )}
      </div>

      {availableTabs.length > 0 && (
        <>
          <div
            className={`flex gap-0 border-t ${
              hasSubAgent ? "border-indigo-500/20" : "border-grid-bright"
            }`}
          >
            {availableTabs.map((tab) => (
              <button
                key={tab}
                onClick={() => handleTabClick(tab)}
                className={`px-2.5 py-1 text-[11px] capitalize transition-colors ${
                  activeTab === tab
                    ? "bg-charcoal-750 text-text-bright"
                    : "text-text-dimmed hover:text-text-bright"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          {activeTab === "agent" && hasSubAgent && (
            <SubAgentContent parts={tool.subAgent!.parts} />
          )}

          {activeTab === "input" && hasInput && (
            <div className="border-t border-grid-dimmed">
              <CodeBlock
                code={tool.inputJson}
                maxLines={12}
                showLineNumbers={false}
                showCopyButton
              />
            </div>
          )}

          {activeTab === "output" && hasResult && (
            <div className="border-t border-grid-dimmed">
              {isJsonString(tool.resultOutput!) ? (
                <CodeBlock
                  code={tool.resultOutput!}
                  maxLines={16}
                  showLineNumbers={false}
                  showCopyButton
                />
              ) : (
                <div className="p-2.5 font-sans text-sm font-normal text-text-dimmed streamdown-container">
                  <Suspense
                    fallback={
                      <span className="whitespace-pre-wrap">{tool.resultOutput}</span>
                    }
                  >
                    <StreamdownRenderer>{tool.resultOutput!}</StreamdownRenderer>
                  </Suspense>
                </div>
              )}
            </div>
          )}

          {activeTab === "details" && hasDetails && (
            <div className="flex flex-col gap-2 border-t border-grid-dimmed px-2.5 py-2">
              {tool.description && (
                <p className="text-xs leading-relaxed text-text-dimmed">{tool.description}</p>
              )}
              {tool.parametersJson && (
                <div>
                  <span className="text-[10px] font-medium uppercase tracking-wide text-text-dimmed">
                    Parameters schema
                  </span>
                  <CodeBlock
                    code={tool.parametersJson}
                    maxLines={16}
                    showLineNumbers={false}
                    showCopyButton
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SubAgentContent({ parts }: { parts: any[] }) {
  // Extract sub-agent run ID from injected metadata part
  const runPart = parts.find(
    (p: any) => p.type === "data-subagent-run" && p.data?.runId
  );
  const subAgentRunId = runPart?.data?.runId as string | undefined;

  return (
    <div className="space-y-2 border-t border-indigo-500/20 p-2.5">
      {subAgentRunId && (
        <div className="flex justify-end">
          <LinkButton
            to={`/runs/${subAgentRunId}`}
            variant="tertiary/small"
            target="_blank"
          >
            View sub-agent run
          </LinkButton>
        </div>
      )}
      {parts.map((part: any, j: number) => {
        const partType = part.type as string;

        // Skip the injected metadata part — already rendered above
        if (partType === "data-subagent-run") return null;

        if (partType === "text" && part.text) {
          return <AssistantResponse key={j} text={part.text} headerLabel="" />;
        }

        if (partType === "step-start") {
          return (
            <div key={j} className="flex items-center gap-2 py-0.5">
              <div className="flex-1 border-t border-dashed border-charcoal-650" />
              <span className="text-[10px] text-charcoal-500">step</span>
              <div className="flex-1 border-t border-dashed border-charcoal-650" />
            </div>
          );
        }

        if (partType.startsWith("tool-")) {
          const subToolName = partType.slice(5);
          return (
            <ToolUseRow
              key={j}
              tool={{
                toolCallId: part.toolCallId ?? `sub-tool-${j}`,
                toolName: subToolName,
                inputJson: JSON.stringify(part.input ?? {}, null, 2),
                resultOutput:
                  part.output != null
                    ? typeof part.output === "string"
                      ? part.output
                      : JSON.stringify(part.output, null, 2)
                    : undefined,
                resultSummary:
                  part.state === "input-streaming" || part.state === "input-available"
                    ? "calling..."
                    : part.state === "output-error"
                    ? `error: ${part.errorText ?? "unknown"}`
                    : undefined,
              }}
            />
          );
        }

        if (partType === "reasoning" && part.text) {
          return (
            <div key={j} className="border-l-2 border-amber-500/40 pl-2">
              <div className="whitespace-pre-wrap text-xs italic text-amber-200/70">
                {part.text}
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
