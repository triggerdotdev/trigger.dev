import { lazy, Suspense, useState } from "react";
import { CodeBlock } from "~/components/code/CodeBlock";
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

export function AIChatMessages({ items }: { items: DisplayItem[] }) {
  return (
    <div className="flex flex-col divide-y divide-grid-bright">
      {items.map((item, i) => {
        switch (item.type) {
          case "system":
            return <SystemSection key={i} text={item.text} />;
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

function SectionHeader({
  label,
  right,
}: {
  label: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium uppercase tracking-wide text-text-dimmed">{label}</span>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

function SystemSection({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 150;
  const preview = isLong ? text.slice(0, 150) + "..." : text;

  return (
    <div className="flex flex-col gap-1 py-2.5">
      <SectionHeader
        label="System"
        right={
          isLong ? (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-[10px] text-text-link hover:underline"
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          ) : undefined
        }
      />
      <pre className="whitespace-pre-wrap text-xs leading-relaxed text-text-dimmed">
        {expanded || !isLong ? text : preview}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

function UserSection({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1 py-2.5">
      <SectionHeader label="User" />
      <p className="text-sm text-text-bright">{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assistant response (with markdown/raw toggle)
// ---------------------------------------------------------------------------

export function AssistantResponse({
  text,
  headerLabel = "Assistant",
}: {
  text: string;
  headerLabel?: string;
}) {
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");

  return (
    <div className="flex flex-col gap-1 py-2.5">
      <SectionHeader
        label={headerLabel}
        right={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMode(mode === "rendered" ? "raw" : "rendered")}
              className="text-[10px] text-text-link hover:underline"
            >
              {mode === "rendered" ? "Raw" : "Rendered"}
            </button>
            <button
              onClick={() => navigator.clipboard.writeText(text)}
              className="text-[10px] text-text-link hover:underline"
            >
              Copy
            </button>
          </div>
        }
      />
      {mode === "rendered" ? (
        <div className="streamdown-container text-sm text-text-bright">
          <Suspense fallback={<pre className="whitespace-pre-wrap">{text}</pre>}>
            <StreamdownRenderer>{text}</StreamdownRenderer>
          </Suspense>
        </div>
      ) : (
        <CodeBlock code={text} maxLines={20} showLineNumbers={false} showCopyButton />
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
      {tools.map((tool) => (
        <ToolUseRow key={tool.toolCallId} tool={tool} />
      ))}
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
            <div className="border-t border-grid-dimmed px-2.5 py-2 flex flex-col gap-2">
              {tool.description && (
                <p className="text-xs text-text-dimmed leading-relaxed">{tool.description}</p>
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
