/**
 * The agent's offer, as buttons. The block only emits an intent; the host
 * decides whether to honour it, so without `onIntent` there is nothing to
 * render.
 */
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
          // The first action is the one to take; the rest are alternatives.
          variant={i === 0 ? "primary/small" : "secondary/small"}
          onClick={() => onIntent(action.intent as AgentIntent)}
        >
          {action.label}
        </Button>
      ))}
    </ChatActionsRow>
  );
}
