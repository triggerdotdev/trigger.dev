import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardDocumentIcon,
  CodeBracketSquareIcon,
} from "@heroicons/react/20/solid";
import { lazy, Suspense, useState } from "react";
import { CodeBlock } from "~/components/code/CodeBlock";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import tablerSpritePath from "~/components/primitives/tabler-sprite.svg";
import type { DisplayItem, ToolUse } from "./types";

// Lazy load streamdown to avoid SSR issues
const StreamdownRenderer = lazy(() =>
  import("streamdown").then((mod) => ({
    default: ({ children }: { children: string }) => (
      <mod.ShikiThemeContext.Provider value={["one-dark-pro", "one-dark-pro"]}>
        <mod.Streamdown isAnimating={false}>{children}</mod.Streamdown>
      </mod.ShikiThemeContext.Provider>
    ),
  }))
);

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
          />
        )}
      </div>
      <ChatBubble>
        <Paragraph variant="small/dimmed" className="streamdown-container">
          <Suspense fallback={<span className="whitespace-pre-wrap">{displayText}</span>}>
            <StreamdownRenderer>{displayText}</StreamdownRenderer>
          </Suspense>
        </Paragraph>
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
        <Paragraph variant="small/dimmed" className="streamdown-container">
          <Suspense fallback={<span className="whitespace-pre-wrap">{text}</span>}>
            <StreamdownRenderer>{text}</StreamdownRenderer>
          </Suspense>
        </Paragraph>
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
          <div className="font-sans text-sm font-normal text-text-dimmed streamdown-container">
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

type ToolTab = "input" | "output" | "details";

function ToolUseRow({ tool }: { tool: ToolUse }) {
  const hasInput = tool.inputJson !== "{}";
  const hasResult = !!tool.resultOutput;
  const hasDetails = !!tool.description || !!tool.parametersJson;

  const availableTabs: ToolTab[] = [
    ...(hasInput ? (["input"] as const) : []),
    ...(hasResult ? (["output"] as const) : []),
    ...(hasDetails ? (["details"] as const) : []),
  ];

  const defaultTab: ToolTab | null = hasInput ? "input" : null;
  const [activeTab, setActiveTab] = useState<ToolTab | null>(defaultTab);

  function handleTabClick(tab: ToolTab) {
    setActiveTab(activeTab === tab ? null : tab);
  }

  return (
    <div className="rounded-sm border border-grid-bright bg-charcoal-800/40">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <code className="font-mono text-xs text-text-bright">{tool.toolName}</code>
        {tool.resultSummary && (
          <span className="ml-auto text-[10px] text-text-dimmed">{tool.resultSummary}</span>
        )}
      </div>

      {availableTabs.length > 0 && (
        <>
          <div className="flex gap-0 border-t border-grid-bright">
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
              <CodeBlock
                code={tool.resultOutput!}
                maxLines={16}
                showLineNumbers={false}
                showCopyButton
              />
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
