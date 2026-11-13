import type {
  ActionsBlock as ActionsBlockPayload,
  AgentIntent,
} from "@internal/dashboard-agent-contracts";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { ChatActionsRow } from "./chat-layout";
import { renderableActions, withoutWatchActions } from "./view-actions";

const SET_UP_A_WATCH = "Set up a watch";

export function ActionsBlock({
  block,
  onIntent,
  followedByPlan = false,
}: {
  block: ActionsBlockPayload;
  onIntent?: (intent: AgentIntent) => boolean | void;
  followedByPlan?: boolean;
}) {
  const [clicked, setClicked] = useState(false);
  const actions = withoutWatchActions(block.actions);
  const renderable = renderableActions(actions);
  if (!onIntent || renderable.length === 0) return null;
  return (
    <ChatActionsRow>
      {renderable.map((action, i) => (
        <Button
          key={i}
          variant={i === 0 ? "primary/small" : "secondary/small"}
          disabled={
            clicked ||
            (followedByPlan &&
              action.intent.kind === "ask" &&
              action.intent.prompt === SET_UP_A_WATCH)
          }
          onClick={() => {
            if (onIntent(action.intent as AgentIntent) !== false) setClicked(true);
          }}
        >
          {action.label}
        </Button>
      ))}
    </ChatActionsRow>
  );
}
