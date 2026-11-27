import type { RbacAbility } from "@trigger.dev/rbac";
import { prisma } from "~/db.server";
import { deletePlaygroundConversation } from "~/models/playgroundConversation.server";
import type { McpIdentity, McpPreviewRefusal, McpSubject } from "../gate/types";
import type { McpToolContext } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import { textResult } from "./define.server";
import { defineWriteTool, staleAnswer, staleApproval } from "./defineWrite.server";
import { plainError } from "./format/insights";
import { capText, untrusted } from "./format/logFields";
import { quoteForPreview } from "./format/webhooks";
import { startReadBudget } from "./readBudget.server";
import {
  DeletePlaygroundConversationInput,
  type DeletePlaygroundConversationInput as DeleteArgs,
} from "./schemas/sessions";

const READ_BUDGET_MS = 10_000;
const TEXT_CHARS = 200;
const STOPPED = {
  aborted: "The request was cancelled before the conversation was read; nothing changed.",
  timeout: "Reading the conversation took too long; nothing changed. Try again.",
};
type Read = ReturnType<typeof startReadBudget>["read"];
type Conversation = NonNullable<Awaited<ReturnType<typeof findConversation>>>;
type Scope = { environmentId: string; userId: string };

const notFound = (chatId: string) =>
  `No playground conversation of yours with chat id ${untrusted(chatId, "playground-chat-id", 256)} in this environment; list_playground_conversations lists them; nothing changed.`;

const quoted = (text: string) => quoteForPreview(capText(text, TEXT_CHARS));

function findConversation(scope: Scope, chatId: string) {
  return prisma.playgroundConversation.findFirst({
    where: { chatId, runtimeEnvironmentId: scope.environmentId, userId: scope.userId },
    select: {
      id: true,
      chatId: true,
      title: true,
      agentSlug: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

async function deletePlan(
  args: DeleteArgs,
  scope: Scope,
  read: Read
): Promise<{ preview: string; conversation: Conversation } | McpPreviewRefusal> {
  const found = await read(() => findConversation(scope, args.chatId));
  if (!found.ok) return { refuse: STOPPED[found.reason] };
  const conversation = found.value;
  if (!conversation) return { refuse: notFound(args.chatId) };

  const preview = [
    `Delete your playground conversation ${quoted(conversation.title)} with agent ${quoted(conversation.agentSlug)}, chat id ${quoted(conversation.chatId)}, created ${conversation.createdAt.toISOString()}.`,
    "This cannot be undone. It removes the conversation from the playground list with its title and the messages and client data saved with it.",
    "The session behind it, its runs and its saved transcript are kept.",
    `Conversation revision ${conversation.updatedAt.toISOString()}: if the conversation changes before this runs, it is refused.`,
  ].join("\n");
  return { preview, conversation };
}

async function preview(
  args: DeleteArgs,
  subject: McpSubject | null,
  _ability?: RbacAbility,
  identity?: McpIdentity
) {
  if (!subject?.projectId || !subject.environmentId || !identity) {
    return { refuse: "Environment not found" };
  }
  // The gate gives a preview no request signal, so only the deadline can stop its reads.
  const { read } = startReadBudget(READ_BUDGET_MS, new AbortController().signal);
  const plan = await deletePlan(
    args,
    { environmentId: subject.environmentId, userId: identity.userId },
    read
  );
  return "refuse" in plan ? plan : plan.preview;
}

async function run(args: DeleteArgs, ctx: McpToolContext) {
  const environmentId = ctx.subject?.projectId ? ctx.subject.environmentId : undefined;
  if (!environmentId) return plainError("Environment not found");

  const { read } = startReadBudget(READ_BUDGET_MS, ctx.signal);
  const scope = { environmentId, userId: ctx.identity.userId };
  const plan = await deletePlan(args, scope, read);
  if ("refuse" in plan) return plainError(plan.refuse);
  const stale = staleApproval(ctx, plan.preview, plainError);
  if (stale) return stale;

  const { conversation } = plan;
  const { count } = await deletePlaygroundConversation(
    { id: conversation.id, runtimeEnvironmentId: scope.environmentId, userId: scope.userId },
    conversation.updatedAt
  );
  if (count === 0) return staleAnswer(plainError);
  return textResult(
    `Deleted playground conversation ${untrusted(conversation.title, "playground-title", TEXT_CHARS)} (chat id ${untrusted(conversation.chatId, "playground-chat-id", 256)}).`
  );
}

export const playgroundWriteTools: McpToolDefinition[] = [
  defineWriteTool({
    name: "delete_playground_conversation",
    title: "Delete Playground Conversation",
    description:
      "Delete one of your own playground conversations, like the delete button in the agent's Playground conversation list. It removes the conversation and its saved messages from the playground; the session behind it and its runs are kept. It cannot be undone.",
    shape: DeletePlaygroundConversationInput.shape,
    approval: "required",
    auth: { action: "write", subject: "sessions" },
    confirm: { preview },
    run,
  }),
];
