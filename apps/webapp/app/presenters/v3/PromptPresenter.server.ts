import { ClickHouse } from "@internal/clickhouse";
import { PrismaClientOrTransaction } from "~/db.server";
import { BasePresenter } from "./basePresenter.server";
import { z } from "zod";

const GenerationRowSchema = z.object({
  run_id: z.string(),
  span_id: z.string(),
  operation_id: z.string(),
  task_identifier: z.string(),
  response_model: z.string(),
  prompt_version: z.coerce.number(),
  input_tokens: z.coerce.number(),
  output_tokens: z.coerce.number(),
  total_cost: z.coerce.number(),
  duration_ms: z.coerce.number(),
  started_at: z.string(),
});

export type GenerationRow = {
  run_id: string;
  span_id: string;
  operation_id: string;
  task_identifier: string;
  response_model: string;
  prompt_version: number;
  input_tokens: number;
  output_tokens: number;
  total_cost: number;
  duration_ms: number;
  start_time: string;
};

export type GenerationsPagination = {
  next?: string;
};

export class PromptPresenter extends BasePresenter {
  private readonly clickhouse: ClickHouse;

  constructor(clickhouse: ClickHouse, replica?: PrismaClientOrTransaction) {
    super(undefined, replica);
    this.clickhouse = clickhouse;
  }

