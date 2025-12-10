import { ParserRuleContext } from "antlr4ts/ParserRuleContext";
import { ErrorNode } from "antlr4ts/tree/ErrorNode";
import { ParseTree } from "antlr4ts/tree/ParseTree";
import { TerminalNode } from "antlr4ts/tree/TerminalNode";
import {
  ArrayJoinClauseContext,
  ColumnExprContext,
  ColumnExprListContext,
  FromClauseContext,
  GroupByClauseContext,
  HavingClauseContext,
  JoinExprContext,
  LimitAndOffsetClauseContext,
  LimitByClauseContext,
  OffsetOnlyClauseContext,
  OrderByClauseContext,
  PlaceholderContext,
  PrewhereClauseContext,
  SelectContext,
  SelectSetStmtContext,
  SelectStmtContext,
  SelectStmtWithParensContext,
  SettingsClauseContext,
  TopClauseContext,
  WhereClauseContext,
  WindowClauseContext,
  WithClauseContext,
} from "../grammar/TSQLParser.js";
import { TSQLParserVisitor } from "../grammar/TSQLParserVisitor.js";
import { QueryConfig } from "./QueryConfig.js";

/**
 * Visitor that converts TSQL AST to a QueryConfig
 * The QueryConfig can then be used to build a ClickhouseQueryBuilder
 */
export class ClickHouseQueryVisitor implements TSQLParserVisitor<QueryConfig> {
  visitSelect(ctx: SelectContext): QueryConfig {
    const selectSetStmt = ctx.selectSetStmt();
    if (selectSetStmt) {
      return this.visitSelectSetStmt(selectSetStmt);
    }

    const selectStmt = ctx.selectStmt();
    if (selectStmt) {
      return this.visitSelectStmt(selectStmt);
    }

    // Handle tSQLxTagElement if needed - return empty config
    return {
      baseQuery: "",
      whereClauses: [],
    };
  }

  visitSelectSetStmt(ctx: SelectSetStmtContext): QueryConfig {
    const selectStmtWithParens = ctx.selectStmtWithParens();
    let config = this.visitSelectStmtWithParens(selectStmtWithParens);

    // Handle subsequent select set clauses (UNION, EXCEPT, INTERSECT)
    // For now, we'll convert the config back to SQL for UNION operations
    // This is a limitation - UNION queries can't use the query builder pattern easily
    const subsequentClauses = ctx.subsequentSelectSetClause();
    if (subsequentClauses.length > 0) {
      // Convert config to SQL for UNION operations
      let query = this.configToSql(config);
      for (const clause of subsequentClauses) {
        const op = clause.EXCEPT()
          ? "EXCEPT"
          : clause.UNION()
          ? clause.ALL()
            ? "UNION ALL"
            : clause.DISTINCT()
            ? "UNION DISTINCT"
            : "UNION"
          : clause.INTERSECT()
          ? clause.DISTINCT()
            ? "INTERSECT DISTINCT"
            : "INTERSECT"
          : "";

        if (op) {
          const nextConfig = this.visitSelectStmtWithParens(clause.selectStmtWithParens());
          query += ` ${op} ${this.configToSql(nextConfig)}`;
        }
      }
      // Return as a base query (can't use query builder features with UNION)
      return {
        baseQuery: query,
        whereClauses: [],
      };
    }

    return config;
  }

  visitSelectStmtWithParens(ctx: SelectStmtWithParensContext): QueryConfig {
    const selectStmt = ctx.selectStmt();
    if (selectStmt) {
      return this.visitSelectStmt(selectStmt);
    }

    const selectSetStmt = ctx.selectSetStmt();
    if (selectSetStmt) {
      const config = this.visitSelectSetStmt(selectSetStmt);
      // Wrap in parentheses for subquery
      return {
        ...config,
        baseQuery: `(${this.configToSql(config)})`,
        whereClauses: [], // Subqueries don't contribute to outer WHERE
      };
    }

    // Handle placeholder if needed
    const placeholder = ctx.placeholder();
    if (placeholder) {
      const placeholderConfig = this.visitPlaceholder(placeholder);
      return placeholderConfig;
    }

    return {
      baseQuery: this.getTextFromContext(ctx),
      whereClauses: [],
    };
  }

