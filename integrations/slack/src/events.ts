import type { TriggerEvent } from "@trigger.dev/sdk";
import { blockAction } from "./interactivity";

export function blockActionInteraction(params: {
  blockId: string;
  actionId?: string | string[];
}): TriggerEvent<typeof blockAction> {
  const actionIds =
    typeof params.actionId === "undefined"
      ? []
      : Array.isArray(params.actionId)
      ? params.actionId
      : [params.actionId];

  return {
    metadata: {
      type: "SLACK_INTERACTION",
      service: "slack",
      name: "block.action",
      filter: {
        service: ["slack"],
        payload: {
          actions: {
            block_id: [params.blockId],
            action_id: actionIds,
          },
        },
        event: ["block.action"],
      },
      source: {
        blockId: params.blockId,
        actionIds,
      },
    },
    schema: blockAction,
  };
}
