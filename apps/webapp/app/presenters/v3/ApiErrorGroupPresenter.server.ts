import { type ErrorGroupDetail } from "@trigger.dev/core/v3";
import { ErrorId } from "@trigger.dev/core/v3/isomorphic";
import { type ErrorGroupStatus } from "@trigger.dev/database";
import { type ApiAuthenticationResultSuccess } from "~/services/apiAuth.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { sortVersionsDescending } from "~/utils/semver";
import { BasePresenter } from "./basePresenter.server";

/**
 * Resolves the friendly `error_<fingerprint>` id from the URL to the full error
 * group detail for the authenticated environment, or `undefined` if it doesn't
 * exist. Shared by the detail loader and the resolve/ignore/unresolve actions.
 */
export function findErrorGroupResource(
  authentication: ApiAuthenticationResultSuccess,
  errorId: string
): Promise<ErrorGroupDetail | undefined> {
  const fingerprint = ErrorId.toId(errorId);
  return new ApiErrorGroupPresenter().call(
    authentication.environment.organizationId,
    authentication.environment.project.id,
    authentication.environment.id,
    fingerprint
  );
}

const DB_STATUS_TO_API: Record<ErrorGroupStatus, ErrorGroupDetail["status"]> = {
  UNRESOLVED: "unresolved",
  RESOLVED: "resolved",
  IGNORED: "ignored",
};

function parseClickHouseDateTime(value: string): Date {
  const asNum = Number(value);
  if (!isNaN(asNum) && asNum > 1e12) {
    return new Date(asNum);
  }
  return new Date(value.replace(" ", "T") + "Z");
}

export class ApiErrorGroupPresenter extends BasePresenter {
  /**
   * Resolves a single error group to its API detail shape, or `undefined` if no
   * such fingerprint exists in the environment (the route turns that into 404).
   * Reuses the same ClickHouse query builders + `ErrorGroupState` reads the
   * dashboard presenter uses.
   */
  public async call(
    organizationId: string,
    projectId: string,
    environmentId: string,
    fingerprint: string
  ): Promise<ErrorGroupDetail | undefined> {
    return this.trace("call", async () => {
      const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
        organizationId,
        "logs"
      );

      const summary = await this.getSummary(
        clickhouse,
        organizationId,
        projectId,
        environmentId,
        fingerprint
      );

      if (!summary) {
        return undefined;
      }

      const [affectedVersions, state] = await Promise.all([
        this.getAffectedVersions(clickhouse, organizationId, projectId, environmentId, fingerprint),
        this.getState(environmentId, summary.taskIdentifier, fingerprint),
      ]);

      return {
        id: ErrorId.toFriendlyId(fingerprint),
        fingerprint,
        taskIdentifier: summary.taskIdentifier,
        errorType: summary.errorType,
        errorMessage: summary.errorMessage,
        count: summary.count,
        firstSeen: summary.firstSeen,
        lastSeen: summary.lastSeen,
        affectedVersions,
        status: state ? DB_STATUS_TO_API[state.status] : "unresolved",
        resolvedAt: state?.resolvedAt ?? null,
        resolvedInVersion: state?.resolvedInVersion ?? null,
        resolvedBy: state?.resolvedBy ?? null,
        ignoredAt: state?.ignoredAt ?? null,
        ignoredUntil: state?.ignoredUntil ?? null,
        ignoredReason: state?.ignoredReason ?? null,
        ignoredByUserId: state?.ignoredByUserId ?? null,
        ignoredUntilOccurrenceRate: state?.ignoredUntilOccurrenceRate ?? null,
        ignoredUntilTotalOccurrences: state?.ignoredUntilTotalOccurrences ?? null,
      };
    });
  }

  private async getSummary(
    clickhouse: Awaited<ReturnType<typeof clickhouseFactory.getClickhouseForOrganization>>,
    organizationId: string,
    projectId: string,
    environmentId: string,
    fingerprint: string
  ): Promise<
    | {
        taskIdentifier: string;
        errorType: string;
        errorMessage: string;
        count: number;
        firstSeen: Date;
        lastSeen: Date;
      }
    | undefined
  > {
    const queryBuilder = clickhouse.errors.listQueryBuilder();

    queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
    queryBuilder.where("error_fingerprint = {fingerprint: String}", { fingerprint });
    queryBuilder.groupBy("error_fingerprint, task_identifier");
    queryBuilder.limit(1);

    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    if (!records || records.length === 0) {
      return undefined;
    }

    const record = records[0];
    return {
      taskIdentifier: record.task_identifier,
      errorType: record.error_type,
      errorMessage: record.error_message,
      count: record.occurrence_count,
      firstSeen: parseClickHouseDateTime(record.first_seen),
      lastSeen: parseClickHouseDateTime(record.last_seen),
    };
  }

  private async getAffectedVersions(
    clickhouse: Awaited<ReturnType<typeof clickhouseFactory.getClickhouseForOrganization>>,
    organizationId: string,
    projectId: string,
    environmentId: string,
    fingerprint: string
  ): Promise<string[]> {
    const queryBuilder = clickhouse.errors.affectedVersionsQueryBuilder();

    queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
    queryBuilder.where("error_fingerprint = {fingerprint: String}", { fingerprint });
    queryBuilder.where("task_version != ''");
    queryBuilder.limit(100);

    const [queryError, records] = await queryBuilder.execute();

    if (queryError || !records) {
      return [];
    }

    const versions = records.map((r) => r.task_version).filter((v) => v.length > 0);
    return sortVersionsDescending(versions).slice(0, 5);
  }

  private async getState(
    environmentId: string,
    taskIdentifier: string,
    fingerprint: string
  ): Promise<{
    status: ErrorGroupStatus;
    resolvedAt: Date | null;
    resolvedInVersion: string | null;
    resolvedBy: string | null;
    ignoredAt: Date | null;
    ignoredUntil: Date | null;
    ignoredReason: string | null;
    ignoredByUserId: string | null;
    ignoredUntilOccurrenceRate: number | null;
    ignoredUntilTotalOccurrences: number | null;
  } | null> {
    const row = await this._replica.errorGroupState.findFirst({
      where: {
        environmentId,
        taskIdentifier,
        errorFingerprint: fingerprint,
      },
      select: {
        status: true,
        resolvedAt: true,
        resolvedInVersion: true,
        resolvedBy: true,
        ignoredAt: true,
        ignoredUntil: true,
        ignoredReason: true,
        ignoredByUserId: true,
        ignoredUntilOccurrenceRate: true,
        ignoredUntilTotalOccurrences: true,
      },
    });

    if (!row) {
      return null;
    }

    return {
      status: row.status,
      resolvedAt: row.resolvedAt,
      resolvedInVersion: row.resolvedInVersion,
      resolvedBy: row.resolvedBy,
      ignoredAt: row.ignoredAt,
      ignoredUntil: row.ignoredUntil,
      ignoredReason: row.ignoredReason,
      ignoredByUserId: row.ignoredByUserId,
      ignoredUntilOccurrenceRate: row.ignoredUntilOccurrenceRate,
      ignoredUntilTotalOccurrences: row.ignoredUntilTotalOccurrences,
    };
  }
}
