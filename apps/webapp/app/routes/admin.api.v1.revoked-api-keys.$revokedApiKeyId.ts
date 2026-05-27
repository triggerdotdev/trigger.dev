import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";

const ParamsSchema = z.object({
  revokedApiKeyId: z.string(),
});

const RequestBodySchema = z.object({
  expiresAt: z.coerce.date(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const { revokedApiKeyId } = ParamsSchema.parse(params);

  const rawBody = await request.json();
  const parsedBody = RequestBodySchema.safeParse(rawBody);

  if (!parsedBody.success) {
    return json({ error: "Invalid request body", issues: parsedBody.error.issues }, { status: 400 });
  }

  const existing = await prisma.revokedApiKey.findFirst({
    where: { id: revokedApiKeyId },
    select: { id: true },
  });

  if (!existing) {
    return json({ error: "Revoked API key not found" }, { status: 404 });
  }

  const updated = await prisma.revokedApiKey.update({
    where: { id: revokedApiKeyId },
    data: { expiresAt: parsedBody.data.expiresAt },
  });

  return json({
    success: true,
    revokedApiKey: {
      id: updated.id,
      runtimeEnvironmentId: updated.runtimeEnvironmentId,
      expiresAt: updated.expiresAt.toISOString(),
    },
  });
}
