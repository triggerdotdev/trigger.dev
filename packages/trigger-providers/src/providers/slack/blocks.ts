import { z } from "zod";

export const imageElementSchema = z.object({
  type: z.literal("image"),
  image_url: z.string(),
  alt_text: z.string(),
});

export const plainTextElementSchema = z.object({
  type: z.literal("plain_text"),
  text: z.string(),
  emoji: z.boolean().optional(),
});

export const mrkdwnElementSchema = z.object({
  type: z.literal("mrkdwn"),
  text: z.string(),
  verbatim: z.boolean().optional(),
});

export const mrkdwnOptionSchema = z.object({
  text: mrkdwnElementSchema,
  value: z.string().optional(),
  url: z.string().optional(),
  description: plainTextElementSchema.optional(),
});

export const plainTextOptionSchema = z.object({
  text: plainTextElementSchema,
  value: z.string().optional(),
  url: z.string().optional(),
  description: plainTextElementSchema.optional(),
});

export const optionSchema = z.union([
  mrkdwnOptionSchema,
  plainTextOptionSchema,
]);

export const confirmSchema = z.object({
  title: plainTextElementSchema.optional(),
  text: z.union([plainTextElementSchema, mrkdwnElementSchema]),
  confirm: plainTextElementSchema.optional(),
  deny: plainTextElementSchema.optional(),
  style: z.union([z.literal("primary"), z.literal("danger")]).optional(),
});

/**
 * @description Determines when an input element will return a
 * {@link https://api.slack.com/reference/interaction-payloads/block-actions `block_actions` interaction payload}.
 */
export const dispatchActionConfigSchema = z.object({
  /**
   * @description An array of interaction types that you would like to receive a
   * {@link https://api.slack.com/reference/interaction-payloads/block-actions `block_actions` payload} for. Should be
   * one or both of:
   *   `on_enter_pressed` — payload is dispatched when user presses the enter key while the input is in focus. Hint
   *   text will appear underneath the input explaining to the user to press enter to submit.
   *   `on_character_entered` — payload is dispatched when a character is entered (or removed) in the input.
   */
  trigger_actions_on: z
    .array(
      z.union([
        z.literal("on_enter_pressed"),
        z.literal("on_character_entered"),
      ])
    )
    .optional(),
});

export const actionSchema = z.object({
  type: z.string(),
  /**
   * @description: An identifier for this action. You can use this when you receive an interaction payload to
   * {@link https://api.slack.com/interactivity/handling#payloads identify the source of the action}. Should be unique
   * among all other `action_id`s in the containing block. Maximum length for this field is 255 characters.
   */
  action_id: z.string().optional(),
});

export const confirmableSchema = z.object({
  /**
   * @description A {@see Confirm} object that defines an optional confirmation dialog after the element is interacted
   * with.
   */
  confirm: confirmSchema.optional(),
});

export const focusableSchema = z.object({
  /**
   * @description Indicates whether the element will be set to auto focus within the
   * {@link https://api.slack.com/reference/surfaces/views `view` object}. Only one element can be set to `true`.
   * Defaults to `false`.
   */
  focus_on_load: z.boolean().optional(),
});

export const placeholdableSchema = z.object({
  /**
   * @description A {@see PlainTextElement} object that defines the placeholder text shown on the element. Maximum
   * length for the `text` field in this object is 150 characters.
   */
  placeholder: plainTextElementSchema.optional(),
});

export const dispatchableSchema = z.object({
  /**
   * @description A {@see DispatchActionConfig} object that determines when during text input the element returns a
   * {@link https://api.slack.com/reference/interaction-payloads/block-actions `block_actions` payload}.
   */
  dispatch_action_config: dispatchActionConfigSchema.optional(),
});

export const usersSelectSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("users_select"),
    initial_user: z.string().optional(),
  });

export const multiUsersSelectSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("multi_users_select"),
    initial_users: z.array(z.string()).optional(),
    max_selected_items: z.number().optional(),
  });

