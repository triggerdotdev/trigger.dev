import { CharStreams, CommonTokenStream } from "antlr4ts";
import { TSQLLexer } from "../grammar/TSQLLexer.js";
import { TSQLParser } from "../grammar/TSQLParser.js";
import { ClickHouseQueryVisitor } from "./ClickHouseQueryVisitor.js";
import type { ClickHouse } from "@internal/clickhouse";
import { ClickhouseQueryBuilder } from "@internal/clickhouse/client/queryBuilder.js";
import { z } from "zod";

export interface TQueryOptions {
  organizationId: string;
  projectId: string;
  environmentId: string;
}

export class TQuery {
  private readonly organizationId: string;
  private readonly projectId: string;
  private readonly environmentId: string;
  private readonly clickhouseReader: ClickHouse;

  constructor(clickhouseReader: ClickHouse, options: TQueryOptions) {
    this.clickhouseReader = clickhouseReader;
    this.organizationId = options.organizationId;
    this.projectId = options.projectId;
    this.environmentId = options.environmentId;
  }

  /**
   * Execute a TSQL query and return the results
   * @param input TSQL query string
   * @param schema Zod schema for the output rows
   * @returns Promise with query results
   */
  async query<TOutput extends z.ZodSchema<any>>(
    input: string,
    schema: TOutput
  ): Promise<[Error | null, z.output<TOutput>[] | null]> {
    // Parse the TSQL input
    const inputStream = CharStreams.fromString(input);
    const lexer = new TSQLLexer(inputStream);
    const tokenStream = new CommonTokenStream(lexer as any);
    const parser = new TSQLParser(tokenStream);

    // Parse as a SELECT statement
    const tree = parser.select();

    // Convert AST to QueryConfig
    const visitor = new ClickHouseQueryVisitor();
    const queryConfig = visitor.visit(tree);

    // Use ClickhouseQueryBuilder to build the query
    const queryBuilder = new ClickhouseQueryBuilder(
      "tsql-query",
      queryConfig.baseQuery,
      this.clickhouseReader.reader,
      schema
    );

    // Add existing WHERE clauses from the TSQL query
    for (const whereClause of queryConfig.whereClauses) {
      queryBuilder.where(whereClause.clause, whereClause.params);
    }

    // Add scoping WHERE clauses
    queryBuilder
      .where("organization_id = {organizationId: String}", {
        organizationId: this.organizationId,
      })
      .where("project_id = {projectId: String}", {
        projectId: this.projectId,
      })
      .where("environment_id = {environmentId: String}", {
        environmentId: this.environmentId,
      });

    // Add GROUP BY if present
    if (queryConfig.groupBy) {
      queryBuilder.groupBy(queryConfig.groupBy);
    }

    // Add ORDER BY if present
    if (queryConfig.orderBy) {
      queryBuilder.orderBy(queryConfig.orderBy);
    }

    // Add LIMIT if present
    if (queryConfig.limit !== undefined) {
      queryBuilder.limit(queryConfig.limit);
    }

    // Execute the query
    return await queryBuilder.execute();
  }
}
