import { useState } from "react";
import { AIQueryInput } from "~/components/code/AIQueryInput";
import { Header3 } from "~/components/primitives/Headers";
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
        <Header3 className="mb-2 text-text-bright">Example prompts</Header3>
        <div className="space-y-2">
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
              className="block w-full rounded-md border border-grid-dimmed bg-charcoal-800 px-3 py-2 text-left text-sm text-text-dimmed transition-colors hover:border-grid-bright hover:bg-charcoal-750 hover:text-text-bright"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

