import { type LoaderFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { validateGitHubAppInstallSession } from "~/services/gitHubSession.server";
import { linkGitHubAppInstallation, updateGitHubAppInstallation } from "~/services/gitHub.server";
import { logger } from "~/services/logger.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { tryCatch } from "@trigger.dev/core";
import { $replica } from "~/db.server";
import { requireUser } from "~/services/session.server";
import { sanitizeRedirectPath } from "~/utils";

const QuerySchema = z.discriminatedUnion("setup_action", [
  z.object({
    setup_action: z.literal("install"),
    installation_id: z.coerce.number(),
    state: z.string(),
  }),
  z.object({
    setup_action: z.literal("update"),
    installation_id: z.coerce.number(),
    state: z.string(),
  }),
  z.object({
    setup_action: z.literal("request"),
    state: z.string(),
  }),
]);

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const queryParams = Object.fromEntries(url.searchParams);
  const cookieHeader = request.headers.get("Cookie");

  const result = QuerySchema.safeParse(queryParams);

  if (!result.success) {
    logger.warn("GitHub App callback with invalid params", {
      queryParams,
    });
    return redirectWithErrorMessage("/", request, "Failed to install GitHub App");
  }

  const callbackData = result.data;

  const sessionResult = await validateGitHubAppInstallSession(cookieHeader, callbackData.state);

  if (!sessionResult.valid) {
    logger.error("GitHub App callback with invalid session", {
      callbackData,
      error: sessionResult.error,
    });

    return redirectWithErrorMessage("/", request, "Failed to install GitHub App");
  }

  const { organizationId, redirectTo: unsafeRedirectTo } = sessionResult;
  const redirectTo = sanitizeRedirectPath(unsafeRedirectTo);

  const user = await requireUser(request);
  const org = await $replica.organization.findFirst({
    where: { id: organizationId, members: { some: { userId: user.id } }, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
    },
  });

  if (!org) {
    // the secure cookie approach should already protect against this
    // just an additional check
    logger.error("GitHub app installation attempt on unauthenticated org", {
      userId: user.id,
      organizationId,
    });
    return redirectWithErrorMessage(redirectTo, request, "Failed to install GitHub App");
  }

  switch (callbackData.setup_action) {
    case "install": {
      const [error] = await tryCatch(
        linkGitHubAppInstallation(callbackData.installation_id, organizationId)
      );

      if (error) {
        logger.error("Failed to link GitHub App installation", {
          error,
        });
        return redirectWithErrorMessage(redirectTo, request, "Failed to install GitHub App");
      }

      return redirectWithSuccessMessage(redirectTo, request, "GitHub App installed successfully");
    }

    case "update": {
      const [error] = await tryCatch(updateGitHubAppInstallation(callbackData.installation_id));

      if (error) {
        logger.error("Failed to update GitHub App installation", {
          error,
        });
        return redirectWithErrorMessage(redirectTo, request, "Failed to update GitHub App");
      }

      return redirectWithSuccessMessage(redirectTo, request, "GitHub App updated successfully");
    }

    case "request": {
      // This happens when a non-admin user requests installation
      // The installation_id won't be available until an admin approves
      logger.info("GitHub App installation requested, awaiting approval", {
        callbackData,
      });

      return redirectWithSuccessMessage(redirectTo, request, "GitHub App installation requested");
    }

    default:
      callbackData satisfies never;
      return redirectWithErrorMessage(redirectTo, request, "Failed to install GitHub App");
  }
}
