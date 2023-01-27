import { z } from "zod";
import {
  knownBlockSchema,
  mrkdwnElementSchema,
  plainTextElementSchema,
  viewSchema,
} from "./blocks";

const blockActionType = z.union([
  z.literal("block_actions"),
  z.literal("interactive_message"),
]);

const sourceType = z.literal("message");

const commonActionSchema = z.object({
  action_id: z.string(),
  block_id: z.string(),
  action_ts: z.string(),
});

const buttonAction = z.object({
  type: z.literal("button"),
  value: z.string(),
});

const staticSelectAction = z.object({
  type: z.literal("static_select"),
  selected_option: z.object({
    text: z.object({
      type: z.string(),
      text: z.string(),
      emoji: z.boolean().optional(),
    }),
    value: z.string(),
  }),
  placeholder: z
    .object({
      type: z.string(),
      text: z.string(),
      emoji: z.boolean(),
    })
    .optional(),
});

const userSelectAction = z.object({
  type: z.literal("users_select"),
  selected_user: z.string(),
});

const conversationsSelectAction = z.object({
  type: z.literal("conversations_select"),
  selected_conversation: z.string(),
});
const channelSelectAction = z.object({
  type: z.literal("channels_select"),
  selected_channel: z.string(),
});

const possibleActionsSchema = z.discriminatedUnion("type", [
  buttonAction,
  staticSelectAction,
  userSelectAction,
  conversationsSelectAction,
  channelSelectAction,
]);
const actionSchema = possibleActionsSchema.and(commonActionSchema);

const stateSchema = z.object({
  values: z.record(z.record(possibleActionsSchema)),
});

const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  team_id: z.string(),
});

const containerSchema = z.object({
  type: sourceType,
  message_ts: z.string(),
  channel_id: z.string(),
  is_ephemeral: z.boolean(),
});

const teamSchema = z.object({ id: z.string(), domain: z.string() });
const channelSchema = z.object({ id: z.string(), name: z.string() });

const viewActionDataSchema = z.object({
  id: z.string(),
  team_id: z.string(),
  state: z
    .object({
      values: z.record(z.record(z.any())),
    })
    .optional(),
  hash: z.string(),
  previous_view_id: z.string().optional(),
  root_view_id: z.string().optional(),
  app_id: z.string().optional(),
  app_installed_team_id: z.string().optional(),
  bot_id: z.string().optional(),
});
const viewActionSchema: Zod.ZodIntersection<
  typeof viewSchema,
  typeof viewActionDataSchema
> = viewSchema.and(viewActionDataSchema);

const messageActionSchema = z.object({
  bot_id: z.string(),
  type: sourceType,
  text: z.string().optional(),
  user: z.string().optional(),
  ts: z.string(),
  app_id: z.string().optional(),
  blocks: z.array(knownBlockSchema).optional(),
  team: z.string().optional(),
  metadata: z
    .object({
      event_type: z.string(),
      event_payload: z.object({ requestId: z.string() }),
    })
    .optional(),
});

export const blockAction: Zod.ZodObject<{
  type: typeof blockActionType;
  user: typeof userSchema;
  api_app_id: Zod.ZodString;
  container: typeof containerSchema;
  trigger_id: z.ZodOptional<Zod.ZodString>;
  team: typeof teamSchema;
  enterprise: Zod.ZodAny;
  is_enterprise_install: Zod.ZodBoolean;
  channel: typeof channelSchema;
  view: z.ZodOptional<typeof viewActionSchema>;
  message: z.ZodOptional<typeof messageActionSchema>;
  state: z.ZodOptional<typeof stateSchema>;
  response_url: Zod.ZodString;
  actions: Zod.ZodArray<typeof actionSchema>;
}> = z.object({
  type: blockActionType,
  user: userSchema,
  api_app_id: z.string(),
  container: containerSchema,
  trigger_id: z.string().optional(),
  team: teamSchema,
  enterprise: z.any(),
  is_enterprise_install: z.boolean(),
  channel: channelSchema,
  view: viewActionSchema.optional(),
  message: messageActionSchema.optional(),
  state: stateSchema.optional(),
  response_url: z.string(),
  actions: z.array(actionSchema),
});