export const staticSelectSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("static_select"),
    initial_option: plainTextOptionSchema.optional(),
    options: z.array(plainTextOptionSchema).optional(),
    option_groups: z
      .array(
        z.object({
          label: plainTextElementSchema,
          options: z.array(plainTextOptionSchema),
        })
      )
      .optional(),
  });

export const multiStaticSelectSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("multi_static_select"),
    initial_options: z.array(plainTextOptionSchema).optional(),
    options: z.array(plainTextOptionSchema).optional(),
    option_groups: z
      .array(
        z.object({
          label: plainTextElementSchema,
          options: z.array(plainTextOptionSchema),
        })
      )
      .optional(),
    max_selected_items: z.number().optional(),
  });

export const conversationsSelectSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("conversations_select"),
    initial_conversation: z.string().optional(),
    response_url_enabled: z.boolean().optional(),
    default_to_current_conversation: z.boolean().optional(),
    filter: z
      .object({
        include: z
          .array(
            z.union([
              z.literal("im"),
              z.literal("mpim"),
              z.literal("private"),
              z.literal("public"),
            ])
          )
          .optional(),
        exclude_external_shared_channels: z.boolean().optional(),
        exclude_bot_users: z.boolean().optional(),
      })
      .optional(),
  });

export const multiConversationsSelectSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("multi_conversations_select"),
    initial_conversations: z.array(z.string()).optional(),
    max_selected_items: z.number().optional(),
    default_to_current_conversation: z.boolean().optional(),
    filter: z
      .object({
        include: z
          .array(
            z.union([
              z.literal("im"),
              z.literal("mpim"),
              z.literal("private"),
              z.literal("public"),
            ])
          )
          .optional(),
        exclude_external_shared_channels: z.boolean().optional(),
        exclude_bot_users: z.boolean().optional(),
      })
      .optional(),
  });

export const channelsSelectSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("channels_select"),
    initial_channel: z.string().optional(),
  });

export const multiChannelsSelectSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("multi_channels_select"),
    initial_channels: z.array(z.string()).optional(),
    max_selected_items: z.number().optional(),
  });

export const externalSelectSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("external_select"),
    initial_option: plainTextOptionSchema.optional(),
    min_query_length: z.number().optional(),
  });

export const multiExternalSelectSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("multi_external_select"),
    initial_options: z.array(plainTextOptionSchema).optional(),
    min_query_length: z.number().optional(),
    max_selected_items: z.number().optional(),
  });

export const buttonSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend({
    type: z.literal("button"),
    text: plainTextElementSchema,
    value: z.string().optional(),
    url: z.string().optional(),
    style: z.union([z.literal("danger"), z.literal("primary")]).optional(),
    accessibility_label: z.string().optional(),
  });

export const overflowSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend({
    type: z.literal("overflow"),
    options: z.array(plainTextOptionSchema),
  });

export const datepickerSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("datepicker"),
    initial_date: z.string().optional(),
  });

export const timepickerSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("timepicker"),
    initial_time: z.string().optional(),
    timezone: z.string().optional(),
  });

export const radioButtonsSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend({
    type: z.literal("radio_buttons"),
    initial_option: optionSchema.optional(),
    options: z.array(optionSchema),
  });

/**
 * @description An element that allows the selection of a time of day formatted as a UNIX timestamp. On desktop
 * clients, this time picker will take the form of a dropdown list and the date picker will take the form of a dropdown
 * calendar. Both options will have free-text entry for precise choices. On mobile clients, the time picker and date
 * picker will use native UIs.
 * {@link https://api.slack.com/reference/block-kit/block-elements#datetimepicker}
 */
export const dateTimepickerSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend({
    type: z.literal("datetimepicker"),
    /**
     * @description The initial date and time that is selected when the element is loaded, represented as a UNIX
     * timestamp in seconds. This should be in the format of 10 digits, for example 1628633820 represents the date and
     * time August 10th, 2021 at 03:17pm PST.
     */
    initial_date_time: z.number().optional(),
  });

export const checkboxesSchema = actionSchema
  .extend(confirmableSchema.shape)
  .extend(focusableSchema.shape)
  .extend({
    type: z.literal("checkboxes"),
    initial_options: z.array(optionSchema).optional(),
    options: z.array(optionSchema),
  });

