import { chatMessages, chats, type DashboardAgentDb } from "@internal/dashboard-agent-db";
import type { TranscriptStorage } from "@trigger.dev/sdk/ai";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { UIMessage } from "ai";

export type DashboardAgentTranscriptClientData = {
  organizationId: string;
  userId: string;
};

/**
 * The dashboard agent's transcript as a `TranscriptStorage`: one row per
 * message in `chat_messages`, the runtime's state and cursors on the chat row.
 *
 * This is the real-schema conformance target for the storage contract. The
 * agent itself still persists through its hooks; moving it onto `storage` is
 * separate work.
 */
export function dashboardAgentTranscriptStorage(
  db: DashboardAgentDb
): TranscriptStorage<DashboardAgentTranscriptClientData> {
  return {
    async load(scope, opts) {
      const chat = await db
        .select({ state: chats.transcriptState, cursors: chats.transcriptCursors })
        .from(chats)
        .where(and(eq(chats.id, scope.chatId), isNull(chats.deletedAt)))
        .limit(1);
      const row = chat[0];
      if (!row) return { messages: [], state: null };

      const conditions = [eq(chatMessages.chatId, scope.chatId)];
      if (opts?.before !== undefined) {
        const anchor = await positionOf(db, scope.chatId, opts.before);
        if (anchor !== undefined) conditions.push(lt(chatMessages.position, anchor));
      }

      let rows: { messageId: string; message: unknown }[];
      let nextCursor: string | undefined;
      if (opts?.limit !== undefined) {
        const newestFirst = await db
          .select({ messageId: chatMessages.messageId, message: chatMessages.message })
          .from(chatMessages)
          .where(and(...conditions))
          .orderBy(desc(chatMessages.position))
          .limit(opts.limit + 1);
        const hasMore = newestFirst.length > opts.limit;
        rows = newestFirst.slice(0, opts.limit).reverse();
        nextCursor = hasMore ? rows[0]?.messageId : undefined;
      } else {
        rows = await db
          .select({ messageId: chatMessages.messageId, message: chatMessages.message })
          .from(chatMessages)
          .where(and(...conditions))
          .orderBy(asc(chatMessages.position));
      }

      return {
        messages: rows.map((r) => r.message as UIMessage) as never,
        state: row.state ?? null,
        cursors: row.cursors ?? undefined,
        nextCursor,
      };
    },

    async save(ctx, changeset) {
      await db.transaction(async (tx) => {
        await tx
          .insert(chats)
          .values({
            id: ctx.chatId,
            organizationId: ctx.clientData.organizationId,
            userId: ctx.clientData.userId,
          })
          .onConflictDoNothing();
        await tx.select({ id: chats.id }).from(chats).where(eq(chats.id, ctx.chatId)).for("update");

        for (const change of changeset.changes) {
          switch (change.op) {
            case "put": {
              const message = change.message;
              const updated = await tx
                .update(chatMessages)
                .set({ message, role: message.role })
                .where(
                  and(eq(chatMessages.chatId, ctx.chatId), eq(chatMessages.messageId, message.id))
                )
                .returning({ messageId: chatMessages.messageId });
              if (updated.length > 0) break;
              const reserved = await tx
                .update(chats)
                .set({
                  nextMessagePosition: sql`${chats.nextMessagePosition} + 1`,
                  lastMessageAt: sql`now()`,
                  updatedAt: sql`now()`,
                })
                .where(eq(chats.id, ctx.chatId))
                .returning({ next: chats.nextMessagePosition });
              const position = reserved[0]!.next - 1;
              await tx.insert(chatMessages).values({
                chatId: ctx.chatId,
                messageId: message.id,
                position,
                role: message.role,
                message,
              });
              break;
            }
            case "remove": {
              await tx
                .delete(chatMessages)
                .where(
                  and(eq(chatMessages.chatId, ctx.chatId), eq(chatMessages.messageId, change.id))
                );
              break;
            }
            case "truncateAfter": {
              const anchor = await positionOf(tx, ctx.chatId, change.afterId);
              if (anchor === undefined) break;
              await tx
                .delete(chatMessages)
                .where(and(eq(chatMessages.chatId, ctx.chatId), gt(chatMessages.position, anchor)));
              break;
            }
            case "state": {
              await tx
                .update(chats)
                .set({ transcriptState: change.value ?? null, updatedAt: sql`now()` })
                .where(eq(chats.id, ctx.chatId));
              break;
            }
          }
        }

        if (changeset.cursors) {
          await tx
            .update(chats)
            .set({ transcriptCursors: changeset.cursors, updatedAt: sql`now()` })
            .where(eq(chats.id, ctx.chatId));
        }
      });
    },
  };
}

async function positionOf(
  db: Pick<DashboardAgentDb, "select">,
  chatId: string,
  messageId: string
): Promise<number | undefined> {
  const rows = await db
    .select({ position: chatMessages.position })
    .from(chatMessages)
    .where(and(eq(chatMessages.chatId, chatId), inArray(chatMessages.messageId, [messageId])))
    .limit(1);
  return rows[0]?.position;
}
