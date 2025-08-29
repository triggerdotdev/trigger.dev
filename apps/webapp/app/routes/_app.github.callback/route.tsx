import { type LoaderFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { validateGitHubAppInstallSession } from "~/services/gitHubSession.server";
import { linkGitHubAppInstallation } from "~/services/gitHub.server";
import { logger } from "~/services/logger.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { tryCatch } from "@trigger.dev/core";

const QuerySchema = z.object({
  installation_id: z.coerce.number(),
  setup_action: z.enum(["install", "update", "request"]),
  state: z.string(),
});

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

  const { installation_id, setup_action, state } = result.data;

  const sessionResult = await validateGitHubAppInstallSession(cookieHeader, state);

  if (!sessionResult.valid) {
    logger.error("GitHub App callback with invalid session", {
      state,
      installation_id,
      error: sessionResult.error,
    });

    return redirectWithErrorMessage("/", request, "Failed to install GitHub App");
  }

  const { organizationId, redirectTo } = sessionResult;

  switch (setup_action) {
    case "install":
    case "update": {
      const [error] = await tryCatch(linkGitHubAppInstallation(installation_id, organizationId));

      if (error) {
        logger.error("Failed to link GitHub App installation", {
          error,
        });
        return redirectWithErrorMessage(redirectTo, request, "Failed to install GitHub App");
      }

      return redirectWithSuccessMessage(redirectTo, request, "GitHub App installed successfully");
    }

    case "request": {
      // This happens when a non-admin user requests installation
      // The installation_id won't be available until an admin approves
      logger.info("GitHub App installation requested, awaiting approval", {
        state,
      });

      return redirectWithSuccessMessage(redirectTo, request, "GitHub App installation requested");
    }

    default:
      setup_action satisfies never;
      return redirectWithErrorMessage(redirectTo, request, "Failed to install GitHub App");
  }
}
