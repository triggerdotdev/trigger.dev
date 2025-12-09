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

/**
 * Visitor that converts TSQL AST to ClickHouse SQL
 */
export class ClickHouseQueryVisitor implements TSQLParserVisitor<string> {
  visitSelect(ctx: SelectContext): string {
    const selectSetStmt = ctx.selectSetStmt();
    if (selectSetStmt) {
      return this.visitSelectSetStmt(selectSetStmt);
    }

    const selectStmt = ctx.selectStmt();
    if (selectStmt) {
      return this.visitSelectStmt(selectStmt);
    }

    // Handle tSQLxTagElement if needed
    return "";
  }

  visitSelectSetStmt(ctx: SelectSetStmtContext): string {
    const selectStmtWithParens = ctx.selectStmtWithParens();
    let query = this.visitSelectStmtWithParens(selectStmtWithParens);

    // Handle subsequent select set clauses (UNION, EXCEPT, INTERSECT)
    const subsequentClauses = ctx.subsequentSelectSetClause();
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
        const nextSelect = clause.selectStmtWithParens();
        query += ` ${op} ${this.visitSelectStmtWithParens(nextSelect)}`;
      }
    }

    return query;
  }

  visitSelectStmtWithParens(ctx: SelectStmtWithParensContext): string {
    const selectStmt = ctx.selectStmt();
    if (selectStmt) {
      return this.visitSelectStmt(selectStmt);
    }

    const selectSetStmt = ctx.selectSetStmt();
    if (selectSetStmt) {
      return `(${this.visitSelectSetStmt(selectSetStmt)})`;
    }

    // Handle placeholder if needed
    const placeholder = ctx.placeholder();
    if (placeholder) {
      return this.visitPlaceholder(placeholder);
    }

    return this.getTextFromContext(ctx);
  }

  visitPlaceholder(ctx: PlaceholderContext): string {
    return this.getTextFromContext(ctx);
  }

  visitSelectStmt(ctx: SelectStmtContext): string {
    let parts: string[] = [];

    // WITH clause
    const withClause = ctx.withClause();
    if (withClause) {
      parts.push(this.visitWithClause(withClause));
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
      parts.push(this.visitTopClause(topClause));
    }

    // Column list
    const columnExprList = ctx.columnExprList();
    if (columnExprList) {
      parts.push(this.visitColumnExprList(columnExprList));
    }

    // FROM clause
    const fromClause = ctx.fromClause();
    if (fromClause) {
      parts.push(this.visitFromClause(fromClause));
    }

    // Array JOIN
    const arrayJoinClause = ctx.arrayJoinClause();
    if (arrayJoinClause) {
      parts.push(this.visitArrayJoinClause(arrayJoinClause));
    }

    // PREWHERE
    const prewhereClause = ctx.prewhereClause();
    if (prewhereClause) {
      parts.push(this.visitPrewhereClause(prewhereClause));
    }

    // WHERE
    const whereClause = ctx.whereClause();
    if (whereClause) {
      parts.push(this.visitWhereClause(whereClause));
    }

    // GROUP BY
    const groupByClause = ctx.groupByClause();
    if (groupByClause) {
      parts.push(this.visitGroupByClause(groupByClause));
    }

    // HAVING
    const havingClause = ctx.havingClause();
    if (havingClause) {
      parts.push(this.visitHavingClause(havingClause));
    }

    // WINDOW
    const windowClause = ctx.windowClause();
    if (windowClause) {
      parts.push(this.visitWindowClause(windowClause));
    }

    // ORDER BY
    const orderByClause = ctx.orderByClause();
    if (orderByClause) {
      parts.push(this.visitOrderByClause(orderByClause));
    }

    // LIMIT BY
    const limitByClause = ctx.limitByClause();
    if (limitByClause) {
      parts.push(this.visitLimitByClause(limitByClause));
    }

    // LIMIT / OFFSET
    const limitAndOffsetClause = ctx.limitAndOffsetClause();
    if (limitAndOffsetClause) {
      parts.push(this.visitLimitAndOffsetClause(limitAndOffsetClause));
    }

    const offsetOnlyClause = ctx.offsetOnlyClause();
    if (offsetOnlyClause) {
      parts.push(this.visitOffsetOnlyClause(offsetOnlyClause));
    }

    // SETTINGS
    const settingsClause = ctx.settingsClause();
    if (settingsClause) {
      parts.push(this.visitSettingsClause(settingsClause));
    }

    return parts.join(" ");
  }

  visitColumnExprList(ctx: ColumnExprListContext): string {
    const exprs: string[] = [];
    const columnExprs = ctx.columnExpr();
    for (const expr of columnExprs) {
      exprs.push(this.visitColumnExpr(expr));
    }
    return exprs.join(", ");
  }

  visitColumnExpr(ctx: ColumnExprContext): string {
    // Use the text property which contains the original input text for this node
    return this.getTextFromContext(ctx);
  }

  visitFromClause(ctx: FromClauseContext): string {
    const joinExpr = ctx.joinExpr();
    return `FROM ${this.visitJoinExpr(joinExpr)}`;
  }

  visitJoinExpr(ctx: JoinExprContext): string {
    return this.getTextFromContext(ctx);
  }

  visitWhereClause(ctx: WhereClauseContext): string {
    const columnExpr = ctx.columnExpr();
    return `WHERE ${this.visitColumnExpr(columnExpr)}`;
  }

  visitGroupByClause(ctx: GroupByClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  visitHavingClause(ctx: HavingClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  visitOrderByClause(ctx: OrderByClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  visitLimitByClause(ctx: LimitByClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  visitLimitAndOffsetClause(ctx: LimitAndOffsetClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  visitOffsetOnlyClause(ctx: OffsetOnlyClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  visitSettingsClause(ctx: SettingsClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  visitWithClause(ctx: WithClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  visitTopClause(ctx: TopClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  visitArrayJoinClause(ctx: ArrayJoinClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  visitPrewhereClause(ctx: PrewhereClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  visitWindowClause(ctx: WindowClauseContext): string {
    return this.getTextFromContext(ctx);
  }

  /**
   * Extract the original text from a parse tree context
   * This uses the text property which contains the original input text
   */
  private getTextFromContext(ctx: ParserRuleContext): string {
    // The text property exists at runtime but may not be in types
    return (ctx as any).text || "";
  }

  // Required by ParseTreeVisitor interface
  visit(tree: ParseTree): string {
    // Use the text property which contains the original input text
    return (tree as any).text || "";
  }

  visitChildren(node: ParserRuleContext): string {
    // Visit all children and concatenate their results
    if (!node.children || node.children.length === 0) {
      return this.visit(node);
    }
    return node.children.map((child: ParseTree) => this.visit(child)).join(" ");
  }

  // Visit terminal nodes
  visitTerminal(node: TerminalNode): string {
    return node.text;
  }

  visitErrorNode(node: ErrorNode): string {
    return "";
  }
}
