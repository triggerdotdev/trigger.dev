import type {
  ActionsBlock as ActionsBlockPayload,
  AgentIntent,
} from "@internal/dashboard-agent-contracts";
import { Button } from "~/components/primitives/Buttons";
import { ChatActionsRow } from "./chat-layout";
import { renderableActions } from "./view-actions";

export function ActionsBlock({
  block,
  onIntent,
}: {
  block: ActionsBlockPayload;
  onIntent?: (intent: AgentIntent) => void;
}) {
  const renderable = renderableActions(block.actions);
  if (!onIntent || renderable.length === 0) return null;
  return (
    <ChatActionsRow>
      {renderable.map((action, i) => (
        <Button
          key={i}
          variant={i === 0 ? "primary/small" : "secondary/small"}
          onClick={() => onIntent(action.intent as AgentIntent)}
        >
          {action.label}
        </Button>
      ))}
    </ChatActionsRow>
  );
}
