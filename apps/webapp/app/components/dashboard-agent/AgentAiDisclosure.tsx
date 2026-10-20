import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";
import { ASK_AGENT_LABEL } from "./agent-identity";

// Names the agent as AI, not only fallible: "Ask Trigger" alone could read as a support team.
export const AGENT_AI_DISCLOSURE = `${ASK_AGENT_LABEL} is an AI assistant and can make mistakes.`;

/** The panel's last line in every state (see `AgentPanelColumn`), so it always says the agent is
 * AI. Faded 30% toward the background, quieter than anything the user acts on. */
export function AgentAiDisclosure({ className }: { className?: string }) {
  return (
    <Paragraph
      variant="extra-small"
      className={cn("text-balance text-center opacity-70", className)}
    >
      {AGENT_AI_DISCLOSURE}
    </Paragraph>
  );
}
