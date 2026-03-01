import { z } from "zod";
import { type ClickHouse } from "@internal/clickhouse";
import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { type Direction } from "~/components/ListPagination";
import { findDisplayableEnvironment } from "~/models/runtimeEnvironment.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { BasePresenter } from "~/presenters/v3/basePresenter.server";

export type ErrorGroupOptions = {
  userId?: string;
  projectId: string;
  fingerprint: string;
  // pagination
  direction?: Direction;
  cursor?: string;
  pageSize?: number;
};

export const ErrorGroupOptionsSchema = z.object({
  userId: z.string().optional(),
  projectId: z.string(),
  fingerprint: z.string(),
  direction: z.enum(["forward", "backward"]).optional(),
  cursor: z.string().optional(),
  pageSize: z.number().int().positive().max(1000).optional(),
});

const DEFAULT_PAGE_SIZE = 50;

export type ErrorGroupDetail = Awaited<ReturnType<ErrorGroupPresenter["call"]>>;
export type ErrorInstance = ErrorGroupDetail["instances"][0];

// Cursor for error instances pagination
type ErrorInstanceCursor = {
  createdAt: string;
  runId: string;
};

const ErrorInstanceCursorSchema = z.object({
  createdAt: z.string(),
  runId: z.string(),
});

function encodeCursor(cursor: ErrorInstanceCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64");
}

function decodeCursor(cursor: string): ErrorInstanceCursor | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    const validated = ErrorInstanceCursorSchema.safeParse(parsed);
    if (!validated.success) {
      return null;
    }
    return validated.data as ErrorInstanceCursor;
  } catch {
    return null;
  }
}

export class ErrorGroupPresenter extends BasePresenter {
  constructor(
    private readonly replica: PrismaClientOrTransaction,
    private readonly clickhouse: ClickHouse
  ) {
    super(undefined, replica);
  }

  public async call(
    organizationId: string,
    environmentId: string,
    {
      userId,
      projectId,
      fingerprint,
      cursor,
      pageSize = DEFAULT_PAGE_SIZE,
    }: ErrorGroupOptions
  ) {
    const displayableEnvironment = await findDisplayableEnvironment(environmentId, userId);

    if (!displayableEnvironment) {
      throw new ServiceValidationError("No environment found");
    }

    // Use the error instances query builder
    const queryBuilder = this.clickhouse.errors.instancesQueryBuilder();

    // Apply filters
    queryBuilder.where("organization_id = {organizationId: String}", { organizationId });
    queryBuilder.where("project_id = {projectId: String}", { projectId });
    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
    queryBuilder.where("error_fingerprint = {errorFingerprint: String}", {
      errorFingerprint: fingerprint,
    });
    queryBuilder.where("_is_deleted = 0");

    // Cursor-based pagination
    const decodedCursor = cursor ? decodeCursor(cursor) : null;
    if (decodedCursor) {
      queryBuilder.where(
        `(created_at < {cursorCreatedAt: String} OR (created_at = {cursorCreatedAt: String} AND run_id < {cursorRunId: String}))`,
        {
          cursorCreatedAt: decodedCursor.createdAt,
          cursorRunId: decodedCursor.runId,
        }
      );
    }

    queryBuilder.orderBy("created_at DESC, run_id DESC");
    queryBuilder.limit(pageSize + 1);

    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    const results = records || [];
    const hasMore = results.length > pageSize;
    const instances = results.slice(0, pageSize);

    // Build next cursor from the last item
    let nextCursor: string | undefined;
    if (hasMore && instances.length > 0) {
      const lastInstance = instances[instances.length - 1];
      nextCursor = encodeCursor({
        createdAt: lastInstance.created_at,
        runId: lastInstance.run_id,
      });
    }

    // Get error group summary from the first instance
    let errorGroup:
      | {
          errorType: string;
          errorMessage: string;
          stackTrace?: string;
        }
      | undefined;

    if (instances.length > 0) {
      const firstInstance = instances[0];
      try {
        const errorData = JSON.parse(firstInstance.error_text);
        errorGroup = {
          errorType: errorData.type || errorData.name || "Error",
          errorMessage: errorData.message || "Unknown error",
          stackTrace: errorData.stack || errorData.stacktrace,
        };
      } catch {
        // If parsing fails, use fallback
        errorGroup = {
          errorType: "Error",
          errorMessage: firstInstance.error_text.substring(0, 200),
        };
      }
    }

    // Transform results
    const transformedInstances = instances.map((instance) => {
      let parsedError: any;
      try {
        parsedError = JSON.parse(instance.error_text);
      } catch {
        parsedError = { message: instance.error_text };
      }

      return {
        runId: instance.run_id,
        friendlyId: instance.friendly_id,
        taskIdentifier: instance.task_identifier,
        createdAt: new Date(parseInt(instance.created_at) * 1000),
        status: instance.status,
        error: parsedError,
        traceId: instance.trace_id,
        taskVersion: instance.task_version,
      };
    });

    return {
      errorGroup,
      instances: transformedInstances,
      pagination: {
        hasMore,
        nextCursor,
      },
    };
  }
}
