import type {
  BillingController,
  BillingMonthlyUsage,
  BillingProjectUsage,
  BillingUsageError,
} from "@trigger.dev/billing";
import { tryCatch } from "@trigger.dev/core/utils";
import type { ResultAsync } from "neverthrow";
import { logger } from "~/services/logger.server";

type BillingUsageResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BillingUsageError; retryable: boolean };

export type BillingUsageProject = {
  id: string;
  name: string;
  slug: string;
  externalRef: string;
  deleted: boolean;
};

type BillingOrganizationProjectUsage = BillingProjectUsage & {
  projects: BillingUsageProject[];
};

export type BillingUsageService = {
  getMonthlyUsage(
    organizationId: string,
    month: string
  ): Promise<BillingUsageResult<BillingMonthlyUsage>>;
  getProjectUsage(
    organizationId: string,
    month: string
  ): Promise<BillingUsageResult<BillingOrganizationProjectUsage>>;
};

export type FindBillingUsageProjects = (
  organizationId: string,
  projectIds: string[]
) => Promise<BillingUsageProject[]>;

export type BillingUsageDependencies = {
  enabled: boolean;
  controller: Pick<BillingController, "getMonthlyUsage" | "getProjectUsage">;
  findProjects: FindBillingUsageProjects;
};

const RETRYABLE_ERRORS: ReadonlySet<BillingUsageError> = new Set<BillingUsageError>([
  "rate_limited",
  "upstream_unavailable",
]);

function failure<T>(error: BillingUsageError): BillingUsageResult<T> {
  return { ok: false, error, retryable: RETRYABLE_ERRORS.has(error) };
}

function settle<T>(result: ResultAsync<T, BillingUsageError>): Promise<BillingUsageResult<T>> {
  return result.match(
    (value): BillingUsageResult<T> => ({ ok: true, value }),
    (error) => failure<T>(error)
  );
}

async function lookUpProjects(
  organizationId: string,
  projectIds: string[],
  findProjects: FindBillingUsageProjects
): Promise<BillingUsageProject[]> {
  if (projectIds.length === 0) return [];

  const [error, projects] = await tryCatch(findProjects(organizationId, projectIds));
  if (error) {
    logger.error("Billing usage project lookup failed", { organizationId, error: error.message });
    return [];
  }
  return projects;
}

export function createBillingUsageService(deps: BillingUsageDependencies): BillingUsageService {
  return {
    async getMonthlyUsage(organizationId, month) {
      if (!deps.enabled) return failure("feature_disabled");
      return settle(deps.controller.getMonthlyUsage({ organizationId, month }));
    },
    async getProjectUsage(organizationId, month) {
      if (!deps.enabled) return failure("feature_disabled");
      const usage = await settle(deps.controller.getProjectUsage({ organizationId, month }));
      if (!usage.ok) return usage;
      const projects = await lookUpProjects(
        organizationId,
        usage.value.projectIds,
        deps.findProjects
      );
      return { ok: true, value: { ...usage.value, projects } };
    },
  };
}
