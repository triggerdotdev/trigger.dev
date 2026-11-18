import { withAdminApi } from "~/services/adminApi.server";
import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import { updateCredentialGrace } from "~/services/credentialFingerprints.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";

const ParamsSchema = z.object({
  revokedApiKeyId: z.string(),
});

const RequestBodySchema = z.object({
  expiresAt: z.coerce.date(),
});

async function handleAction({ request, params }: ActionFunctionArgs) {
  const admin = await requireAdminApiRequest(request);

  const { revokedApiKeyId } = ParamsSchema.parse(params);

  const rawBody = await request.json();
  const parsedBody = RequestBodySchema.safeParse(rawBody);

  if (!parsedBody.success) {
    return json(
      { error: "Invalid request body", issues: parsedBody.error.issues },
      { status: 400 }
    );
  }

  const existing = await prisma.revokedApiKey.findFirst({
    where: { id: revokedApiKeyId },
    select: { id: true, expiresAt: true },
  });

  if (!existing) {
    return json({ error: "Revoked API key not found" }, { status: 404 });
  }

  const updated = await prisma.revokedApiKey.update({
    where: { id: revokedApiKeyId },
    data: { expiresAt: parsedBody.data.expiresAt },
  });

  // Only moves the grace period: who revoked the key, when and why stay as first recorded.
  updateCredentialGrace(updated.apiKey, updated.expiresAt);
  // Shown to the customer as Trigger.dev support; the staff member is kept internally. The
  // environment is read only to describe the event: in the background, and not while recording is
  // off.
  if (existing.expiresAt.getTime() !== updated.expiresAt.getTime()) {
    auditLogs.recordLater(async () => {
      const environment = await prisma.runtimeEnvironment.findFirst({
        where: { id: updated.runtimeEnvironmentId },
        select: { id: true, type: true, organizationId: true, projectId: true },
      });
      if (!environment) return null;
      return {
        category: "credentials",
        action: "api_key.grace_extended",
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        environmentType: environment.type,
        target: { type: "root_api_key", id: environment.id, name: null },
        keyLast4s: [updated.apiKey.slice(-4)],
        changes: {
          graceUntil: {
            before: existing.expiresAt.toISOString(),
            after: updated.expiresAt.toISOString(),
          },
        },
        actor: { type: "support", id: null },
        source: "staff",
        onBehalfOf: { userId: admin.id },
      };
    });
  }

  return json({
    success: true,
    revokedApiKey: {
      id: updated.id,
      runtimeEnvironmentId: updated.runtimeEnvironmentId,
      expiresAt: updated.expiresAt.toISOString(),
    },
  });
}

export const action = withAdminApi(handleAction);
