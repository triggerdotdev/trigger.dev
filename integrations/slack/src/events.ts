import type { TriggerEvent } from "@trigger.dev/sdk";
import {
  BlockActionInteractivityPayloadSchema,
  ViewSubmissionInteractivityPayloadSchema,
} from "./interactivity";

export function blockActionInteraction(params: {
  blockId: string;
  actionId?: string | string[];
}): TriggerEvent<typeof BlockActionInteractivityPayloadSchema> {
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
        type: "block_action",
        blockId: params.blockId,
        actionIds,
      },
    },
    schema: BlockActionInteractivityPayloadSchema,
  };
}

export function viewSubmissionInteraction(params: {
  callbackId?: string | string[];
}): TriggerEvent<typeof ViewSubmissionInteractivityPayloadSchema> {
  const callbackIds =
    typeof params.callbackId === "undefined"
      ? []
      : Array.isArray(params.callbackId)
      ? params.callbackId
      : [params.callbackId];

  return {
    metadata: {
      type: "SLACK_INTERACTION",
      service: "slack",
      name: "view.submission",
      filter: {
        service: ["slack"],
        payload: {
          view: {
            callback_id: callbackIds,
          },
        },
        event: ["view.submission"],
      },
      source: {
        type: "view_submission",
        callbackIds,
      },
    },
    schema: ViewSubmissionInteractivityPayloadSchema,
  };
}
