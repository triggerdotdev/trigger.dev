import { z } from "zod";
import { ClickhouseQueryFunction, ClickhouseReader } from "./types.js";
import { ClickHouseSettings } from "@clickhouse/client";
export type QueryParamValue = string | number | boolean | Array<string | number | boolean> | null;
export type QueryParams = Record<string, QueryParamValue>;

export class ClickhouseQueryBuilder<TOutput> {
  private name: string;
  private baseQuery: string;
  private whereClauses: string[] = [];
  private params: QueryParams = {};
  private orderByClause: string | null = null;
  private limitClause: string | null = null;
  private reader: ClickhouseReader;
  private schema: z.ZodSchema<TOutput>;
  private settings: ClickHouseSettings | undefined;
  private groupByClause: string | null = null;

  constructor(
    name: string,
    baseQuery: string,
    reader: ClickhouseReader,
    schema: z.ZodSchema<TOutput>,
    settings?: ClickHouseSettings
  ) {
    this.name = name;
    this.baseQuery = baseQuery;
    this.reader = reader;
    this.schema = schema;
    this.settings = settings;
  }

  where(clause: string, params?: QueryParams): this {
    this.whereClauses.push(clause);
    if (params) {
      Object.assign(this.params, params);
    }
    return this;
  }

  whereIf(condition: any, clause: string, params?: QueryParams): this {
    if (condition) {
      this.where(clause, params);
    }
    return this;
  }

  groupBy(clause: string): this {
    this.groupByClause = clause;
    return this;
  }

  orderBy(clause: string): this {
    this.orderByClause = clause;
    return this;
  }

  limit(limit: number): this {
    this.limitClause = `LIMIT ${limit}`;
    return this;
  }

  execute(): ReturnType<ClickhouseQueryFunction<void, TOutput>> {
    const { query, params } = this.build();

    const queryFunction = this.reader.query({
      name: this.name,
      query,
      params: z.any(),
      schema: this.schema,
      settings: this.settings,
    });

    return queryFunction(params);
  }

  build(): { query: string; params: QueryParams } {
    let query = this.baseQuery;
    if (this.whereClauses.length > 0) {
      query += " WHERE " + this.whereClauses.join(" AND ");
    }
    if (this.groupByClause) {
      query += ` GROUP BY ${this.groupByClause}`;
    }
    if (this.orderByClause) {
      query += ` ORDER BY ${this.orderByClause}`;
    }
    if (this.limitClause) {
      query += ` ${this.limitClause}`;
    }
    return { query, params: this.params };
  }
}
