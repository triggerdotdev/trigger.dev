import { z } from "zod";
import { knownBlockSchema, plainTextElementSchema } from "./blocks";

export * from "./interactivity";

export const PostMessageSuccessResponseSchema = z.object({
  ok: z.literal(true),
  channel: z.string(),
  ts: z.string(),
  message: z.object({
    text: z.string(),
    user: z.string().optional(),
    bot_id: z.string(),
    attachments: z.array(z.unknown()).optional(),
    type: z.string(),
    subtype: z.string().optional(),
    ts: z.string(),
  }),
});

export const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

export const PostMessageResponseSchema = z.discriminatedUnion("ok", [
  PostMessageSuccessResponseSchema,
  ErrorResponseSchema,
]);

export const PostMessageBodySchema = z.object({
  channel: z.string(),
  text: z.string(),
  blocks: z.array(knownBlockSchema).optional(),
  username: z.string().optional(),
  icon_emoji: z.string().optional(),
  icon_url: z.string().optional(),
  thread_ts: z.string().optional(),
});

export const ChannelNameOrIdSchema = z.union([
  z.object({ channelId: z.string() }),
  z.object({ channelName: z.string() }),
]);

export const PostMessageOptionsSchema = z
  .object({
    text: z.string(),
    blocks: z.array(knownBlockSchema).optional(),
    username: z.string().optional(),
    icon_emoji: z.string().optional(),
    icon_url: z.string().optional(),
    thread_ts: z.string().optional(),
  })
  .and(ChannelNameOrIdSchema);

export const AddReactionOptionsSchema = z
  .object({
    name: z.string(),
    timestamp: z.string(),
  })
  .and(ChannelNameOrIdSchema);

export const JoinConversationSuccessResponseSchema = z.object({
  ok: z.literal(true),
  channel: z.object({
    id: z.string(),
  }),
});

export const JoinConversationResponseSchema = z.discriminatedUnion("ok", [
  JoinConversationSuccessResponseSchema,
  ErrorResponseSchema,
]);

export const JoinConversationBodySchema = z.object({
  channel: z.string(),
});

export const ListConversationsSuccessResponseSchema = z.object({
  ok: z.literal(true),
  channels: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    })
  ),
});

export const ListConversationsResponseSchema = z.discriminatedUnion("ok", [
  ListConversationsSuccessResponseSchema,
  ErrorResponseSchema,
]);

export const PostMessageResponseOptionsSchema = z.object({
  text: z.string().optional(),
  blocks: z.array(knownBlockSchema).optional(),
  response_type: z.enum(["in_channel"]).optional(),
  replace_original: z.boolean().optional(),
  delete_original: z.boolean().optional(),
  thread_ts: z.string().optional(),
});

export const PostMessageResponseSuccessResponseSchema = z.object({
  ok: z.literal(true),
});

export const PostMessageResponseResponseSchema = z.discriminatedUnion("ok", [
  PostMessageResponseSuccessResponseSchema,
  ErrorResponseSchema,
]);

export const AddReactionSuccessResponseSchema = z.object({
  ok: z.literal(true),
});

export const AddReactionResponseSchema = z.discriminatedUnion("ok", [
  AddReactionSuccessResponseSchema,
  ErrorResponseSchema,
]);

export const ModalSchema = z.object({
  type: z.literal("modal"),
  title: plainTextElementSchema,
  blocks: z.array(knownBlockSchema),
  private_metadata: z.string().optional(),
  callback_id: z.string().optional(),
  close: plainTextElementSchema.optional(),
  submit: plainTextElementSchema.optional(),
  clear_on_close: z.boolean().optional(),
  notify_on_close: z.boolean().optional(),
  external_id: z.string().optional(),
  submit_disabled: z.boolean().optional(),
});

export const OpenViewBodySchema = z.object({
  trigger_id: z.string(),
  view: ModalSchema,
});

export const OpenViewSuccessResponseSchema = z.object({
  ok: z.literal(true),
  view: z.object({
    id: z.string(),
    team_id: z.string(),
    type: z.string(),
    private_metadata: z.string(),
    callback_id: z.string(),
  }),
});

export const OpenViewResponseSchema = z.discriminatedUnion("ok", [
  OpenViewSuccessResponseSchema,
  ErrorResponseSchema,
]);

export const UpdateViewBodySchema = z.object({
  view_id: z.string().optional(),
  hash: z.string().optional(),
  external_id: z.string().optional(),
  view: ModalSchema,
});
