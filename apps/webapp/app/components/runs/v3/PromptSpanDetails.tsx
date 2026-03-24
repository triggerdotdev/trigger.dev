import { lazy, Suspense, useState } from "react";
import { CodeBlock } from "~/components/code/CodeBlock";
import { Header3 } from "~/components/primitives/Headers";
import { TextLink } from "~/components/primitives/TextLink";
import { tryPrettyJson } from "./ai/aiHelpers";
import { SpanMetricRow as MetricRow } from "./ai/SpanMetricRow";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { v3PromptPath } from "~/utils/pathBuilder";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
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

type PromptTab = "overview" | "input" | "template";

export function PromptSpanDetails({ promptData }: { promptData: PromptSpanData }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const promptPath =
    organization && project && environment
      ? v3PromptPath(organization, project, environment, promptData.slug, promptData.version)
      : undefined;

  const hasInput = !!promptData.input;
  const hasTemplate = !!promptData.template;

  const availableTabs: PromptTab[] = [
    "overview",
    ...(hasInput ? (["input"] as const) : []),
    ...(hasTemplate ? (["template"] as const) : []),
  ];
  const [tab, setTab] = useState<PromptTab>("overview");

  const labels = promptData.labels
    ? promptData.labels
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 overflow-x-auto px-3 py-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <TabContainer>
          {availableTabs.map((t) => (
            <TabButton
              key={t}
              isActive={tab === t}
              layoutId="prompt-span"
              onClick={() => setTab(t)}
              shortcut={
                t === "overview" ? { key: "o" } : t === "input" ? { key: "i" } : { key: "t" }
              }
            >
              {t === "overview" ? "Overview" : t === "input" ? "Input" : "Template"}
            </TabButton>
          ))}
        </TabContainer>
      </div>

      <div className="scrollbar-gutter-stable min-h-0 flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        {tab === "overview" && (
          <div className="flex flex-col px-3">
            <div className="flex flex-col gap-1 py-2.5">
              <div className="flex flex-col text-xs @container">
                <MetricRow
                  label="Prompt"
                  value={
                    promptPath ? (
                      <TextLink to={promptPath}>{promptData.slug}</TextLink>
                    ) : (
                      promptData.slug
                    )
                  }
                />
                <MetricRow label="Version" value={`v${promptData.version}`} />
                {labels.length > 0 && <MetricRow label="Labels" value={labels.join(", ")} />}
                {promptData.model && <MetricRow label="Model" value={promptData.model} />}
              </div>
            </div>

            {promptData.text && (
              <div className="flex flex-col gap-1.5 py-2.5">
                <Header3>Resolved content</Header3>
                <div className="rounded-md border border-grid-bright bg-charcoal-750/50 px-3.5 py-2">
                  <div className="font-sans text-sm font-normal text-text-dimmed streamdown-container">
                    <Suspense
                      fallback={
                        <span className="whitespace-pre-wrap">
                          {promptData.text.length > 300
                            ? promptData.text.slice(0, 300) + "..."
                            : promptData.text}
                        </span>
                      }
                    >
                      <StreamdownRenderer>{promptData.text}</StreamdownRenderer>
                    </Suspense>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "input" && hasInput && (
          <div className="px-3 py-2.5">
            <CodeBlock
              code={tryPrettyJson(promptData.input!)}
              maxLines={30}
              showLineNumbers={false}
              showCopyButton
              language="json"
            />
          </div>
        )}

        {tab === "template" && hasTemplate && (
          <div className="px-3 py-2.5">
            <div className="rounded-md border border-grid-bright bg-charcoal-750/50 px-3.5 py-2">
              <div className="font-sans text-sm font-normal text-text-dimmed streamdown-container">
                <Suspense
                  fallback={
                    <span className="whitespace-pre-wrap">{promptData.template!}</span>
                  }
                >
                  <StreamdownRenderer>{promptData.template!}</StreamdownRenderer>
                </Suspense>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