export const plainTextInputSchema = actionSchema
  .extend(dispatchableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("plain_text_input"),
    initial_value: z.string().optional(),
    multiline: z.boolean().optional(),
    min_length: z.number().optional(),
    max_length: z.number().optional(),
    dispatch_action_config: dispatchActionConfigSchema.optional(),
    focus_on_load: z.boolean().optional(),
  });

/**
 * @description A URL input element, similar to the {@see PlainTextInput} element, creates a single line field where
 * a user can enter URL-encoded data.
 * {@link https://api.slack.com/reference/block-kit/block-elements#url}
 */
export const uRLInputSchema = actionSchema
  .extend(dispatchableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("url_text_input"),
    /**
     * @description The initial value in the URL input when it is loaded.
     */
    initial_value: z.string().optional(),
  });

/**
 * @description An email input element, similar to the {@see PlainTextInput} element, creates a single line field where
 * a user can enter an email address.
 * {@link https://api.slack.com/reference/block-kit/block-elements#email}
 */
export const emailInputSchema = actionSchema
  .extend(dispatchableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("email_text_input"),
    /**
     * @description The initial value in the email input when it is loaded.
     */
    initial_value: z.string().optional(),
  });

/**
 * @description A number input element, similar to the {@see PlainTextInput} element, creates a single line field where
 * a user can a number. This input elements accepts floating point numbers, for example, 0.25, 5.5, and -10 are all
 * valid input values. Decimal numbers are only allowed when `is_decimal_allowed` is equal to `true`.
 * {@link https://api.slack.com/reference/block-kit/block-elements#number}
 */
export const numberInputSchema = actionSchema
  .extend(dispatchableSchema.shape)
  .extend(focusableSchema.shape)
  .extend(placeholdableSchema.shape)
  .extend({
    type: z.literal("number_input"),
    /**
     * @description Decimal numbers are allowed if this property is `true`, set the value to `false` otherwise.
     */
    is_decimal_allowed: z.boolean(),
    /**
     * @description The initial value in the input when it is loaded.
     */
    initial_value: z.string().optional(),
    /**
     * @description The minimum value, cannot be greater than `max_value`.
     */
    min_value: z.string().optional(),
    /**
     * @description The maximum value, cannot be less than `min_value`.
     */
    max_value: z.string().optional(),
  });

export const blockSchema = z.object({
  type: z.string(),
  block_id: z.string().optional(),
});

export const imageBlockSchema = blockSchema.extend({
  type: z.literal("image"),
  image_url: z.string(),
  alt_text: z.string(),
  title: plainTextElementSchema.optional(),
});

export const contextBlockSchema = blockSchema.extend({
  type: z.literal("context"),
  elements: z.array(
    z.union([imageElementSchema, plainTextElementSchema, mrkdwnElementSchema])
  ),
});

export const dividerBlockSchema = blockSchema.extend({
  type: z.literal("divider"),
});

export const fileBlockSchema = blockSchema.extend({
  type: z.literal("file"),
  source: z.string(),
  external_id: z.string(),
});

export const headerBlockSchema = blockSchema.extend({
  type: z.literal("header"),
  text: plainTextElementSchema,
});

export const messageMetadataEventPayloadObjectSchema = z.record(
  z.union([z.string(), z.number(), z.boolean()])
);

export const messageAttachmentPreviewSchema = z.object({
  type: z.string().optional(),
  can_remove: z.boolean().optional(),
  title: plainTextElementSchema.optional(),
  subtitle: plainTextElementSchema.optional(),
  iconUrl: z.string().optional(),
});

export const optionFieldSchema = z.object({
  description: z.string().optional(),
  text: z.string(),
  value: z.string(),
});

export const confirmationSchema = z.object({
  dismiss_text: z.string().optional(),
  ok_text: z.string().optional(),
  text: z.string(),
  title: z.string().optional(),
});

export const selectOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});

export const callUserSlackSchema = z.object({
  slack_id: z.string(),
});

