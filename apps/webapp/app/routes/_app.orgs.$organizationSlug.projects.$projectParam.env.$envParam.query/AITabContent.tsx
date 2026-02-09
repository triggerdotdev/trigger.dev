import { useState } from "react";
import { SparkleListIcon } from "~/assets/icons/SparkleListIcon";
import { AIQueryInput } from "~/components/code/AIQueryInput";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import type { AITimeFilter } from "./types";

export function AITabContent({
  onQueryGenerated,
  onTimeFilterChange,
  getCurrentQuery,
  aiFixRequest,
}: {
  onQueryGenerated: (query: string) => void;
  onTimeFilterChange?: (filter: AITimeFilter) => void;
  getCurrentQuery: () => string;
  aiFixRequest: { prompt: string; key: number } | null;
}) {
  const [examplePromptRequest, setExamplePromptRequest] = useState<{
    prompt: string;
    key: number;
  } | null>(null);

  // Use aiFixRequest if present, otherwise use example prompt request
  const activeRequest = aiFixRequest ?? examplePromptRequest;

  const examplePrompts = [
    "Show me failed runs by hour for the past 7 days",
    "Count of runs by status by hour for the past 48h",
    "Top 50 most expensive runs this week",
    "Average execution duration by task this week",
    "Run counts by tag in the past 7 days",
  ];

  return (
    <div className="space-y-2">
      <AIQueryInput
        onQueryGenerated={onQueryGenerated}
        onTimeFilterChange={onTimeFilterChange}
        autoSubmitPrompt={activeRequest?.prompt}
        autoSubmitKey={activeRequest?.key}
        getCurrentQuery={getCurrentQuery}
      />

      <div className="pt-4">
        <Header3 className="mb-3 text-text-bright">Example prompts</Header3>
        <div className="flex flex-wrap gap-2">
          {examplePrompts.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setExamplePromptRequest((prev) => ({
                  prompt: example,
                  key: (prev?.key ?? 0) + 1,
                }));
              }}
              className="group flex w-fit items-center gap-2 rounded-full border border-dashed border-charcoal-600 px-4 py-2 transition-colors hover:border-solid hover:border-indigo-500"
            >
              <SparkleListIcon className="size-4 text-text-dimmed transition group-hover:text-indigo-500" />
              <Paragraph variant="small" className="transition group-hover:text-text-bright">
                {example}
              </Paragraph>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
