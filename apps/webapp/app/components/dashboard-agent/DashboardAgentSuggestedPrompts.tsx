import { SparklesIcon } from "@heroicons/react/20/solid";
import { Paragraph } from "~/components/primitives/Paragraph";

// Static for now; later these can be page-aware (per currentPage) or server-driven.
const SUGGESTED_PROMPTS = [
  "What can you help me with?",
  "How do retries work in Trigger.dev?",
  "Where do I set environment variables?",
  "Explain what this page shows.",
];

export function DashboardAgentSuggestedPrompts({
  onSelect,
}: {
  onSelect: (prompt: string) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <SparklesIcon className="size-6 text-indigo-500" />
        <Paragraph variant="small" className="text-text-dimmed">
          Ask about your runs, errors, or how Trigger.dev works.
        </Paragraph>
      </div>
      <div className="flex w-full flex-col gap-1.5">
        {SUGGESTED_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onSelect(prompt)}
            className="rounded-md border border-charcoal-700 bg-charcoal-800/40 px-3 py-2 text-left text-sm text-text-dimmed transition hover:border-charcoal-600 hover:text-text-bright"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
