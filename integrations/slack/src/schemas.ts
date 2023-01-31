import { z } from "zod";
import { knownBlockSchema } from "./blocks";
import { blockAction } from "./interactivity";

export { blockAction };

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
