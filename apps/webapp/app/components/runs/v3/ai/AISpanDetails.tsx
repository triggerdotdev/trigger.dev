import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/20/solid";
import { lazy, Suspense, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TextLink } from "~/components/primitives/TextLink";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useHasAdminAccess } from "~/hooks/useUser";
import { v3PromptPath } from "~/utils/pathBuilder";
import { CodeBlock } from "~/components/code/CodeBlock";
import { AIChatMessages, AssistantResponse, ChatBubble } from "./AIChatMessages";
import type { PromptLink } from "./AIChatMessages";
import { AIStatsSummary, AITagsRow } from "./AIModelSummary";
import { AIToolsInventory } from "./AIToolsInventory";
import type { AISpanData, DisplayItem } from "./types";
import type { PromptSpanData } from "~/presenters/v3/SpanPresenter.server";

const StreamdownRenderer = lazy(() =>
  import("streamdown").then((mod) => ({
    default: ({ children }: { children: string }) => (
      <mod.ShikiThemeContext.Provider value={["one-dark-pro", "one-dark-pro"]}>
        <mod.Streamdown isAnimating={false}>{children}</mod.Streamdown>
      </mod.ShikiThemeContext.Provider>
    ),
  }))
);

type AITab = "overview" | "messages" | "tools" | "prompt";

export function AISpanDetails({
  aiData,
  promptVersionData,
  rawProperties,
}: {
  aiData: AISpanData;
  promptVersionData?: PromptSpanData;
  rawProperties?: string;
}) {
  const [tab, setTab] = useState<AITab>("overview");
  const isAdmin = useHasAdminAccess();
  const toolCount = aiData.toolCount ?? aiData.toolDefinitions?.length ?? 0;

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const promptLink: PromptLink | undefined =
    aiData.promptSlug && organization && project && environment
      ? {
          slug: aiData.promptSlug,
          version: aiData.promptVersion,
          path: v3PromptPath(organization, project, environment, aiData.promptSlug, aiData.promptVersion),
        }
      : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="shrink-0 overflow-x-auto px-3 py-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
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
            <span className="inline-flex items-center whitespace-nowrap">
              Tools
              {toolCount > 0 && (
                <span className="ml-1 inline-flex min-w-4 -translate-y-px items-center justify-center rounded-full border border-charcoal-600 bg-charcoal-650 px-1 py-0.5 text-[0.625rem] font-medium leading-none text-text-bright">
                  {toolCount}
                </span>
              )}
            </span>
          </TabButton>
          {promptVersionData && (
            <TabButton
              isActive={tab === "prompt"}
              layoutId="ai-span"
              onClick={() => setTab("prompt")}
              shortcut={{ key: "p" }}
            >
              Prompt
            </TabButton>
          )}
        </TabContainer>
      </div>

      {/* Tab content */}
      <div className="scrollbar-gutter-stable min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        {tab === "overview" && <OverviewTab aiData={aiData} />}
        {tab === "messages" && <MessagesTab aiData={aiData} promptLink={promptLink} />}
        {tab === "tools" && <ToolsTab aiData={aiData} />}
        {tab === "prompt" && promptVersionData && (
          <PromptTab promptData={promptVersionData} promptLink={promptLink} />
        )}
      </div>

      {/* Footer: Copy raw (admin only) */}
      {isAdmin && rawProperties && <CopyRawFooter rawProperties={rawProperties} />}
    </div>
  );
}

function OverviewTab({ aiData }: { aiData: AISpanData }) {
  const { userText, outputText, outputObject, outputToolNames } = extractInputOutput(aiData);

  return (
    <div className="flex flex-col px-3">
      <AITagsRow aiData={aiData} />
      <AIStatsSummary aiData={aiData} />

      {userText && (
        <div className="flex flex-col gap-1.5 py-2.5">
          <Header3>Input</Header3>
          <ChatBubble>
            <Paragraph variant="small/dimmed">{userText}</Paragraph>
          </ChatBubble>
        </div>
      )}

      {outputText && <AssistantResponse text={outputText} headerLabel="Output" />}
      {!outputText && outputObject && (
        <div className="flex flex-col gap-1.5 py-2.5">
          <Header3>Output</Header3>
          <CodeBlock
            code={outputObject}
            maxLines={20}
            showLineNumbers={false}
            showCopyButton
            language="json"
          />
        </div>
      )}
      {outputToolNames.length > 0 && !outputText && !outputObject && (
        <div className="flex flex-col gap-1.5 py-2.5">
          <Header3>Output</Header3>
          <ChatBubble>
            <Paragraph variant="small/dimmed">
              Called {outputToolNames.length === 1 ? "tool" : "tools"}:{" "}
              <span className="font-mono text-text-bright">{outputToolNames.join(", ")}</span>
            </Paragraph>
          </ChatBubble>
        </div>
      )}
    </div>
  );
}