  async listPrompts(projectId: string, environmentId: string) {
    const prompts = await this._replica.prompt.findMany({
      where: {
        projectId,
        runtimeEnvironmentId: environmentId,
        archivedAt: null,
      },
      include: {
        versions: {
          where: {
            labels: { hasSome: ["current", "override"] },
          },
          select: {
            version: true,
            labels: true,
            model: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    return prompts.map((p) => {
      const currentVersion = p.versions.find((v) => v.labels.includes("current"));
      const overrideVersion = p.versions.find((v) => v.labels.includes("override"));
      const hasOverride = !!overrideVersion;

      // Effective model: override > current version > prompt default
      const effectiveModel =
        overrideVersion?.model ?? currentVersion?.model ?? p.defaultModel;

      return {
        id: p.id,
        friendlyId: p.friendlyId,
        slug: p.slug,
        description: p.description,
        tags: p.tags,
        defaultModel: effectiveModel,
        currentVersion: currentVersion ? { version: currentVersion.version } : null,
        overrideVersion: overrideVersion ? { version: overrideVersion.version } : null,
        hasOverride,
        updatedAt: p.updatedAt,
      };
    });
  }

  async getUsageSparklines(
    environmentId: string,
    promptSlugs: string[]
  ): Promise<Record<string, number[]>> {
    if (promptSlugs.length === 0) return {};

    const queryFn = this.clickhouse.reader.query({
      name: "promptUsageSparklines",
      query: `SELECT
          prompt_slug,
          toStartOfHour(start_time) AS bucket,
          count() AS cnt
        FROM trigger_dev.llm_metrics_v1
        WHERE environment_id = {environmentId: String}
          AND prompt_slug IN {promptSlugs: Array(String)}
          AND start_time >= now() - INTERVAL 24 HOUR
        GROUP BY prompt_slug, bucket
        ORDER BY prompt_slug, bucket`,
      params: z.object({
        environmentId: z.string(),
        promptSlugs: z.array(z.string()),
      }),
      schema: z.object({
        prompt_slug: z.string(),
        bucket: z.string(),
        cnt: z.coerce.number(),
      }),
    });

    const [error, rows] = await queryFn({ environmentId, promptSlugs });
    if (error) {
      console.error("Prompt usage sparkline query failed:", error);
      return {};
    }

    // Build a map of slug -> 24 hourly buckets (use UTC to match ClickHouse)
    const now = new Date();
    const startHour = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours() - 23,
      0, 0, 0
    ));

    const bucketKeys: string[] = [];
    for (let i = 0; i < 24; i++) {
      const h = new Date(startHour.getTime() + i * 3600_000);
      // Format to match ClickHouse's toStartOfHour output: "YYYY-MM-DD HH:MM:SS"
      bucketKeys.push(
        h.toISOString().slice(0, 13).replace("T", " ") + ":00:00"
      );
    }

    // Index rows by slug+bucket for fast lookup
    const rowMap = new Map<string, number>();
    for (const row of rows) {
      rowMap.set(`${row.prompt_slug}|${row.bucket}`, row.cnt);
    }

    const result: Record<string, number[]> = {};
    for (const slug of promptSlugs) {
      result[slug] = bucketKeys.map((key) => rowMap.get(`${slug}|${key}`) ?? 0);
    }

    return result;
  }

  async resolveVersion(
    promptId: string,
    options?: { version?: number; label?: string }
  ) {
    if (options?.version != null) {
      return this._replica.promptVersion.findUnique({
        where: {
          promptId_version: {
            promptId,
            version: options.version,
          },
        },
      });
    }

    // Check for override first — dashboard edits take precedence
    const override = await this._replica.promptVersion.findFirst({
      where: {
        promptId,
        labels: { has: "override" },
      },
      orderBy: { version: "desc" },
    });

    if (override) {
      return override;
    }

    const label = options?.label ?? "current";
    return this._replica.promptVersion.findFirst({
      where: {
        promptId,
        labels: { has: label },
      },
      orderBy: { version: "desc" },
    });
  }

  async listVersions(promptId: string, limit: number = 50) {
    return this._replica.promptVersion.findMany({
      where: { promptId },
      orderBy: { version: "desc" },
      take: limit,
      select: {
        id: true,
        version: true,
        labels: true,
        source: true,
        model: true,
        textContent: true,
        commitMessage: true,
        contentHash: true,
        createdAt: true,
      },
    });
  }

  async listGenerations(options: {
    environmentId: string;
    promptSlug: string;
    promptVersions?: number[];
    startTime: Date;
    endTime: Date;
    cursor?: string;
    pageSize?: number;
    responseModels?: string[];
    operations?: string[];
    providers?: string[];
  }): Promise<{ generations: GenerationRow[]; pagination: GenerationsPagination }> {
    const pageSize = options.pageSize ?? 25;
    const decodedCursor = options.cursor ? decodeCursor(options.cursor) : null;

    const cursorClause = decodedCursor
      ? `AND (start_time < parseDateTimeBestEffort({cursorStartTime: String})
             OR (start_time = parseDateTimeBestEffort({cursorStartTime: String})
                 AND span_id < {cursorSpanId: String}))`
      : "";

    const versionClause = options.promptVersions?.length
      ? `AND prompt_version IN {promptVersions: Array(UInt32)}`
      : "";
    const modelClause = options.responseModels?.length
      ? `AND response_model IN {responseModels: Array(String)}`
      : "";
    const operationClause = options.operations?.length
      ? `AND operation_id IN {operations: Array(String)}`
      : "";
    const providerClause = options.providers?.length
      ? `AND gen_ai_system IN {providers: Array(String)}`
      : "";

    // Build a unique query name based on which optional filters are active
    const filterKey = [
      decodedCursor ? "c" : "",
      options.promptVersions?.length ? "v" : "",
      options.responseModels?.length ? "m" : "",
      options.operations?.length ? "o" : "",
      options.providers?.length ? "p" : "",
    ].join("");

    const queryFn = this.clickhouse.reader.query({
      name: `promptGenerationsList${filterKey}`,
      query: `SELECT
          run_id, span_id, operation_id, task_identifier, response_model,
          prompt_version,
          input_tokens, output_tokens, total_cost,
          duration / 1000000 AS duration_ms,
          formatDateTime(start_time, '%Y-%m-%d %H:%i:%S') AS started_at
        FROM trigger_dev.llm_metrics_v1
        WHERE environment_id = {environmentId: String}
          AND prompt_slug = {promptSlug: String}
          ${versionClause}
          AND start_time >= parseDateTimeBestEffort({startTime: String})
          AND start_time <= parseDateTimeBestEffort({endTime: String})
          ${cursorClause}
          ${modelClause}
          ${operationClause}
          ${providerClause}
        ORDER BY start_time DESC, span_id DESC
        LIMIT {fetchLimit: UInt32}`,
      params: z.object({
        environmentId: z.string(),
        promptSlug: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        fetchLimit: z.number(),
        ...(decodedCursor
          ? {
              cursorStartTime: z.string(),
              cursorSpanId: z.string(),
            }
          : {}),
        ...(options.promptVersions?.length ? { promptVersions: z.array(z.number()) } : {}),
        ...(options.responseModels?.length ? { responseModels: z.array(z.string()) } : {}),
        ...(options.operations?.length ? { operations: z.array(z.string()) } : {}),
        ...(options.providers?.length ? { providers: z.array(z.string()) } : {}),
      }),
      schema: GenerationRowSchema,
    });

    const queryParams: Record<string, unknown> = {
      environmentId: options.environmentId,
      promptSlug: options.promptSlug,
      startTime: options.startTime.toISOString(),
      endTime: options.endTime.toISOString(),
      fetchLimit: pageSize + 1,
    };

    if (decodedCursor) {
      queryParams.cursorStartTime = decodedCursor.startTime;
      queryParams.cursorSpanId = decodedCursor.spanId;
    }
    if (options.promptVersions?.length) {
      queryParams.promptVersions = options.promptVersions;
    }
    if (options.responseModels?.length) {
      queryParams.responseModels = options.responseModels;
    }
    if (options.operations?.length) {
      queryParams.operations = options.operations;
    }
    if (options.providers?.length) {
      queryParams.providers = options.providers;
    }

    const [error, rows] = await queryFn(queryParams as any);

    if (error) {
      console.error("Prompt generations query failed:", error);
      return { generations: [], pagination: {} };
    }

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

    const generations: GenerationRow[] = pageRows.map((r) => ({
      ...r,
      start_time: r.started_at,
    }));

    const pagination: GenerationsPagination = {};
    if (hasMore) {
      const lastRow = pageRows[pageRows.length - 1];
      pagination.next = encodeCursor(lastRow.started_at, lastRow.span_id);
    }

    return { generations, pagination };
  }

  async getDistinctPromptSlugs(
    organizationId: string,
    projectId: string,
    environmentId: string
  ): Promise<string[]> {
    const queryFn = this.clickhouse.reader.query({
      name: "getDistinctPromptSlugs",
      query: `SELECT DISTINCT prompt_slug FROM trigger_dev.llm_metrics_v1 WHERE organization_id = {organizationId: String} AND project_id = {projectId: String} AND environment_id = {environmentId: String} AND prompt_slug != '' ORDER BY prompt_slug`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
      }),
      schema: z.object({ prompt_slug: z.string() }),
    });

    const [error, rows] = await queryFn({ organizationId, projectId, environmentId });
    if (error) {
      return [];
    }
    return rows.map((r) => r.prompt_slug);
  }

  async getDistinctOperations(
    organizationId: string,
    projectId: string,
    environmentId: string
  ): Promise<string[]> {
    const queryFn = this.clickhouse.reader.query({
      name: "getDistinctOperations",
      query: `SELECT DISTINCT operation_id FROM trigger_dev.llm_metrics_v1 WHERE organization_id = {organizationId: String} AND project_id = {projectId: String} AND environment_id = {environmentId: String} AND operation_id != '' ORDER BY operation_id`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
      }),
      schema: z.object({ operation_id: z.string() }),
    });