export const callUserExternalSchema = z.object({
  external_id: z.string(),
  display_name: z.string(),
  avatar_url: z.string(),
});

export const videoBlockSchema = blockSchema.extend({
  type: z.literal("video"),
  video_url: z.string(),
  thumbnail_url: z.string(),
  alt_text: z.string(),
  title: plainTextElementSchema,
  title_url: z.string().optional(),
  author_name: z.string().optional(),
  provider_name: z.string().optional(),
  provider_icon_url: z.string().optional(),
  description: plainTextElementSchema.optional(),
});

export const dialogSchema = z.object({
  title: z.string(),
  callback_id: z.string(),
  elements: z.array(
    z.object({
      type: z.union([
        z.literal("text"),
        z.literal("textarea"),
        z.literal("select"),
      ]),
      name: z.string(),
      label: z.string(),
      optional: z.boolean().optional(),
      placeholder: z.string().optional(),
      value: z.string().optional(),
      max_length: z.number().optional(),
      min_length: z.number().optional(),
      hint: z.string().optional(),
      subtype: z
        .union([
          z.literal("email"),
          z.literal("number"),
          z.literal("tel"),
          z.literal("url"),
        ])
        .optional(),
      data_source: z
        .union([
          z.literal("users"),
          z.literal("channels"),
          z.literal("conversations"),
          z.literal("external"),
        ])
        .optional(),
      selected_options: z.array(selectOptionSchema).optional(),
      options: z.array(selectOptionSchema).optional(),
      option_groups: z
        .array(
          z.object({
            label: z.string(),
            options: z.array(selectOptionSchema),
          })
        )
        .optional(),
      min_query_length: z.number().optional(),
    })
  ),
  submit_label: z.string().optional(),
  notify_on_cancel: z.boolean().optional(),
  state: z.string().optional(),
});

export const selectSchema = z.union([
  usersSelectSchema,
  staticSelectSchema,
  conversationsSelectSchema,
  channelsSelectSchema,
  externalSelectSchema,
]);

export const multiSelectSchema = z.union([
  multiUsersSelectSchema,
  multiStaticSelectSchema,
  multiConversationsSelectSchema,
  multiChannelsSelectSchema,
  multiExternalSelectSchema,
]);

export const actionsBlockSchema = blockSchema.extend({
  type: z.literal("actions"),
  elements: z.array(
    z.union([
      buttonSchema,
      overflowSchema,
      datepickerSchema,
      timepickerSchema,
      dateTimepickerSchema,
      selectSchema,
      radioButtonsSchema,
      checkboxesSchema,
      actionSchema,
    ])
  ),
});

export const sectionBlockSchema = blockSchema.extend({
  type: z.literal("section"),
  text: z.union([plainTextElementSchema, mrkdwnElementSchema]).optional(),
  fields: z
    .array(z.union([plainTextElementSchema, mrkdwnElementSchema]))
    .optional(),
  accessory: z
    .union([
      buttonSchema,
      overflowSchema,
      datepickerSchema,
      timepickerSchema,
      selectSchema,
      multiSelectSchema,
      actionSchema,
      imageElementSchema,
      radioButtonsSchema,
      checkboxesSchema,
    ])
    .optional(),
});

export const inputBlockSchema = blockSchema.extend({
  type: z.literal("input"),
  label: plainTextElementSchema,
  hint: plainTextElementSchema.optional(),
  optional: z.boolean().optional(),
  element: z.union([
    selectSchema,
    multiSelectSchema,
    datepickerSchema,
    timepickerSchema,
    dateTimepickerSchema,
    plainTextInputSchema,
    uRLInputSchema,
    emailInputSchema,
    numberInputSchema,
    radioButtonsSchema,
    checkboxesSchema,
  ]),
  dispatch_action: z.boolean().optional(),
});

export const messageMetadataSchema = z.object({
  event_type: z.string(),
  event_payload: z.record(
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      messageMetadataEventPayloadObjectSchema,
      z.array(messageMetadataEventPayloadObjectSchema),
    ])
  ),
});

