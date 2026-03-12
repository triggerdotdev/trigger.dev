import { useState } from "react";
import { Clipboard, ClipboardCheck } from "lucide-react";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import type { AISpanData, DisplayItem } from "./types";
import { AITagsRow, AIStatsSummary } from "./AIModelSummary";
import { AIChatMessages, AssistantResponse } from "./AIChatMessages";
import { AIToolsInventory } from "./AIToolsInventory";

type AITab = "overview" | "messages" | "tools";

export function AISpanDetails({
  aiData,
  rawProperties,
}: {
  aiData: AISpanData;
  rawProperties?: string;
}) {
  const [tab, setTab] = useState<AITab>("overview");
  const hasTools =
    (aiData.toolDefinitions && aiData.toolDefinitions.length > 0) || aiData.toolCount != null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="shrink-0 px-3">
        <TabContainer>
          <TabButton
            isActive={tab === "overview"}
            layoutId="ai-span"
            onClick={() => setTab("overview")}
            shortcut={{ key: "o" }}
          >
            Overview
          </TabButton>
          <TabButton
            isActive={tab === "messages"}
            layoutId="ai-span"
            onClick={() => setTab("messages")}
            shortcut={{ key: "m" }}
          >
            Messages
          </TabButton>
          {hasTools && (
            <TabButton
              isActive={tab === "tools"}
              layoutId="ai-span"
              onClick={() => setTab("tools")}
              shortcut={{ key: "t" }}
            >
              Tools{aiData.toolCount != null ? ` (${aiData.toolCount})` : ""}
            </TabButton>
          )}
        </TabContainer>
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-stable scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        {tab === "overview" && <OverviewTab aiData={aiData} />}
        {tab === "messages" && <MessagesTab aiData={aiData} />}
        {tab === "tools" && <ToolsTab aiData={aiData} />}
      </div>

      {/* Footer: Copy raw */}
      {rawProperties && <CopyRawFooter rawProperties={rawProperties} />}
    </div>
  );
}

function OverviewTab({ aiData }: { aiData: AISpanData }) {
  const { userText, outputText, outputToolNames } = extractInputOutput(aiData);

  return (
    <div className="flex flex-col divide-y divide-grid-bright px-3">
      {/* Tags + Stats */}
      <AITagsRow aiData={aiData} />
      <AIStatsSummary aiData={aiData} />

      {/* Input (last user prompt) */}
      {userText && (
        <div className="flex flex-col gap-1 py-2.5">
          <span className="text-xs font-medium uppercase tracking-wide text-text-dimmed">
            Input
          </span>
          <p className="text-sm text-text-bright">{userText}</p>
        </div>
      )}

      {/* Output (assistant response or tool calls) */}
      {outputText && <AssistantResponse text={outputText} headerLabel="Output" />}
      {outputToolNames.length > 0 && !outputText && (
        <div className="flex flex-col gap-1 py-2.5">
          <span className="text-xs font-medium uppercase tracking-wide text-text-dimmed">
            Output
          </span>
          <p className="text-sm text-text-dimmed">
            Called {outputToolNames.length === 1 ? "tool" : "tools"}:{" "}
            <span className="font-mono text-text-bright">{outputToolNames.join(", ")}</span>
          </p>
        </div>
      )}
    </div>
  );
}

function MessagesTab({ aiData }: { aiData: AISpanData }) {
  return (
    <div className="px-3">
      <div className="flex flex-col divide-y divide-grid-bright">
        {aiData.items && aiData.items.length > 0 && <AIChatMessages items={aiData.items} />}
        {aiData.responseText && !hasAssistantItem(aiData.items) && (
          <AssistantResponse text={aiData.responseText} />
        )}
      </div>
    </div>
  );
}

function ToolsTab({ aiData }: { aiData: AISpanData }) {
  return <AIToolsInventory aiData={aiData} />;
}

function CopyRawFooter({ rawProperties }: { rawProperties: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(rawProperties);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex shrink-0 items-center justify-end border-t border-grid-dimmed px-3 py-2">
      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 text-xs text-text-dimmed transition-colors hover:text-text-bright"
      >
        {copied ? (
          <>
            <ClipboardCheck className="size-3.5" />
            Copied
          </>
        ) : (
          <>
            <Clipboard className="size-3.5" />
            Copy raw properties
          </>
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractInputOutput(aiData: AISpanData): {
  userText: string | undefined;
  outputText: string | undefined;
  outputToolNames: string[];
} {
  let userText: string | undefined;
  let outputText: string | undefined;
  const outputToolNames: string[] = [];

  if (aiData.items) {
    // Find the last user message
    for (let i = aiData.items.length - 1; i >= 0; i--) {
      if (aiData.items[i].type === "user") {
        userText = (aiData.items[i] as { type: "user"; text: string }).text;
        break;
      }
    }

    // Find the last assistant or tool-use item as the output
    for (let i = aiData.items.length - 1; i >= 0; i--) {
      const item = aiData.items[i];
      if (item.type === "assistant") {
        outputText = item.text;
        break;
      }
      if (item.type === "tool-use") {
        for (const tool of item.tools) {
          outputToolNames.push(tool.toolName);
        }
        break;
      }
    }
  }

  // Fall back to responseText if no assistant item found
  if (!outputText && aiData.responseText) {
    outputText = aiData.responseText;
  }

  return { userText, outputText, outputToolNames };
}

function hasAssistantItem(items: DisplayItem[] | undefined): boolean {
  if (!items) return false;
  return items.some((item) => item.type === "assistant");
}
