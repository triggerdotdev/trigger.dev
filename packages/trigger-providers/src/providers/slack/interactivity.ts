import { z } from "zod";
import { plainTextElementSchema } from "./blocks";

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
  trigger_id: z.string(),
  team: z.object({ id: z.string(), domain: z.string() }),
  enterprise: z.null(),
  is_enterprise_install: z.boolean(),
  channel: z.object({ id: z.string(), name: z.string() }),
  message: z
    .object({
      bot_id: z.string(),
      type: sourceType,
      text: z.string(),
      user: z.string(),
      ts: z.string(),
      app_id: z.string(),
      blocks: z.array(
        z.union([
          z.object({
            type: z.string(),
            block_id: z.string(),
            text: z.object({
              type: z.string(),
              text: z.string(),
              verbatim: z.boolean(),
            }),
          }),
          z.object({ type: z.string(), block_id: z.string() }),
          z.object({
            type: z.string(),
            block_id: z.string(),
            text: z.object({
              type: z.string(),
              text: z.string(),
              verbatim: z.boolean(),
            }),
            accessory: z.object({
              type: z.string(),
              image_url: z.string(),
              alt_text: z.string(),
            }),
          }),
          z.object({
            type: z.string(),
            block_id: z.string(),
            elements: z.array(
              z.union([
                z.object({
                  type: z.string(),
                  action_id: z.string(),
                  text: z.object({
                    type: z.string(),
                    text: z.string(),
                    emoji: z.boolean(),
                  }),
                  value: z.string(),
                }),
                z.object({
                  type: z.string(),
                  action_id: z.string(),
                  text: z.object({
                    type: z.string(),
                    text: z.string(),
                    emoji: z.boolean(),
                  }),
                  value: z.string(),
                  url: z.string(),
                }),
              ])
            ),
          }),
        ])
      ),
      team: z.string(),
    })
    .optional(),
  state: z.object({ values: z.object({}) }),
  response_url: z.string(),
  actions: z.array(
    z.object({
      action_id: z.string(),
      block_id: z.string(),
      text: plainTextElementSchema,
      value: z.string(),
      type: z.string(),
      action_ts: z.string(),
    })
  ),
});
