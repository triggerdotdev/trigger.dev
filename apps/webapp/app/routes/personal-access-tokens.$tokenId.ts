import { ActionFunction } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  jsonWithErrorMessage,
  jsonWithSuccessMessage,
  redirectWithSuccessMessage,
} from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";

const ParamSchema = z.object({
  tokenId: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const { tokenId } = ParamSchema.parse(params);
  const userId = await requireUserId(request);

  const token = await prisma.personalAccessToken.findFirst({
    where: {
      id: tokenId,
      userId: userId
    },
  });

  if (!token) {
    return jsonWithErrorMessage({ ok: false }, request, `Token doesn't exist.`);
  }

  try {
    await prisma.personalAccessToken.update({
      where: {
        id: tokenId,
      },
      data: {
        revokedAt: new Date()
      }
    })

    const url = new URL(request.url);
    const redirectTo = url.searchParams.get("redirectTo");

    logger.debug("Token revoked", {
      url,
      redirectTo,
      job: token,
    });

    if (typeof redirectTo === "string" && redirectTo.length > 0) {
      return redirectWithSuccessMessage(
        redirectTo,
        request,
        `Token has been revoked.`
      );
    }

    return jsonWithSuccessMessage(
      { ok: true },
      request,
      `Token has been revoked.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return jsonWithErrorMessage(
      { ok: false },
      request,
      `Token could not be revoked: ${message}`
    );
  }
};