export const attachmentActionSchema = z.object({
  id: z.string().optional(),
  confirm: confirmationSchema.optional(),
  data_source: z
    .union([
      z.literal("static"),
      z.literal("channels"),
      z.literal("conversations"),
      z.literal("users"),
      z.literal("external"),
    ])
    .optional(),
  min_query_length: z.number().optional(),
  name: z.string().optional(),
  options: z.array(optionFieldSchema).optional(),
  option_groups: z
    .array(
      z.object({
        text: z.string(),
        options: z.array(optionFieldSchema),
      })
    )
    .optional(),
  selected_options: z.array(optionFieldSchema).optional(),
  style: z
    .union([z.literal("default"), z.literal("primary"), z.literal("danger")])
    .optional(),
  text: z.string(),
  type: z.union([z.literal("button"), z.literal("select")]),
  value: z.string().optional(),
  url: z.string().optional(),
});

export const callUserSchema = z.union([
  callUserSlackSchema,
  callUserExternalSchema,
]);

export const knownBlockSchema = z.union([
  imageBlockSchema,
  contextBlockSchema,
  actionsBlockSchema,
  dividerBlockSchema,
  sectionBlockSchema,
  inputBlockSchema,
  fileBlockSchema,
  headerBlockSchema,
  videoBlockSchema,
]);

export const messageAttachmentSchema = z.object({
  blocks: z.array(z.union([knownBlockSchema, blockSchema])).optional(),
  fallback: z.string().optional(),
  color: z
    .union([
      z.literal("good"),
      z.literal("warning"),
      z.literal("danger"),
      z.string(),
    ])
    .optional(),
  pretext: z.string().optional(),
  author_name: z.string().optional(),
  author_link: z.string().optional(),
  author_icon: z.string().optional(),
  title: z.string().optional(),
  title_link: z.string().optional(),
  text: z.string().optional(),
  fields: z
    .array(
      z.object({
        title: z.string(),
        value: z.string(),
        short: z.boolean().optional(),
      })
    )
    .optional(),
  image_url: z.string().optional(),
  thumb_url: z.string().optional(),
  footer: z.string().optional(),
  footer_icon: z.string().optional(),
  ts: z.string().optional(),
  actions: z.array(attachmentActionSchema).optional(),
  callback_id: z.string().optional(),
  mrkdwn_in: z
    .array(
      z.union([z.literal("pretext"), z.literal("text"), z.literal("fields")])
    )
    .optional(),
  app_unfurl_url: z.string().optional(),
  is_app_unfurl: z.boolean().optional(),
  app_id: z.string().optional(),
  bot_id: z.string().optional(),
  preview: messageAttachmentPreviewSchema.optional(),
});

export const linkUnfurlsSchema = z.record(messageAttachmentSchema);

export const homeViewSchema = z.object({
  type: z.literal("home"),
  blocks: z.array(z.union([knownBlockSchema, blockSchema])),
  private_metadata: z.string().optional(),
  callback_id: z.string().optional(),
  external_id: z.string().optional(),
});

export const modalViewSchema = z.object({
  type: z.literal("modal"),
  title: plainTextElementSchema,
  blocks: z.array(z.union([knownBlockSchema, blockSchema])),
  close: plainTextElementSchema.optional(),
  submit: plainTextElementSchema.optional(),
  private_metadata: z.string().optional(),
  callback_id: z.string().optional(),
  clear_on_close: z.boolean().optional(),
  notify_on_close: z.boolean().optional(),
  external_id: z.string().optional(),
});

export const workflowStepViewSchema = z.object({
  type: z.literal("workflow_step"),
  blocks: z.array(z.union([knownBlockSchema, blockSchema])),
  private_metadata: z.string().optional(),
  callback_id: z.string().optional(),
  submit_disabled: z.boolean().optional(),
  external_id: z.string().optional(),
});

export const viewSchema: z.ZodUnion<
  [typeof homeViewSchema, typeof modalViewSchema, typeof workflowStepViewSchema]
> = z.union([homeViewSchema, modalViewSchema, workflowStepViewSchema]);
