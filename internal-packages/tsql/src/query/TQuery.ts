import { CharStreams, CommonTokenStream } from "antlr4ts";
import { TSQLLexer } from "../grammar/TSQLLexer.js";
import { TSQLParser } from "../grammar/TSQLParser.js";
import { ClickHouseQueryVisitor } from "./ClickHouseQueryVisitor.js";
import type { ClickHouse } from "@internal/clickhouse";
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

    // Convert AST to ClickHouse SQL
    const visitor = new ClickHouseQueryVisitor();
    let clickhouseQuery = visitor.visit(tree);

    // Add WHERE clauses for scoping
    clickhouseQuery = this.addScopingWhereClauses(clickhouseQuery);

    // Execute the query using ClickHouse client
    const queryFunction = this.clickhouseReader.reader.query({
      name: "tsql-query",
      query: clickhouseQuery,
      params: z.object({
        organizationId: z.string(),
        projectId: z.string(),
        environmentId: z.string(),
      }),
      schema,
    });

    return await queryFunction({
      organizationId: this.organizationId,
      projectId: this.projectId,
      environmentId: this.environmentId,
    });
  }

  /**
   * Add WHERE clauses for organization_id, project_id, and environment_id
   * If the query already has a WHERE clause, we add AND conditions
   */
  private addScopingWhereClauses(query: string): string {
    const scopingConditions = [
      "organization_id = {organizationId: String}",
      "project_id = {projectId: String}",
      "environment_id = {environmentId: String}",
    ].join(" AND ");

    const upperQuery = query.toUpperCase();

    // Check if query already has a WHERE clause
    const whereIndex = upperQuery.indexOf(" WHERE ");
    if (whereIndex !== -1) {
      // Find the end of the WHERE clause (before GROUP BY, HAVING, ORDER BY, LIMIT, etc.)
      const groupByIndex = upperQuery.indexOf(" GROUP BY ", whereIndex);
      const havingIndex = upperQuery.indexOf(" HAVING ", whereIndex);
      const orderByIndex = upperQuery.indexOf(" ORDER BY ", whereIndex);
      const limitIndex = upperQuery.indexOf(" LIMIT ", whereIndex);

      let whereEndIndex = query.length;
      if (groupByIndex !== -1) whereEndIndex = Math.min(whereEndIndex, groupByIndex);
      if (havingIndex !== -1) whereEndIndex = Math.min(whereEndIndex, havingIndex);
      if (orderByIndex !== -1) whereEndIndex = Math.min(whereEndIndex, orderByIndex);
      if (limitIndex !== -1) whereEndIndex = Math.min(whereEndIndex, limitIndex);

      // Insert AND conditions before the end of WHERE clause
      const beforeWhereEnd = query.substring(0, whereEndIndex);
      const afterWhereEnd = query.substring(whereEndIndex);
      return `${beforeWhereEnd} AND ${scopingConditions}${afterWhereEnd}`;
    } else {
      // Add WHERE clause before GROUP BY, HAVING, ORDER BY, LIMIT, etc.
      const groupByIndex = upperQuery.indexOf(" GROUP BY ");
      const havingIndex = upperQuery.indexOf(" HAVING ");
      const orderByIndex = upperQuery.indexOf(" ORDER BY ");
      const limitIndex = upperQuery.indexOf(" LIMIT ");

      let insertIndex = query.length;
      if (groupByIndex !== -1) insertIndex = Math.min(insertIndex, groupByIndex);
      if (havingIndex !== -1) insertIndex = Math.min(insertIndex, havingIndex);
      if (orderByIndex !== -1) insertIndex = Math.min(insertIndex, orderByIndex);
      if (limitIndex !== -1) insertIndex = Math.min(insertIndex, limitIndex);

      return `${query.substring(0, insertIndex)} WHERE ${scopingConditions}${query.substring(
        insertIndex
      )}`;
    }
  }
}
