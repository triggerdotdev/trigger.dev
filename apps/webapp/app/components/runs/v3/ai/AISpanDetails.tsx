import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { useHasAdminAccess } from "~/hooks/useUser";
import { AIChatMessages, AssistantResponse } from "./AIChatMessages";
import { AIStatsSummary, AITagsRow } from "./AIModelSummary";
import { AIToolsInventory } from "./AIToolsInventory";
import type { AISpanData, DisplayItem } from "./types";

type AITab = "overview" | "messages" | "tools";

export function AISpanDetails({
  aiData,
  rawProperties,
}: {
  aiData: AISpanData;
  rawProperties?: string;
}) {
  const [tab, setTab] = useState<AITab>("overview");
  const isAdmin = useHasAdminAccess();
  const toolCount = aiData.toolCount ?? aiData.toolDefinitions?.length ?? 0;

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
          <TabButton
            isActive={tab === "tools"}
            layoutId="ai-span"
            onClick={() => setTab("tools")}
            shortcut={{ key: "t" }}
          >
            Tools{toolCount > 0 ? ` (${toolCount})` : ""}
          </TabButton>
        </TabContainer>
      </div>

      {/* Tab content */}
      <div className="scrollbar-gutter-stable min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        {tab === "overview" && <OverviewTab aiData={aiData} />}
        {tab === "messages" && <MessagesTab aiData={aiData} />}
        {tab === "tools" && <ToolsTab aiData={aiData} />}
      </div>

      {/* Footer: Copy raw (admin only) */}
      {isAdmin && rawProperties && <CopyRawFooter rawProperties={rawProperties} />}
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
    <div className="flex h-[3.25rem] shrink-0 items-center justify-end border-t border-grid-dimmed px-2">
      <Button
        variant="minimal/medium"
        onClick={handleCopy}
        LeadingIcon={copied ? CheckIcon : ClipboardDocumentIcon}
        leadingIconClassName={copied ? "text-green-500" : undefined}
      >
        Copy raw properties
      </Button>
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
