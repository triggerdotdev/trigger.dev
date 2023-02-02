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

const viewContainerSchema = z.object({
  type: z.literal("view"),
  view_id: z.string(),
});

const messageContainerSchema = z.object({
  type: z.literal("message"),
  message_ts: z.string(),
  channel_id: z.string(),
  is_ephemeral: z.boolean(),
});

const containerSchema = z.discriminatedUnion("type", [
  viewContainerSchema,
  messageContainerSchema,
]);

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
  previous_view_id: z.string().nullable().optional(),
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

export const BlockActionInteractivityPayloadSchema: Zod.ZodObject<{
  type: z.ZodLiteral<"block_actions">;
  team: typeof teamSchema;
  user: typeof userSchema;
  api_app_id: Zod.ZodString;
  container: z.ZodOptional<typeof containerSchema>;
  trigger_id: z.ZodOptional<Zod.ZodString>;
  channel: z.ZodOptional<typeof channelSchema>;
  view: z.ZodOptional<typeof viewActionSchema>;
  message: z.ZodOptional<typeof messageActionSchema>;
  state: z.ZodOptional<typeof stateSchema>;
  response_url: z.ZodOptional<Zod.ZodString>;
  actions: Zod.ZodArray<typeof actionSchema>;
}> = z.object({
  type: z.literal("block_actions"),
  team: teamSchema,
  user: userSchema,
  api_app_id: z.string(),
  container: containerSchema.optional(),
  trigger_id: z.string().optional(),
  channel: channelSchema.optional(),
  view: viewActionSchema.optional(),
  message: messageActionSchema.optional(),
  state: stateSchema.optional(),
  response_url: z.string().optional(),
  actions: z.array(actionSchema),
});

const ResponseUrlObjectSchema = z.object({
  response_url: z.string(),
  block_id: z.string(),
  action_id: z.string(),
  channel_id: z.string(),
});

export const ViewSubmissionInteractivityPayloadSchema: Zod.ZodObject<{
  type: z.ZodLiteral<"view_submission">;
  team: typeof teamSchema;
  user: typeof userSchema;
  view: typeof viewActionSchema;
  response_urls: Zod.ZodArray<typeof ResponseUrlObjectSchema>;
  api_app_id: Zod.ZodString;
  trigger_id: z.ZodOptional<Zod.ZodString>;
  token: z.ZodOptional<Zod.ZodString>;
}> = z.object({
  type: z.literal("view_submission"),
  team: teamSchema,
  user: userSchema,
  view: viewActionSchema,
  response_urls: z.array(ResponseUrlObjectSchema),
  api_app_id: z.string(),
  trigger_id: z.string().optional(),
  token: z.string().optional(),
});

export const ViewClosedInteractivityPayloadSchema: Zod.ZodObject<{
  type: z.ZodLiteral<"view_closed">;
  team: typeof teamSchema;
  user: typeof userSchema;
  view: typeof viewActionSchema;
  is_cleared: Zod.ZodBoolean;
  api_app_id: Zod.ZodString;
}> = z.object({
  type: z.literal("view_closed"),
  team: teamSchema,
  user: userSchema,
  view: viewActionSchema,
  is_cleared: z.boolean(),
  api_app_id: z.string(),
});

export const InteractivityPayloadSchema: Zod.ZodDiscriminatedUnion<
  "type",
  [
    typeof BlockActionInteractivityPayloadSchema,
    typeof ViewSubmissionInteractivityPayloadSchema,
    typeof ViewClosedInteractivityPayloadSchema
  ]
> = z.discriminatedUnion("type", [
  BlockActionInteractivityPayloadSchema,
  ViewSubmissionInteractivityPayloadSchema,
  ViewClosedInteractivityPayloadSchema,
]);

export const ViewPrivateMetadataSchema = z.object({
  __trigger: z.object({
    runId: z.string(),
    onSubmit: z.enum(["clear", "close", "none"]),
    validationSchema: z.any().optional(),
  }),
});
