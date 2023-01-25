import { z } from "zod";
import { knownBlockSchema } from "./blocks";

export const PostMessageSuccessResponseSchema = z.object({
  ok: z.literal(true),
  channel: z.string(),
  ts: z.string(),
  message: z.object({
    text: z.string(),
    user: z.string(),
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
  iconEmoji: z.string().optional(),
  iconUrl: z.string().optional(),
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
    iconEmoji: z.string().optional(),
    iconUrl: z.string().optional(),
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
