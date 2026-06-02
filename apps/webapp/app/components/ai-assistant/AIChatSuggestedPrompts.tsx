import { motion } from "framer-motion";
import { SparkleListIcon } from "~/assets/icons/SparkleListIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useAIChat } from "./AIChatProvider";
import { getPrompts } from "./suggested-prompts";

interface AIChatSuggestedPromptsProps {
  currentPage: string;
  onSelect: (prompt: string) => void;
}

// Stagger the pills in from the right — same motion vocabulary as the legacy
// AskAI suggested prompts so the assistant feels consistent across surfaces.
const container = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1, delayChildren: 0.2 },
  },
};

const item = {
  hidden: { opacity: 0, x: 20 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      opacity: { duration: 0.5, ease: "linear" },
      x: { type: "spring", stiffness: 300, damping: 25 },
    },
  },
};

export function AIChatSuggestedPrompts({ currentPage, onSelect }: AIChatSuggestedPromptsProps) {
  const prompts = getPrompts(currentPage);
  // The panel stays mounted across close/open, so this component never
  // unmounts. Keying the motion container on `isOpen` remounts it on each
  // open, replaying the stagger every time rather than only on first mount.
  const { isOpen } = useAIChat();

  return (
    <div className="flex flex-col gap-2 px-3 pb-2">
      <Paragraph className="mb-2 mt-1.5 pl-1 text-text-dimmed">
        I can help you navigate the dashboard, find documentation, and understand Trigger.dev
        features. Ask me anything.
      </Paragraph>
      <motion.div
        key={isOpen ? "open" : "closed"}
        className="flex flex-col gap-2"
        variants={container}
        initial="hidden"
        animate="visible"
      >
        {prompts.map((prompt, index) => (
          <motion.button
            key={index}
            variants={item}
            className="group flex w-fit items-center gap-2 rounded-full border border-dashed border-charcoal-600 px-4 py-2 text-left transition-colors hover:border-solid hover:border-indigo-500"
            onClick={() => onSelect(prompt)}
          >
            <SparkleListIcon className="size-4 shrink-0 text-text-dimmed transition group-hover:text-indigo-500" />
            <Paragraph variant="small" className="transition group-hover:text-text-bright">
              {prompt}
            </Paragraph>
          </motion.button>
        ))}
      </motion.div>
    </div>
  );
}
