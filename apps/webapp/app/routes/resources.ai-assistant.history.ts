import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);

  const chats = await prisma.$queryRaw<{ id: string; title: string; updatedAt: Date }[]>`
    SELECT id, title, "updatedAt"
    FROM "AiChat"
    WHERE "userId" = ${userId}
      AND jsonb_typeof(messages) = 'array'
      AND jsonb_array_length(messages) > 0
    ORDER BY "updatedAt" DESC
    LIMIT 50
  `;

  return json({
    chats: chats.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt.toISOString(),
    })),
  });
};
