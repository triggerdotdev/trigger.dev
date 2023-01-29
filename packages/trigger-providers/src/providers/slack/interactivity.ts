import { z } from "zod";
import {
  knownBlockSchema,
  mrkdwnElementSchema,
  optionFieldSchema,
  plainTextElementSchema,
  viewSchema,
} from "./blocks";

const textSchema = z.discriminatedUnion("type", [
  plainTextElementSchema,
  mrkdwnElementSchema,
]);
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
  text: textSchema.optional(),
  value: z.string(),
});

const selectedOptionSchema = z.object({
  text: z.object({
    type: z.string(),
    text: z.string(),
    emoji: z.boolean().optional(),
  }),
  value: z.string(),
});
const placeholderSchema = z.object({
  type: z.string(),
  text: z.string(),
  emoji: z.boolean(),
});
const staticSelectAction = z.object({
  type: z.literal("static_select"),
  selected_option: selectedOptionSchema.nullable(),
  placeholder: placeholderSchema.optional(),
});

const userSelectAction = z.object({
  type: z.literal("users_select"),
  selected_user: z.string().nullable(),
  initial_user: z.string().optional(),
});

const conversationsSelectAction = z.object({
  type: z.literal("conversations_select"),
  selected_conversation: z.string().nullable(),
  initial_conversation: z.string().optional(),
});
const channelSelectAction = z.object({
  type: z.literal("channels_select"),
  selected_channel: z.string().nullable(),
  initial_channel: z.string().optional(),
});

const datePickerAction = z.object({
  type: z.literal("datepicker"),
  selected_date: z.string().nullable(),
  initial_date: z.string().optional(),
});

const checkboxesAction = z.object({
  type: z.literal("checkboxes"),
  selected_options: z.array(optionFieldSchema),
});

const radioButtonsSchema = z.object({
  type: z.literal("radio_buttons"),
  selectedOption: optionFieldSchema,
});

const timePickerSchema = z.object({
  type: z.literal("timepicker"),
  selected_time: z.string().nullable(),
  initial_time: z.string().optional(),
});

const plainTextInputSchema = z.object({
  type: z.literal("plain_text_input"),
  value: z.string().nullable(),
  initial_value: z.string().optional(),
});

const multiUsersSelectSchema = z.object({
  type: z.literal("multi_users_select"),
  selected_users: z.array(z.string()),
  initial_users: z.array(z.string()).optional(),
});

const multiStaticSelectSchema = z.object({
  type: z.literal("multi_static_select"),
  selected_options: z.array(selectedOptionSchema),
  placeholder: placeholderSchema.optional(),
});

const possibleActionsSchema = z.discriminatedUnion("type", [
  buttonAction,
  staticSelectAction,
  userSelectAction,
  conversationsSelectAction,
  channelSelectAction,
  datePickerAction,
  checkboxesAction,
  radioButtonsSchema,
  timePickerSchema,
  plainTextInputSchema,
  multiUsersSelectSchema,
  multiStaticSelectSchema,
]);

const actionSchema = possibleActionsSchema.and(commonActionSchema);

//state.values.issue.action.block.rating.selected_option
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

export const blockAction = z.any();
