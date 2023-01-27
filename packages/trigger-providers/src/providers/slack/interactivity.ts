import { z } from "zod";

const blockActionType = z.union([
  z.literal("block_actions"),
  z.literal("interactive_message"),
]);

const sourceType = z.literal("message");

export const blockAction = z.object({
  type: blockActionType,
  user: z.object({
    id: z.string(),
    username: z.string(),
    name: z.string(),
    team_id: z.string(),
  }),
  api_app_id: z.string(),
  container: z.object({
    type: sourceType,
    message_ts: z.string(),
    channel_id: z.string(),
    is_ephemeral: z.boolean(),
  }),
  trigger_id: z.string().optional(),
  team: z.object({ id: z.string(), domain: z.string() }),
  enterprise: z.null(),
  is_enterprise_install: z.boolean(),
  channel: z.object({ id: z.string(), name: z.string() }),
  message: z
    .object({
      bot_id: z.string(),
      type: sourceType,
      text: z.string().optional(),
      user: z.string().optional(),
      ts: z.string(),
      app_id: z.string().optional(),
      blocks: z.array(z.any()).optional(),
      team: z.string().optional(),
      metadata: z
        .object({
          event_type: z.string(),
          event_payload: z.object({ requestId: z.string() }),
        })
        .optional(),
    })
    .optional(),
  state: z.object({ values: z.object({}) }),
  response_url: z.string(),
  actions: z.array(
    z.object({
      action_id: z.string(),
      block_id: z.string(),
      value: z.string(),
      type: z.string(),
      action_ts: z.string(),
    })
  ),
});