  visitPlaceholder(ctx: PlaceholderContext): QueryConfig {
    return {
      baseQuery: this.getTextFromContext(ctx),
      whereClauses: [],
    };
  }

  visitSelectStmt(ctx: SelectStmtContext): QueryConfig {
    const config: QueryConfig = {
      baseQuery: "",
      whereClauses: [],
    };

    const parts: string[] = [];

    // WITH clause
    const withClause = ctx.withClause();
    if (withClause) {
      parts.push(this.visitWithClauseString(withClause));
    }

    // SELECT
    parts.push("SELECT");

    // DISTINCT
    if (ctx.DISTINCT()) {
      parts.push("DISTINCT");
    }

    // TOP clause
    const topClause = ctx.topClause();
    if (topClause) {
      parts.push(this.visitTopClauseString(topClause));
    }

    // Column list
    const columnExprList = ctx.columnExprList();
    if (columnExprList) {
      parts.push(this.visitColumnExprListString(columnExprList));
    }

    // FROM clause
    const fromClause = ctx.fromClause();
    if (fromClause) {
      parts.push(this.visitFromClauseString(fromClause));
    }

    // Array JOIN
    const arrayJoinClause = ctx.arrayJoinClause();
    if (arrayJoinClause) {
      parts.push(this.visitArrayJoinClauseString(arrayJoinClause));
    }

    // PREWHERE
    const prewhereClause = ctx.prewhereClause();
    if (prewhereClause) {
      parts.push(this.visitPrewhereClauseString(prewhereClause));
    }

    // Base query is everything up to WHERE
    config.baseQuery = parts.join(" ");

    // WHERE - extract to whereClauses array
    const whereClause = ctx.whereClause();
    if (whereClause) {
      const whereExpr = this.visitWhereClauseString(whereClause);
      // Remove "WHERE " prefix
      const whereCondition = whereExpr.replace(/^WHERE\s+/i, "");
      config.whereClauses.push({
        clause: whereCondition,
      });
    }

    // GROUP BY
    const groupByClause = ctx.groupByClause();
    if (groupByClause) {
      const groupByText = this.visitGroupByClauseString(groupByClause);
      // Remove "GROUP BY " prefix
      config.groupBy = groupByText.replace(/^GROUP\s+BY\s+/i, "");
    }

    // HAVING - add as WHERE clause (ClickHouse doesn't distinguish)
    const havingClause = ctx.havingClause();
    if (havingClause) {
      const havingText = this.visitHavingClauseString(havingClause);
      // Remove "HAVING " prefix
      const havingCondition = havingText.replace(/^HAVING\s+/i, "");
      config.whereClauses.push({
        clause: havingCondition,
      });
    }

    // WINDOW
    const windowClause = ctx.windowClause();
    if (windowClause) {
      const windowText = this.visitWindowClauseString(windowClause);
      // Append to base query
      config.baseQuery += " " + windowText;
    }

    // ORDER BY
    const orderByClause = ctx.orderByClause();
    if (orderByClause) {
      const orderByText = this.visitOrderByClauseString(orderByClause);
      // Remove "ORDER BY " prefix
      config.orderBy = orderByText.replace(/^ORDER\s+BY\s+/i, "");
    }

    // LIMIT BY
    const limitByClause = ctx.limitByClause();
    if (limitByClause) {
      const limitByText = this.visitLimitByClauseString(limitByClause);
      // Append to base query (LIMIT BY is not supported by query builder)
      config.baseQuery += " " + limitByText;
    }

    // LIMIT / OFFSET
    const limitAndOffsetClause = ctx.limitAndOffsetClause();
    if (limitAndOffsetClause) {
      const limitText = this.visitLimitAndOffsetClauseString(limitAndOffsetClause);
      // Try to extract limit number
      const limitMatch = limitText.match(/LIMIT\s+(\d+)/i);
      if (limitMatch) {
        config.limit = parseInt(limitMatch[1], 10);
      } else {
        // If we can't parse it, append to base query
        config.baseQuery += " " + limitText;
      }
    }

    const offsetOnlyClause = ctx.offsetOnlyClause();
    if (offsetOnlyClause) {
      const offsetText = this.visitOffsetOnlyClauseString(offsetOnlyClause);
      // Append to base query (OFFSET is not directly supported by query builder)
      config.baseQuery += " " + offsetText;
    }

    // SETTINGS
    const settingsClause = ctx.settingsClause();
    if (settingsClause) {
      const settingsText = this.visitSettingsClauseString(settingsClause);
      // Append to base query
      config.baseQuery += " " + settingsText;
    }

    return config;
  }

