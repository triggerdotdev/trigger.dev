import type {
  ActionsBlock as ActionsBlockPayload,
  AgentIntent,
} from "@internal/dashboard-agent-contracts";
import { Button } from "~/components/primitives/Buttons";
import { ChatActionsRow } from "./chat-layout";
import { renderableActions, withoutWatchActions } from "./view-actions";

export function ActionsBlock({
  block,
  onIntent,
  dropWatch = false,
}: {
  block: ActionsBlockPayload;
  onIntent?: (intent: AgentIntent) => void;
  /** Set when an investigation card in the same answer already offers the watch. */
  dropWatch?: boolean;
}) {
  const actions = dropWatch ? withoutWatchActions(block.actions) : block.actions;
  const renderable = renderableActions(actions);
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
