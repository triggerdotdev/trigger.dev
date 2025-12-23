import {
  executeTRQL,
  type ExecuteTRQLOptions,
  type FieldMappings,
  type TRQLQueryResult,
} from "@internal/clickhouse";
import type { CustomerQuerySource } from "@trigger.dev/database";
import type { TableSchema } from "@internal/trql";
import { type z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { clickhouseClient } from "./clickhouseInstance.server";

export type { TableSchema, TRQLQueryResult };

export type QueryScope = "organization" | "project" | "environment";

const scopeToEnum = {
  organization: "ORGANIZATION",
  project: "PROJECT",
  environment: "ENVIRONMENT",
} as const;

export type ExecuteQueryOptions<TOut extends z.ZodSchema> = Omit<
  ExecuteTRQLOptions<TOut>,
  "tableSchema" | "organizationId" | "projectId" | "environmentId" | "fieldMappings"
> & {
  tableSchema: TableSchema[];
  /** The scope of the query - determines tenant isolation */
  scope: QueryScope;
  /** Organization ID (required) */
  organizationId: string;
  /** Project ID (required for project/environment scope) */
  projectId: string;
  /** Environment ID (required for environment scope) */
  environmentId: string;
  /** History options for saving query to billing/audit */
  history?: {
    /** Where the query originated from */
    source: CustomerQuerySource;
    /** User ID (optional, null for API calls) */
    userId?: string | null;
  };
};

/**
 * Execute a TRQL query against ClickHouse with tenant isolation
 * Handles building tenant options, field mappings, and optionally saves to history
 */
export async function executeQuery<TOut extends z.ZodSchema>(
  options: ExecuteQueryOptions<TOut>
): Promise<TRQLQueryResult<z.output<TOut>>> {
  const { scope, organizationId, projectId, environmentId, history, ...baseOptions } = options;

  // Build tenant IDs based on scope
  const tenantOptions: {
    organizationId: string;
    projectId?: string;
    environmentId?: string;
  } = {
    organizationId,
  };

  if (scope === "project" || scope === "environment") {
    tenantOptions.projectId = projectId;
  }

  if (scope === "environment") {
    tenantOptions.environmentId = environmentId;
  }

  // Build field mappings for project_ref → project_id and environment_id → slug translation
  const projects = await prisma.project.findMany({
    where: { organizationId },
    select: { id: true, externalRef: true },
  });

  const environments = await prisma.runtimeEnvironment.findMany({
    where: { project: { organizationId } },
    select: { id: true, slug: true },
  });

  const fieldMappings: FieldMappings = {
    project: Object.fromEntries(projects.map((p) => [p.id, p.externalRef])),
    environment: Object.fromEntries(environments.map((e) => [e.id, e.slug])),
  };

  const result = await executeTRQL(clickhouseClient.reader, {
    ...baseOptions,
    ...tenantOptions,
    fieldMappings,
  });

  // If query succeeded and history options provided, save to history
  if (result[0] === null && history) {
    const stats = result[1].stats;
    const byteSeconds = parseFloat(stats.byte_seconds);
    const costInCents = byteSeconds * env.CENTS_PER_QUERY_BYTE_SECOND;

    await prisma.customerQuery.create({
      data: {
        query: options.query,
        scope: scopeToEnum[scope],
        stats: { ...stats },
        costInCents,
        source: history.source,
        organizationId,
        projectId: scope === "project" || scope === "environment" ? projectId : null,
        environmentId: scope === "environment" ? environmentId : null,
        userId: history.userId ?? null,
      },
    });
  }

  return result;
}