function MessagesTab({
  aiData,
  promptLink,
}: {
  aiData: AISpanData;
  promptLink?: PromptLink;
}) {
  const showFallbackText = aiData.responseText && !hasAssistantItem(aiData.items);
  const showFallbackObject =
    !showFallbackText && aiData.responseObject && !hasAssistantItem(aiData.items);

  return (
    <div className="px-3">
      <div className="flex flex-col">
        {aiData.items && aiData.items.length > 0 && (
          <AIChatMessages items={aiData.items} promptLink={promptLink} />
        )}
        {showFallbackText && <AssistantResponse text={aiData.responseText!} />}
        {showFallbackObject && (
          <div className="flex flex-col gap-1.5 py-2.5">
            <Header3>Assistant</Header3>
            <CodeBlock
              code={aiData.responseObject!}
              maxLines={20}
              showLineNumbers={false}
              showCopyButton
              language="json"
            />
          </div>
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

function PromptTab({
  promptData,
  promptLink,
}: {
  promptData: PromptSpanData;
  promptLink?: PromptLink;
}) {
  const labels = promptData.labels
    ? promptData.labels.split(",").map((l) => l.trim()).filter(Boolean)
    : [];

  return (
    <div className="flex flex-col px-3">
      {/* Prompt properties */}
      <div className="flex flex-col gap-1 py-2.5">
        <div className="flex flex-col text-xs @container">
          <PromptMetricRow
            label="Prompt"
            value={
              promptLink ? (
                <TextLink to={promptLink.path}>{promptData.slug}</TextLink>
              ) : (
                promptData.slug
              )
            }
          />
          <PromptMetricRow label="Version" value={`v${promptData.version}`} />
          {labels.length > 0 && <PromptMetricRow label="Labels" value={labels.join(", ")} />}
          {promptData.model && <PromptMetricRow label="Model" value={promptData.model} />}
        </div>
      </div>

      {/* Prompt input (variables passed to resolve()) */}
      {promptData.input && (
        <div className="flex flex-col gap-1.5 py-2.5">
          <Header3>Input</Header3>
          <CodeBlock
            code={tryPrettyJson(promptData.input)}
            maxLines={20}
            showLineNumbers={false}
            showCopyButton
            language="json"
          />
        </div>
      )}

      {/* Template (from the prompt version) */}
      {promptData.template && (
        <div className="flex flex-col gap-1.5 py-2.5">
          <Header3>Template</Header3>
          <div className="rounded-md border border-grid-bright bg-charcoal-750/50 px-3.5 py-2">
            <div className="font-sans text-sm font-normal text-text-dimmed streamdown-container">
              <Suspense
                fallback={<span className="whitespace-pre-wrap">{promptData.template}</span>}
              >
                <StreamdownRenderer>{promptData.template}</StreamdownRenderer>
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PromptMetricRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid h-7 grid-cols-[1fr_auto] items-center gap-4 rounded-sm px-1.5 transition odd:bg-charcoal-750/40 @[28rem]:grid-cols-[8rem_1fr] hover:bg-white/[0.04]">
      <span className="text-text-dimmed">{label}</span>
      <span className="text-right text-text-bright @[28rem]:text-left">{value}</span>
    </div>
  );
}

function tryPrettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractInputOutput(aiData: AISpanData): {
  userText: string | undefined;
  outputText: string | undefined;
  outputObject: string | undefined;
  outputToolNames: string[];
} {
  let userText: string | undefined;
  let outputText: string | undefined;
  const outputToolNames: string[] = [];

  if (aiData.items) {
    for (let i = aiData.items.length - 1; i >= 0; i--) {
      if (aiData.items[i].type === "user") {
        userText = (aiData.items[i] as { type: "user"; text: string }).text;
        break;
      }
    }

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

  if (!outputText && aiData.responseText) {
    outputText = aiData.responseText;
  }

  return {
    userText,
    outputText,
    outputObject: aiData.responseObject ? tryPrettyJson(aiData.responseObject) : undefined,
    outputToolNames,
  };
}

function hasAssistantItem(items: DisplayItem[] | undefined): boolean {
  if (!items) return false;
  return items.some((item) => item.type === "assistant");
}
