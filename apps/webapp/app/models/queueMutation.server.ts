import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { getUserById } from "~/models/user.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { concurrencySystem } from "~/v3/services/concurrencySystemInstance.server";
import {
  isValidQueueOverridePercent,
  MAX_QUEUE_OVERRIDE_PERCENT,
  MIN_QUEUE_OVERRIDE_PERCENT,
} from "~/v3/services/concurrencySystem.server";
import { PauseQueueService } from "~/v3/services/pauseQueue.server";

/**
 * Handles the per-queue mutating form actions (pause/resume/override/remove-override) shared by the
 * Queues list route and the queue detail route. Returns a redirect Response for one of those four
 * actions, or `null` if `formData`'s `action` isn't one of them (so the caller can fall through to
 * its own action handling). `redirectPath` is where to send the user afterwards — the caller passes
 * its own page so a mutation from the detail page stays on the detail page.
 */
export async function handleQueueMutationAction({
  request,
  environment,
  userId,
  formData,
  redirectPath,
}: {
  request: Request;
  environment: AuthenticatedEnvironment;
  userId: string;
  formData: FormData;
  redirectPath: string;
}): Promise<Response | null> {
  const action = formData.get("action");

  switch (action) {
    case "queue-pause":
    case "queue-resume": {
      const friendlyId = formData.get("friendlyId");
      if (!friendlyId) {
        return redirectWithErrorMessage(redirectPath, request, "Queue ID is required");
      }

      const queueService = new PauseQueueService();
      const result = await queueService.call(
        environment,
        friendlyId.toString(),
        action === "queue-pause" ? "paused" : "resumed"
      );

      if (!result.success) {
        return redirectWithErrorMessage(
          redirectPath,
          request,
          result.error ?? `Failed to ${action === "queue-pause" ? "pause" : "resume"} queue`
        );
      }

      return redirectWithSuccessMessage(
        redirectPath,
        request,
        `Queue ${action === "queue-pause" ? "paused" : "resumed"}`
      );
    }
    case "queue-override": {
      const friendlyId = formData.get("friendlyId");
      const mode = formData.get("mode") === "percent" ? "percent" : "absolute";

      if (!friendlyId) {
        return redirectWithErrorMessage(redirectPath, request, "Queue ID is required");
      }

      // The dialog submits either a `percent` of the environment limit or an absolute `limit`,
      // depending on the unit toggle. Build the matching override shape for the service.
      let override: number | { limit: number } | { percent: number };
      if (mode === "percent") {
        const percentValue = formData.get("percent");
        if (!percentValue) {
          return redirectWithErrorMessage(redirectPath, request, "Percentage is required");
        }
        const percentNumber = Number(percentValue.toString());
        if (!isValidQueueOverridePercent(percentNumber)) {
          return redirectWithErrorMessage(
            redirectPath,
            request,
            `Percentage must be greater than ${MIN_QUEUE_OVERRIDE_PERCENT} and less than or equal to ${MAX_QUEUE_OVERRIDE_PERCENT}`
          );
        }
        override = { percent: percentNumber };
      } else {
        const concurrencyLimit = formData.get("concurrencyLimit");
        if (!concurrencyLimit) {
          return redirectWithErrorMessage(redirectPath, request, "Concurrency limit is required");
        }
        const limitNumber = parseInt(concurrencyLimit.toString(), 10);
        if (isNaN(limitNumber) || limitNumber < 0) {
          return redirectWithErrorMessage(
            redirectPath,
            request,
            "Concurrency limit must be a valid number"
          );
        }
        override = { limit: limitNumber };
      }

      const user = await getUserById(userId);
      if (!user) {
        return redirectWithErrorMessage(redirectPath, request, "User not found");
      }

      const result = await concurrencySystem.queues.overrideQueueConcurrencyLimit(
        environment,
        friendlyId.toString(),
        override,
        user
      );

      if (!result.isOk()) {
        // Surface the service's specific message (e.g. the above-cap rejection) instead of a
        // generic failure so the user learns why the override was refused.
        const error = result.error;
        const message =
          "message" in error && typeof error.message === "string"
            ? error.message
            : "Failed to override queue concurrency limit";
        return redirectWithErrorMessage(redirectPath, request, message);
      }

      return redirectWithSuccessMessage(
        redirectPath,
        request,
        "Queue concurrency limit overridden"
      );
    }
    case "queue-remove-override": {
      const friendlyId = formData.get("friendlyId");

      if (!friendlyId) {
        return redirectWithErrorMessage(redirectPath, request, "Queue ID is required");
      }

      const result = await concurrencySystem.queues.resetConcurrencyLimit(
        environment,
        friendlyId.toString()
      );

      if (!result.isOk()) {
        return redirectWithErrorMessage(
          redirectPath,
          request,
          "Failed to reset queue concurrency limit"
        );
      }

      return redirectWithSuccessMessage(redirectPath, request, "Queue concurrency limit reset");
    }
    default:
      return null;
  }
}