  // Helper methods that return strings for building SQL fragments
  // These are private and used internally, not part of the visitor interface
  private visitColumnExprListString(ctx: ColumnExprListContext): string {
    const exprs: string[] = [];
    const columnExprs = ctx.columnExpr();
    for (const expr of columnExprs) {
      exprs.push(this.visitColumnExprString(expr));
    }
    return exprs.join(", ");
  }

  private visitColumnExprString(ctx: ColumnExprContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitFromClauseString(ctx: FromClauseContext): string {
    const joinExpr = ctx.joinExpr();
    return `FROM ${this.visitJoinExprString(joinExpr)}`;
  }

  private visitJoinExprString(ctx: JoinExprContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitWhereClauseString(ctx: WhereClauseContext): string {
    const columnExpr = ctx.columnExpr();
    return `WHERE ${this.visitColumnExprString(columnExpr)}`;
  }

  private visitGroupByClauseString(ctx: GroupByClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitHavingClauseString(ctx: HavingClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitOrderByClauseString(ctx: OrderByClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitLimitByClauseString(ctx: LimitByClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitLimitAndOffsetClauseString(ctx: LimitAndOffsetClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitOffsetOnlyClauseString(ctx: OffsetOnlyClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitSettingsClauseString(ctx: SettingsClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitWithClauseString(ctx: WithClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitTopClauseString(ctx: TopClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitArrayJoinClauseString(ctx: ArrayJoinClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitPrewhereClauseString(ctx: PrewhereClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  private visitWindowClauseString(ctx: WindowClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  // Interface methods that return QueryConfig (optional, so we can skip some)
  visitColumnExprList(ctx: ColumnExprListContext): QueryConfig {
    return {
      baseQuery: this.visitColumnExprListString(ctx),
      whereClauses: [],
    };
  }

  visitColumnExpr(ctx: ColumnExprContext): QueryConfig {
    return {
      baseQuery: this.visitColumnExprString(ctx),
      whereClauses: [],
    };
  }

  visitFromClause(ctx: FromClauseContext): QueryConfig {
    return {
      baseQuery: this.visitFromClauseString(ctx),
      whereClauses: [],
    };
  }

  visitJoinExpr(ctx: JoinExprContext): QueryConfig {
    return {
      baseQuery: this.visitJoinExprString(ctx),
      whereClauses: [],
    };
  }

  visitWhereClause(ctx: WhereClauseContext): QueryConfig {
    return {
      baseQuery: this.visitWhereClauseString(ctx),
      whereClauses: [],
    };
  }

  visitGroupByClause(ctx: GroupByClauseContext): QueryConfig {
    return {
      baseQuery: this.visitGroupByClauseString(ctx),
      whereClauses: [],
    };
  }

  visitHavingClause(ctx: HavingClauseContext): QueryConfig {
    return {
      baseQuery: this.visitHavingClauseString(ctx),
      whereClauses: [],
    };
  }

  visitOrderByClause(ctx: OrderByClauseContext): QueryConfig {
    return {
      baseQuery: this.visitOrderByClauseString(ctx),
      whereClauses: [],
    };
  }

  visitLimitByClause(ctx: LimitByClauseContext): QueryConfig {
    return {
      baseQuery: this.visitLimitByClauseString(ctx),
      whereClauses: [],
    };
  }

  visitLimitAndOffsetClause(ctx: LimitAndOffsetClauseContext): QueryConfig {
    return {
      baseQuery: this.visitLimitAndOffsetClauseString(ctx),
      whereClauses: [],
    };
  }

  visitOffsetOnlyClause(ctx: OffsetOnlyClauseContext): QueryConfig {
    return {
      baseQuery: this.visitOffsetOnlyClauseString(ctx),
      whereClauses: [],
    };
  }

  visitSettingsClause(ctx: SettingsClauseContext): QueryConfig {
    return {
      baseQuery: this.visitSettingsClauseString(ctx),
      whereClauses: [],
    };
  }

  visitWithClause(ctx: WithClauseContext): QueryConfig {
    return {
      baseQuery: this.visitWithClauseString(ctx),
      whereClauses: [],
    };
  }

  visitTopClause(ctx: TopClauseContext): QueryConfig {
    return {
      baseQuery: this.visitTopClauseString(ctx),
      whereClauses: [],
    };
  }

  visitArrayJoinClause(ctx: ArrayJoinClauseContext): QueryConfig {
    return {
      baseQuery: this.visitArrayJoinClauseString(ctx),
      whereClauses: [],
    };
  }

  visitPrewhereClause(ctx: PrewhereClauseContext): QueryConfig {
    return {
      baseQuery: this.visitPrewhereClauseString(ctx),
      whereClauses: [],
    };
  }

  visitWindowClause(ctx: WindowClauseContext): QueryConfig {
    return {
      baseQuery: this.visitWindowClauseString(ctx),
      whereClauses: [],
    };
  }

  /**
   * Convert a QueryConfig back to SQL string
   * Used for UNION operations and subqueries
   */
  private configToSql(config: QueryConfig): string {
    let query = config.baseQuery;
    if (config.whereClauses.length > 0) {
      const clauses = config.whereClauses.map((w) => w.clause);
      query += " WHERE " + clauses.join(" AND ");
    }
    if (config.groupBy) {
      query += ` GROUP BY ${config.groupBy}`;
    }
    if (config.orderBy) {
      query += ` ORDER BY ${config.orderBy}`;
    }
    if (config.limit !== undefined) {
      query += ` LIMIT ${config.limit}`;
    }
    return query;
  }

  /**
   * Extract the original text from a parse tree context
   * This uses the text property which contains the original input text
   */
  private getTextFromContext(ctx: ParserRuleContext): string {
    return (ctx as any).text || "";
  }

  // Required by ParseTreeVisitor interface
  visit(tree: ParseTree): QueryConfig {
    // For generic parse trees, return empty config
    return {
      baseQuery: (tree as any).text || "",
      whereClauses: [],
    };
  }

  visitChildren(node: ParserRuleContext): QueryConfig {
    // Visit all children and combine their configs
    if (!node.children || node.children.length === 0) {
      return this.visit(node);
    }
    // For now, just return the text representation
    return {
      baseQuery: (node as any).text || "",
      whereClauses: [],
    };
  }

  // Visit terminal nodes
  visitTerminal(node: TerminalNode): QueryConfig {
    return {
      baseQuery: node.text,
      whereClauses: [],
    };
  }

  visitErrorNode(node: ErrorNode): QueryConfig {
    return {
      baseQuery: "",
      whereClauses: [],
    };
  }
}
