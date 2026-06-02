import { SparkleListIcon } from "~/assets/icons/SparkleListIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { getPrompts } from "./suggested-prompts";

interface AIChatSuggestedPromptsProps {
  currentPage: string;
  onSelect: (prompt: string) => void;
}

export function AIChatSuggestedPrompts({ currentPage, onSelect }: AIChatSuggestedPromptsProps) {
  const prompts = getPrompts(currentPage);

  return (
    <div className="flex flex-col gap-2 px-4 pb-2">
      <Paragraph className="mb-2 mt-1.5 pl-1 text-text-dimmed">
        I can help you navigate the dashboard, find documentation, and understand Trigger.dev
        features. Ask me anything.
      </Paragraph>
      {prompts.map((prompt, index) => (
        <button
          key={index}
          className="group flex w-fit items-center gap-2 rounded-full border border-dashed border-charcoal-600 px-4 py-2 text-left transition-colors hover:border-solid hover:border-indigo-500"
          onClick={() => onSelect(prompt)}
        >
          <SparkleListIcon className="size-4 shrink-0 text-text-dimmed transition group-hover:text-indigo-500" />
          <Paragraph variant="small" className="transition group-hover:text-text-bright">
            {prompt}
          </Paragraph>
        </button>
      ))}
    </div>
  );
}