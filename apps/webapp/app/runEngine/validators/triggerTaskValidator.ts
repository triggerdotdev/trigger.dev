import { MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import { logger } from "~/services/logger.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { MAX_ATTEMPTS, OutOfEntitlementError } from "~/v3/services/triggerTask.server";
import { isFinalRunStatus } from "~/v3/taskStatus";
import { EngineServiceValidationError } from "../concerns/errors";
import {
  EntitlementValidationParams,
  MaxAttemptsValidationParams,
  ParentRunValidationParams,
  TagValidationParams,
  TriggerTaskValidator,
  ValidationResult,
} from "../types";

export class DefaultTriggerTaskValidator implements TriggerTaskValidator {
  validateTags(params: TagValidationParams): ValidationResult {
    const { tags } = params;

    if (!tags) {
      return { ok: true };
    }

    if (typeof tags === "string") {
      return { ok: true };
    }

    if (tags.length > MAX_TAGS_PER_RUN) {
      return {
        ok: false,
        error: new EngineServiceValidationError(
          `Runs can only have ${MAX_TAGS_PER_RUN} tags, you're trying to set ${tags.length}.`
        ),
      };
    }

    return { ok: true };
  }

  async validateEntitlement(params: EntitlementValidationParams): Promise<ValidationResult> {
    const { environment } = params;

    if (environment.type === "DEVELOPMENT") {
      return { ok: true };
    }

    const result = await getEntitlement(environment.organizationId);

    if (!result || result.hasAccess === false) {
      return {
        ok: false,
        error: new OutOfEntitlementError(),
      };
    }

    return { ok: true };
  }

  validateMaxAttempts(params: MaxAttemptsValidationParams): ValidationResult {
    const { taskId, attempt } = params;

    if (attempt > MAX_ATTEMPTS) {
      return {
        ok: false,
        error: new EngineServiceValidationError(
          `Failed to trigger ${taskId} after ${MAX_ATTEMPTS} attempts.`
        ),
      };
    }

    return { ok: true };
  }

  validateParentRun(params: ParentRunValidationParams): ValidationResult {
    const { taskId, parentRun, resumeParentOnCompletion } = params;

    // If there's no parent run specified, that's fine
    if (!parentRun) {
      return { ok: true };
    }

    // If we're not resuming the parent, we don't need to validate its status
    if (!resumeParentOnCompletion) {
      return { ok: true };
    }

    // Check if the parent run is in a final state
    if (isFinalRunStatus(parentRun.status)) {
      logger.debug("Parent run is in a terminal state", {
        parentRun,
      });

      return {
        ok: false,
        error: new EngineServiceValidationError(
          `Cannot trigger ${taskId} as the parent run has a status of ${parentRun.status}`
        ),
      };
    }

    return { ok: true };
  }
}
