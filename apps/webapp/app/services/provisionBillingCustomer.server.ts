import type {
  BillingController,
  BillingCustomerError,
  ProvisionBillingCustomerResult,
} from "@trigger.dev/billing";
import { tryCatch } from "@trigger.dev/core/utils";
import type { Result } from "neverthrow";
import { logger } from "~/services/logger.server";

const PROVISION_DEADLINE_MS = 20_000;
export const PROVISION_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 200;

const RETRYABLE_ERRORS: ReadonlySet<BillingCustomerError> = new Set<BillingCustomerError>([
  "upstream_unavailable",
  "internal",
]);

type NotConfiguredPolicy = "fail" | "skip";
const NOT_CONFIGURED_POLICY: NotConfiguredPolicy = "fail";

export type NewOrgProvisionDependencies = {
  enabled: boolean;
  controller: BillingController;
  deleteOrganization: (organizationId: string) => Promise<void>;
  now?: () => number;
  deadlineMs?: number;
  notConfiguredPolicy?: NotConfiguredPolicy;
};

type Budget = { deadlineAt: number; now: () => number; signal: AbortSignal };

type ProvisionAttempt = Result<ProvisionBillingCustomerResult, BillingCustomerError> | "aborted";

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();

    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function untilAborted<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T | "aborted"> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve("aborted");

    const abort = () => resolve("aborted");
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function provisionBillingCustomerForNewOrg(
  organizationId: string,
  deps: NewOrgProvisionDependencies
): Promise<void> {
  if (!deps.enabled) return;

  const error = await provisionOrError(organizationId, deps);
  if (!error) return;

  logger.error("Billing customer provisioning failed; rolling back organization creation", {
    organizationId,
    error,
  });

  const [deleteError] = await tryCatch(deps.deleteOrganization(organizationId));
  if (deleteError) {
    logger.error("Failed to delete organization after billing provisioning failed", {
      organizationId,
      error: deleteError instanceof Error ? deleteError.message : deleteError,
    });
  }

  throw new Error("Organization could not be created.");
}

async function provisionOrError(
  organizationId: string,
  deps: NewOrgProvisionDependencies
): Promise<BillingCustomerError | undefined> {
  const notConfiguredPolicy = deps.notConfiguredPolicy ?? NOT_CONFIGURED_POLICY;
  const now = deps.now ?? (() => performance.now());
  const deadlineMs = deps.deadlineMs ?? PROVISION_DEADLINE_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  const budget: Budget = { deadlineAt: now() + deadlineMs, now, signal: deadline.signal };

  try {
    const [loadError, usingPlugin] = await tryCatch(
      untilAborted(deps.controller.isUsingPlugin(), budget.signal)
    );
    if (loadError) return "internal";
    if (usingPlugin === "aborted") return "upstream_unavailable";
    if (!usingPlugin) return notConfigured(organizationId, notConfiguredPolicy);

    const error = await provisionWithRetry(organizationId, deps, budget);
    if (error === "not_configured") return notConfigured(organizationId, notConfiguredPolicy);
    return error;
  } finally {
    clearTimeout(timer);
  }
}

function notConfigured(
  organizationId: string,
  policy: NotConfiguredPolicy
): BillingCustomerError | undefined {
  if (policy === "fail") return "not_configured";

  logger.warn("Billing plugin is not usable; creating organization without a customer", {
    organizationId,
  });
  return undefined;
}

async function provisionWithRetry(
  organizationId: string,
  deps: NewOrgProvisionDependencies,
  { deadlineAt, now, signal }: Budget
): Promise<BillingCustomerError | undefined> {
  let lastError: BillingCustomerError = "internal";

  for (let attempt = 1; attempt <= PROVISION_MAX_ATTEMPTS; attempt++) {
    const [thrown, result] = await tryCatch<ProvisionAttempt>(
      untilAborted(deps.controller.provisionCustomer({ organizationId, signal }), signal)
    );

    if (thrown) {
      logger.error("Billing customer provisioning threw", {
        organizationId,
        error: thrown instanceof Error ? thrown.message : thrown,
      });
      lastError = "internal";
    } else if (result === "aborted") {
      return "upstream_unavailable";
    } else if (result.isOk()) {
      if (result.value.outcome !== "in_progress") return undefined;
      lastError = "internal";
    } else {
      if (!RETRYABLE_ERRORS.has(result.error)) return result.error;
      lastError = result.error;
    }

    const backoffMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    if (attempt === PROVISION_MAX_ATTEMPTS || signal.aborted) break;
    if (deadlineAt - now() <= backoffMs) break;
    await abortableSleep(backoffMs, signal);
  }

  return lastError;
}