    const [error, rows] = await queryFn({ organizationId, projectId, environmentId });
    if (error) {
      return [];
    }
    return rows.map((r) => r.operation_id);
  }

  async getDistinctProviders(
    organizationId: string,
    projectId: string,
    environmentId: string
  ): Promise<string[]> {
    const queryFn = this.clickhouse.reader.query({
      name: "getDistinctProviders",
      query: `SELECT DISTINCT gen_ai_system FROM trigger_dev.llm_metrics_v1 WHERE organization_id = {organizationId: String} AND project_id = {projectId: String} AND environment_id = {environmentId: String} AND gen_ai_system != '' ORDER BY gen_ai_system`,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
      }),
      schema: z.object({ gen_ai_system: z.string() }),
    });

    const [error, rows] = await queryFn({ organizationId, projectId, environmentId });
    if (error) {
      return [];
    }
    return rows.map((r) => r.gen_ai_system);
  }
}

function encodeCursor(startTime: string, spanId: string): string {
  return Buffer.from(JSON.stringify({ s: startTime, i: spanId })).toString("base64");
}

function decodeCursor(cursor: string): { startTime: string; spanId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")) as Record<string, unknown>;
    if (typeof parsed.s === "string" && typeof parsed.i === "string") {
      return { startTime: parsed.s, spanId: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}
