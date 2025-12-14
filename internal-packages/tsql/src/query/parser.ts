import { ParserRuleContext } from "antlr4ts/ParserRuleContext";
import { Token } from "antlr4ts/Token";
import { ErrorNode } from "antlr4ts/tree/ErrorNode";
import { ParseTree } from "antlr4ts/tree/ParseTree";
import { TerminalNode } from "antlr4ts/tree/TerminalNode";
import {
  AliasContext,
  BlockContext,
  CatchBlockContext,
  ColumnExprAliasContext,
  ColumnExprAndContext,
  ColumnExprArrayAccessContext,
  ColumnExprArrayContext,
  ColumnExprAsteriskContext,
  ColumnExprBetweenContext,
  ColumnExprCallContext,
  ColumnExprCallSelectContext,
  ColumnExprCaseContext,
  ColumnExprDictContext,
  ColumnExprFunctionContext,
  ColumnExprIdentifierContext,
  ColumnExprIntervalContext,
  ColumnExprIsNullContext,
  ColumnExprListContext,
  ColumnExprLiteralContext,
  ColumnExprNegateContext,
  ColumnExprNotContext,
  ColumnExprNullArrayAccessContext,
  ColumnExprNullishContext,
  ColumnExprNullPropertyAccessContext,
  ColumnExprNullTupleAccessContext,
  ColumnExprOrContext,
  ColumnExprParensContext,
  ColumnExprPrecedence1Context,
  ColumnExprPrecedence2Context,
  ColumnExprPrecedence3Context,
  ColumnExprPropertyAccessContext,
  ColumnExprSubqueryContext,
  ColumnExprTemplateStringContext,
  ColumnExprTernaryOpContext,
  ColumnExprTupleAccessContext,
  ColumnExprTupleContext,
  ColumnExprWinFunctionContext,
  ColumnExprWinFunctionTargetContext,
  ColumnIdentifierContext,
  ColumnLambdaExprContext,
  DatabaseIdentifierContext,
  DeclarationContext,
  EmptyStmtContext,
  ExpressionContext,
  ExprStmtContext,
  ForInStmtContext,
  ForStmtContext,
  FrameBetweenContext,
  FrameStartContext,
  FromClauseContext,
  FullTemplateStringContext,
  FuncStmtContext,
  GroupByClauseContext,
  HavingClauseContext,
  IdentifierContext,
  IdentifierListContext,
  IfStmtContext,
  JoinConstraintClauseContext,
  JoinExprCrossOpContext,
  JoinExprOpContext,
  JoinExprParensContext,
  JoinExprTableContext,
  JoinOpFullContext,
  JoinOpInnerContext,
  JoinOpLeftRightContext,
  KvPairContext,
  KvPairListContext,
  LimitByClauseContext,
  LimitExprContext,
  LiteralContext,
  NestedIdentifierContext,
  NumberLiteralContext,
  OrderByClauseContext,
  OrderExprContext,
  OrderExprListContext,
  PlaceholderContext,
  PrewhereClauseContext,
  ProgramContext,
  RatioExprContext,
  ReturnStmtContext,
  SampleClauseContext,
  SelectContext,
  SelectSetStmtContext,
  SelectStmtContext,
  SelectStmtWithParensContext,
  StatementContext,
  StringContentsContext,
  StringContentsFullContext,
  StringContext,
  TableArgListContext,
  TableExprAliasContext,
  TableExprFunctionContext,
  TableExprIdentifierContext,
  TableExprPlaceholderContext,
  TableExprSubqueryContext,
  TableExprTagContext,
  TableFunctionExprContext,
  TableIdentifierContext,
  TemplateStringContext,
  ThrowStmtContext,
  TryCatchStmtContext,
  TSQLxChildElementContext,
  TSQLxTagAttributeContext,
  TSQLxTagElementContext,
  VarAssignmentContext,
  VarDeclContext,
  WhereClauseContext,
  WhileStmtContext,
  WindowExprContext,
  WinFrameBoundContext,
  WinFrameClauseContext,
  WinOrderByClauseContext,
  WinPartitionByClauseContext,
  WithClauseContext,
  WithExprColumnContext,
  WithExprListContext,
  WithExprSubqueryContext,
} from "../grammar/TSQLParser.js";
import { TSQLParserVisitor } from "../grammar/TSQLParserVisitor.js";
import {
  Alias,
  And,
  ArithmeticOperation,
  ArithmeticOperationOp,
  ArrayAccess,
  Array as ArrayExpression,
  AST,
  BetweenExpr,
  Block,
  Call,
  CompareOperation,
  CompareOperationOp,
  Constant,
  CTE,
  Declaration,
  Dict,
  Expr,
  ExprCall,
  Expression,
  ExprStatement,
  Field,
  ForInStatement,
  ForStatement,
  Function,
  HogQLXAttribute,
  HogQLXTag,
  IfStatement,
  JoinConstraint,
  JoinExpr,
  Lambda,
  LimitByExpr,
  Not,
  Or,
  OrderExpr,
  ParseResult,
  Placeholder,
  Program,
  RatioExpr,
  ReturnStatement,
  SampleExpr,
  SelectQuery,
  SelectSetNode,
  SelectSetQuery,
  SetOperator,
  Statement,
  ThrowStatement,
  TryCatchStatement,
  Tuple,
  TupleAccess,
  VariableAssignment,
  VariableDeclaration,
  WhileStatement,
  WindowExpr,
  WindowFrameExpr,
  WindowFunction,
} from "./ast";
import { RESERVED_KEYWORDS } from "./constants";
import { BaseHogQLError, NotImplementedError, SyntaxError } from "./errors";
import { parseStringLiteralText } from "./parse_string";

/**
 * Token with position information.
 * antlr4ts Token interface has startIndex/stopIndex, but runtime may also expose start/stop.
 * This type represents the union of both possibilities.
 */
type TokenWithPosition = Token & {
  start?: number;
  stop?: number;
};

/**
 * Extract start position from a token, handling both start and startIndex properties.
 */
function getTokenStart(token: Token | undefined): number | undefined {
  if (!token) return undefined;
  const tokenWithPos = token as TokenWithPosition;
  // Try start first (runtime property), then fall back to startIndex (type-safe property)
  return tokenWithPos.start ?? tokenWithPos.startIndex;
}

/**
 * Extract stop position from a token, handling both stop and stopIndex properties.
 */
function getTokenStop(token: Token | undefined): number | undefined {
  if (!token) return undefined;
  const tokenWithPos = token as TokenWithPosition;
  // Try stop first (runtime property), then fall back to stopIndex (type-safe property)
  return tokenWithPos.stop ?? tokenWithPos.stopIndex;
}

/**
 * Visitor that converts TSQL AST to a QueryConfig
 * The QueryConfig can then be used to build a ClickhouseQueryBuilder
 */
export class TSQLParseTreeConverter implements TSQLParserVisitor<any> {
  start?: number;

  constructor(start?: number) {
    this.start = start;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Typed visit helpers - these provide type-safe wrappers around the generic visit()
  // ─────────────────────────────────────────────────────────────────────────────

  /** Visit a column expression and return an Expression */
  private visitAsExpr(ctx: ParserRuleContext): Expression {
    return this.visit(ctx) as Expression;
  }

  /** Visit a join expression context */
  private visitJoin(ctx: ParserRuleContext): JoinExpr {
    return this.visit(ctx) as JoinExpr;
  }

  /** Visit an order expression list */
  private visitOrderList(ctx: ParserRuleContext): OrderExpr[] {
    return this.visit(ctx) as OrderExpr[];
  }

  /** Visit a window expression */
  private visitWindow(ctx: ParserRuleContext): WindowExpr {
    return this.visit(ctx) as WindowExpr;
  }

  /** Visit a ratio expression */
  private visitRatio(ctx: ParserRuleContext): RatioExpr {
    return this.visit(ctx) as RatioExpr;
  }

  /** Visit a CTE list */
  private visitCTEs(ctx: ParserRuleContext): Record<string, CTE> {
    return this.visit(ctx) as Record<string, CTE>;
  }

  /** Visit an expression list */
  private visitExprList(ctx: ParserRuleContext): Expression[] {
    return this.visit(ctx) as Expression[];
  }

  /** Visit a select statement */
  private visitSelectQuery(ctx: ParserRuleContext): SelectQuery | SelectSetQuery {
    return this.visit(ctx) as SelectQuery | SelectSetQuery;
  }

  /** Visit a placeholder */
  private visitPlaceholderExpr(ctx: ParserRuleContext): Placeholder {
    return this.visit(ctx) as Placeholder;
  }

  /** Visit and return a string (for identifiers, aliases) */
  private visitAsString(ctx: ParserRuleContext): string {
    return this.visit(ctx) as string;
  }

  /** Visit and return string array (for table identifiers, nested identifiers) */
  private visitStringArray(ctx: ParserRuleContext): string[] {
    return this.visit(ctx) as string[];
  }

  /** Visit a limit by expression */
  private visitLimitBy(ctx: ParserRuleContext): LimitByExpr {
    return this.visit(ctx) as LimitByExpr;
  }

  /** Visit a join operator and return the type string */
  private visitJoinOpString(ctx: ParserRuleContext): string {
    return this.visit(ctx) as string;
  }

  /** Visit a join constraint */
  private visitConstraint(ctx: ParserRuleContext): JoinConstraint {
    return this.visit(ctx) as JoinConstraint;
  }

  /** Visit a sample expression */
  private visitSample(ctx: ParserRuleContext): SampleExpr {
    return this.visit(ctx) as SampleExpr;
  }

  /** Visit a window frame expression */
  private visitFrame(ctx: ParserRuleContext): WindowFrameExpr | [WindowFrameExpr, WindowFrameExpr] {
    return this.visit(ctx) as WindowFrameExpr | [WindowFrameExpr, WindowFrameExpr];
  }

  /** Visit and return a Constant */
  private visitConst(ctx: ParserRuleContext): Constant {
    return this.visit(ctx) as Constant;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Core visitor methods
  // ─────────────────────────────────────────────────────────────────────────────

  visit(ctx: ParserRuleContext): ParseResult {
    const start = getTokenStart(ctx.start);
    const stop = getTokenStop(ctx.stop);
    const end = stop !== undefined ? stop + 1 : undefined;
    try {
      // Use accept() for proper visitor dispatch - this calls the correct visitXxx method
      // based on the runtime type of the context
      const node = ctx.accept(this);
      // Only set position if node is a valid object and we have position info
      if (
        node &&
        typeof node === "object" &&
        node !== null &&
        "start" in node &&
        this.start !== undefined
      ) {
        node.start = start;
        node.end = end;
      }
      return node;
    } catch (e: any) {
      if (e instanceof BaseHogQLError) {
        if (
          start !== undefined &&
          end !== undefined &&
          (e.start === undefined || e.end === undefined)
        ) {
          e.start = start;
          e.end = end;
        }
      }
      throw e;
    }
  }

  /**
   * Visit a parse tree node, dispatching to the appropriate visitor method.
   * Uses the accept method for proper double dispatch, which handles ErrorNode vs TerminalNode correctly.
   */
  private visitParseTree(node: ParseTree): any {
    // Use accept method for double dispatch - this will call the correct visit method
    // based on the actual runtime type of the node
    return node.accept(this);
  }

  visitChildren(ctx: ParserRuleContext): any {
    if (!ctx.children || ctx.children.length === 0) {
      return null;
    }

    const results: any[] = [];
    for (const child of ctx.children) {
      results.push(this.visitParseTree(child));
    }

    // Return single result if only one child, otherwise return array
    return results.length === 1 ? results[0] : results;
  }

  visitTerminal(node: TerminalNode): any {
    // Terminal nodes are leaf nodes (tokens) in the parse tree
    // Typically not needed for AST conversion, but required by interface
    return null;
  }

  visitErrorNode(node: ErrorNode): any {
    // Error nodes represent syntax errors in the parse tree
    // Throw a syntax error with position information
    const symbol = node.symbol;
    // ErrorNode has a symbol property with text
    const text = symbol?.text || "";
    const start = getTokenStart(symbol);
    const end = symbol ? (getTokenStop(symbol) ?? -1) + 1 : undefined;
    throw new SyntaxError(`Syntax error: ${text}`, {
      start,
      end,
    });
  }

  // Program and declarations
  visitProgram(ctx: ProgramContext): Program {
    const declarations: Declaration[] = [];
    // Implement based on your parser context structure
    throw new NotImplementedError("visitProgram not implemented");
  }

  visitDeclaration(ctx: DeclarationContext): Declaration {
    return this.visitChildren(ctx);
  }

  visitExpression(ctx: ExpressionContext): Expression {
    return this.visitChildren(ctx);
  }

  visitVarDecl(ctx: VarDeclContext): VariableDeclaration {
    const expr = ctx.expression();
    return {
      name: this.visitIdentifier(ctx.identifier()),
      expr: expr ? this.visitExpression(expr) : undefined,
    };
  }

  visitVarAssignment(ctx: VarAssignmentContext): VariableAssignment {
    return {
      left: this.visitExpression(ctx.expression(0)),
      right: this.visitExpression(ctx.expression(1)),
    };
  }

  visitStatement(ctx: StatementContext): Statement {
    return this.visitChildren(ctx);
  }

  visitExprStmt(ctx: ExprStmtContext): ExprStatement {
    return {
      expr: this.visitExpression(ctx.expression()),
    };
  }

  visitReturnStmt(ctx: ReturnStmtContext): ReturnStatement {
    const expr = ctx.expression();
    return {
      expr: expr ? this.visitExpression(expr) : undefined,
    };
  }

  visitThrowStmt(ctx: ThrowStmtContext): ThrowStatement {
    const expr = ctx.expression();
    return {
      expr: expr ? this.visitExpression(expr) : undefined,
    };
  }

  visitCatchBlock(ctx: CatchBlockContext): [string | null, string | null, Statement] {
    const catchVar = ctx._catchVar;
    const catchType = ctx._catchType;
    const catchStmt = ctx._catchStmt;
    if (!catchStmt) {
      throw new SyntaxError("Catch statement is required");
    }
    return [
      catchVar ? this.visitIdentifier(catchVar) : null,
      catchType ? this.visitIdentifier(catchType) : null,
      this.visitBlock(catchStmt),
    ];
  }

  visitTryCatchStmt(ctx: TryCatchStmtContext): TryCatchStatement {
    const tryStmt = ctx._tryStmt;
    const catchBlocks = ctx.catchBlock();
    const finallyStmt = ctx._finallyStmt;
    if (!tryStmt) {
      throw new SyntaxError("Try statement is required");
    }
    return {
      try_stmt: this.visitBlock(tryStmt),
      catches: catchBlocks.map((c: CatchBlockContext) => this.visitCatchBlock(c)),
      finally_stmt: finallyStmt ? this.visitBlock(finallyStmt) : undefined,
    };
  }

  visitIfStmt(ctx: IfStmtContext): IfStatement {
    return {
      expr: this.visitExpression(ctx.expression()),
      then: this.visitStatement(ctx.statement(0)),
      else_: ctx.statement(1) ? this.visitStatement(ctx.statement(1)) : undefined,
    };
  }

  visitWhileStmt(ctx: WhileStmtContext): WhileStatement {
    const statement = ctx.statement();
    if (!statement) {
      throw new SyntaxError("While statement body is required");
    }
    return {
      expr: this.visitExpression(ctx.expression()),
      body: this.visitStatement(statement),
    };
  }

  visitForInStmt(ctx: ForInStmtContext): ForInStatement {
    const firstIdentifier = this.visitIdentifier(ctx.identifier(0));
    const secondIdentifier = ctx.identifier(1) ? this.visitIdentifier(ctx.identifier(1)) : null;
    const statement = ctx.statement();
    if (!statement) {
      throw new SyntaxError("For in statement body is required");
    }
    return {
      valueVar: secondIdentifier ?? firstIdentifier,
      keyVar: secondIdentifier ? firstIdentifier : undefined,
      expr: this.visitExpression(ctx.expression()),
      body: this.visitStatement(statement),
    };
  }

  visitForStmt(ctx: ForStmtContext): ForStatement {
    const initializer =
      ctx._initializerVarDeclr || ctx._initializerVarAssignment || ctx._initializerExpression;
    const increment =
      ctx._incrementVarDeclr || ctx._incrementVarAssignment || ctx._incrementExpression;

    const statement = ctx.statement();
    if (!statement) {
      throw new SyntaxError("For statement body is required");
    }
    return {
      initializer: initializer ? this.visitVarDecl(initializer) : undefined,
      condition: this.visitExpression(ctx._condition),
      increment: this.visitVarDecl(increment),
      body: this.visitStatement(statement),
    };
  }

  visitFuncStmt(ctx: FuncStmtContext): Function {
    const params = ctx.identifierList();

    return {
      name: this.visitIdentifier(ctx.identifier()),
      params: params ? this.visitIdentifierList(params) : [],
      body: this.visitBlock(ctx.block()),
    };
  }

  visitKvPairList(ctx: KvPairListContext): [Expression, Expression][] {
    return ctx
      .kvPair()
      .map((kv: any) => [
        this.visitExpression(kv.expression(0)),
        this.visitExpression(kv.expression(1)),
      ]);
  }

  visitKvPair(ctx: KvPairContext): [Expression, Expression] {
    const exprs = ctx.expression();
    return [this.visitExpression(exprs[0]), this.visitExpression(exprs[1])];
  }

  visitIdentifierList(ctx: IdentifierListContext): string[] {
    return ctx.identifier().map((ident: any) => this.visitIdentifier(ident));
  }

  visitEmptyStmt(ctx: EmptyStmtContext): ExprStatement {
    return { expr: undefined };
  }

  visitBlock(ctx: BlockContext): Block {
    const declarations: Declaration[] = [];
    // Implement based on your parser structure
    throw new NotImplementedError("visitBlock not implemented");
  }

  // SELECT statements
  visitSelect(ctx: SelectContext): SelectQuery | SelectSetQuery | HogQLXTag {
    const selectSetStmt = ctx.selectSetStmt();
    const selectStmt = ctx.selectStmt();
    const tSQLxTagElement = ctx.tSQLxTagElement();
    if (selectSetStmt) {
      return this.visitSelectSetStmt(selectSetStmt);
    } else if (selectStmt) {
      return this.visitSelectStmt(selectStmt);
    } else if (tSQLxTagElement) {
      return this.visitHogqlxTagElementNested(tSQLxTagElement);
    }
    throw new SyntaxError(
      "Select statement must be either a select set statement, a select statement, or a tSQLx tag element"
    );
  }

  visitSelectSetStmt(ctx: SelectSetStmtContext): SelectQuery | SelectSetQuery {
    const selectQueries: SelectSetNode[] = [];
    const initialQuery = this.visitSelectStmtWithParens(ctx.selectStmtWithParens());

    for (const subsequent of ctx.subsequentSelectSetClause()) {
      let unionType: SetOperator;
      if (subsequent.UNION() && subsequent.ALL()) {
        unionType = "UNION ALL";
      } else if (subsequent.UNION() && subsequent.DISTINCT()) {
        unionType = "UNION DISTINCT";
      } else if (subsequent.INTERSECT() && subsequent.DISTINCT()) {
        unionType = "INTERSECT DISTINCT";
      } else if (subsequent.INTERSECT()) {
        unionType = "INTERSECT";
      } else if (subsequent.EXCEPT()) {
        unionType = "EXCEPT";
      } else {
        throw new SyntaxError(
          "Set operator must be one of UNION ALL, UNION DISTINCT, INTERSECT, INTERSECT DISTINCT, and EXCEPT"
        );
      }
      const selectQuery = this.visitSelectStmtWithParens(subsequent.selectStmtWithParens());
      // SelectSetNode expects SelectQuery | SelectSetQuery, but visitSelectStmtWithParens may return Placeholder
      // In practice, a Placeholder in this position would be substituted at runtime
      selectQueries.push({
        select_query: selectQuery as SelectQuery | SelectSetQuery,
        set_operator: unionType,
      });
    }

    if (selectQueries.length === 0) {
      // initialQuery may be Placeholder but we cast since SelectSetQuery expects SelectQuery | SelectSetQuery
      return initialQuery as SelectQuery | SelectSetQuery;
    }
    return {
      expression_type: "select_set_query",
      initial_select_query: initialQuery as SelectQuery | SelectSetQuery,
      subsequent_select_queries: selectQueries,
    };
  }

  visitSelectStmtWithParens(
    ctx: SelectStmtWithParensContext
  ): SelectQuery | SelectSetQuery | Placeholder {
    const selectStmt = ctx.selectStmt();
    const selectSetStmt = ctx.selectSetStmt();
    const placeholder = ctx.placeholder();
    if (selectStmt) {
      return this.visitSelectStmt(selectStmt);
    } else if (selectSetStmt) {
      return this.visitSelectSetStmt(selectSetStmt);
    } else if (placeholder) {
      return this.visitPlaceholder(placeholder);
    }
    throw new SyntaxError(
      "Select statement must be either a select statement, a select set statement, or a placeholder"
    );
  }

  visitSelectStmt(ctx: SelectStmtContext): SelectQuery {
    const withClause = ctx.withClause();
    const columnExprList = ctx.columnExprList();
    const fromClause = ctx.fromClause();
    const whereClause = ctx.whereClause();
    const prewhereClause = ctx.prewhereClause();
    const havingClause = ctx.havingClause();
    const groupByClause = ctx.groupByClause();
    const orderByClause = ctx.orderByClause();
    const limitByClause = ctx.limitByClause();
    const selectQuery: SelectQuery = {
      expression_type: "select_query",
      ctes: withClause ? this.visitWithClause(withClause) : undefined,
      select: columnExprList ? this.visitColumnExprList(columnExprList) : [],
      distinct: ctx.DISTINCT() ? true : undefined,
      select_from: fromClause ? this.visitJoin(fromClause) : undefined,
      where: whereClause ? this.visitAsExpr(whereClause) : undefined,
      prewhere: prewhereClause ? this.visitAsExpr(prewhereClause) : undefined,
      having: havingClause ? this.visitAsExpr(havingClause) : undefined,
      group_by: groupByClause ? this.visitExprList(groupByClause) : undefined,
      order_by: orderByClause ? this.visitOrderList(orderByClause) : undefined,
      limit_by: limitByClause ? this.visitLimitBy(limitByClause) : undefined,
    };

    const windowClause = ctx.windowClause();
    if (windowClause) {
      selectQuery.window_exprs = {};
      for (let index = 0; index < windowClause.windowExpr().length; index++) {
        const name = this.visitAsString(windowClause.identifier()[index]);
        selectQuery.window_exprs![name] = this.visitWindow(windowClause.windowExpr()[index]);
      }
    }

    const limitAndOffsetClause = ctx.limitAndOffsetClause();
    const offsetOnlyClause = ctx.offsetOnlyClause();
    if (limitAndOffsetClause) {
      // Use array access to avoid getRuleContext throwing when index is out of bounds
      const columnExprs = limitAndOffsetClause.columnExpr();
      if (columnExprs.length > 0) {
        selectQuery.limit = this.visitAsExpr(columnExprs[0]);
      }
      if (columnExprs.length > 1) {
        selectQuery.offset = this.visitAsExpr(columnExprs[1]);
      }
      if (limitAndOffsetClause.WITH() && limitAndOffsetClause.TIES()) {
        selectQuery.limit_with_ties = true;
      }
    } else if (offsetOnlyClause) {
      selectQuery.offset = this.visitAsExpr(offsetOnlyClause.columnExpr());
    }

    const arrayJoinClause = ctx.arrayJoinClause();
    if (arrayJoinClause) {
      if (!selectQuery.select_from) {
        throw new SyntaxError("Using ARRAY JOIN without a FROM clause is not permitted");
      }
      if (arrayJoinClause.LEFT()) {
        selectQuery.array_join_op = "LEFT ARRAY JOIN";
      } else if (arrayJoinClause.INNER()) {
        selectQuery.array_join_op = "INNER ARRAY JOIN";
      } else {
        selectQuery.array_join_op = "ARRAY JOIN";
      }
      selectQuery.array_join_list = this.visitExprList(arrayJoinClause.columnExprList());
      if (selectQuery.array_join_list) {
        for (const expr of selectQuery.array_join_list) {
          if (!("alias" in expr)) {
            throw new SyntaxError("ARRAY JOIN arrays must have an alias", {
              start: expr.start,
              end: expr.end,
            });
          }
        }
      }
    }

    if (ctx.topClause()) {
      throw new NotImplementedError("Unsupported: SelectStmt.topClause()");
    }
    if (ctx.settingsClause()) {
      throw new NotImplementedError("Unsupported: SelectStmt.settingsClause()");
    }

    return selectQuery;
  }

  visitWithClause(ctx: WithClauseContext): Record<string, CTE> {
    return this.visitCTEs(ctx.withExprList());
  }

  visitFromClause(ctx: FromClauseContext): JoinExpr {
    return this.visitJoin(ctx.joinExpr());
  }

  visitPrewhereClause(ctx: PrewhereClauseContext): Expr {
    return this.visitAsExpr(ctx.columnExpr());
  }

  visitWhereClause(ctx: WhereClauseContext): Expr {
    return this.visitAsExpr(ctx.columnExpr());
  }

  visitGroupByClause(ctx: GroupByClauseContext): Expr[] {
    const columnExprList = ctx.columnExprList();
    if (!columnExprList) {
      throw new SyntaxError("GROUP BY clause must have a column expression list");
    }
    return this.visitExprList(columnExprList);
  }

  visitHavingClause(ctx: HavingClauseContext): Expr {
    return this.visitAsExpr(ctx.columnExpr());
  }

  visitOrderByClause(ctx: OrderByClauseContext): OrderExpr[] {
    return this.visitOrderList(ctx.orderExprList());
  }

  visitLimitByClause(ctx: LimitByClauseContext): LimitByExpr {
    const limitExpr = this.visitLimitExprResult(ctx.limitExpr());

    // If limitExpr is a tuple (n, offset), split it
    if (Array.isArray(limitExpr)) {
      const [n, offsetValue] = limitExpr;
      return {
        expression_type: "limit_by_expr",
        n,
        offset_value: offsetValue,
        exprs: this.visitExprList(ctx.columnExprList()),
      };
    }

    // If no offset, just use limitExpr as n (TypeScript now knows it's Expression)
    return {
      expression_type: "limit_by_expr",
      n: limitExpr,
      offset_value: undefined,
      exprs: this.visitExprList(ctx.columnExprList()),
    };
  }

  /** Helper for visitLimitExpr which returns Expression | [Expression, Expression] */
  private visitLimitExprResult(ctx: LimitExprContext): Expression | [Expression, Expression] {
    return this.visitLimitExpr(ctx);
  }

  visitLimitExpr(ctx: LimitExprContext): Expression | [Expression, Expression] {
    const n = this.visitAsExpr(ctx.columnExpr(0));

    // Check if we have an offset (second expression)
    if (ctx.columnExpr(1)) {
      const offsetValue = this.visitAsExpr(ctx.columnExpr(1));
      // For "LIMIT a, b" syntax: a is offset, b is limit
      if (ctx.COMMA()) {
        return [offsetValue, n]; // Return tuple as (offset, limit)
      }
      // For "LIMIT a OFFSET b" syntax: a is limit, b is offset
      return [n, offsetValue];
    }

    return n;
  }

  // JOIN expressions
  visitJoinExprOp(ctx: JoinExprOpContext): JoinExpr {
    const join1: JoinExpr = this.visitJoin(ctx.joinExpr(0));
    const join2: JoinExpr = this.visitJoin(ctx.joinExpr(1));

    const joinOp = ctx.joinOp();
    if (joinOp) {
      join2.join_type = `${this.visitJoinOpString(joinOp)} JOIN`;
    } else {
      join2.join_type = "JOIN";
    }
    join2.constraint = this.visitConstraint(ctx.joinConstraintClause());

    let lastJoin = join1;
    while (lastJoin.next_join) {
      lastJoin = lastJoin.next_join;
    }
    lastJoin.next_join = join2;

    return join1;
  }

  visitJoinExprTable(ctx: JoinExprTableContext): JoinExpr {
    const sampleClause = ctx.sampleClause();
    const sample = sampleClause ? this.visitSample(sampleClause) : undefined;
    const tableResult = this.visitTableExprResult(ctx.tableExpr());
    const tableFinal = ctx.FINAL() ? true : undefined;
    // Check if result is already a JoinExpr (from visitTableExprAlias or visitTableExprFunction)
    if ("expression_type" in tableResult && tableResult.expression_type === "join_expr") {
      // visitTableExprAlias returns a JoinExpr to pass the alias
      // visitTableExprFunction returns a JoinExpr to pass the args
      tableResult.table_final = tableFinal;
      tableResult.sample = sample;
      return tableResult;
    }
    // Otherwise, wrap the table expression in a JoinExpr
    const table = tableResult as SelectQuery | SelectSetQuery | Placeholder | HogQLXTag | Field;
    return {
      expression_type: "join_expr",
      table,
      table_final: tableFinal,
      sample,
    };
  }

  /** Helper for visiting table expressions that may return JoinExpr or table types */
  private visitTableExprResult(
    ctx: ParserRuleContext
  ): JoinExpr | SelectQuery | SelectSetQuery | Placeholder | HogQLXTag | Field {
    return this.visit(ctx) as
      | JoinExpr
      | SelectQuery
      | SelectSetQuery
      | Placeholder
      | HogQLXTag
      | Field;
  }

  visitJoinExprParens(ctx: JoinExprParensContext): JoinExpr {
    return this.visitJoin(ctx.joinExpr());
  }

  visitJoinExprCrossOp(ctx: JoinExprCrossOpContext): JoinExpr {
    const join1: JoinExpr = this.visitJoin(ctx.joinExpr(0));
    const join2: JoinExpr = this.visitJoin(ctx.joinExpr(1));
    join2.join_type = "CROSS JOIN";
    let lastJoin = join1;
    while (lastJoin.next_join) {
      lastJoin = lastJoin.next_join;
    }
    lastJoin.next_join = join2;
    return join1;
  }

  visitJoinOpInner(ctx: JoinOpInnerContext): string {
    const tokens: string[] = [];
    if (ctx.ALL()) tokens.push("ALL");
    if (ctx.ANY()) tokens.push("ANY");
    if (ctx.ASOF()) tokens.push("ASOF");
    tokens.push("INNER");
    return tokens.join(" ");
  }

  visitJoinOpLeftRight(ctx: JoinOpLeftRightContext): string {
    const tokens: string[] = [];
    if (ctx.LEFT()) tokens.push("LEFT");
    if (ctx.RIGHT()) tokens.push("RIGHT");
    if (ctx.OUTER()) tokens.push("OUTER");
    if (ctx.SEMI()) tokens.push("SEMI");
    if (ctx.ALL()) tokens.push("ALL");
    if (ctx.ANTI()) tokens.push("ANTI");
    if (ctx.ANY()) tokens.push("ANY");
    if (ctx.ASOF()) tokens.push("ASOF");
    return tokens.join(" ");
  }

  visitJoinOpFull(ctx: JoinOpFullContext): string {
    const tokens: string[] = [];
    if (ctx.FULL()) tokens.push("FULL");
    if (ctx.OUTER()) tokens.push("OUTER");
    if (ctx.ALL()) tokens.push("ALL");
    if (ctx.ANY()) tokens.push("ANY");
    return tokens.join(" ");
  }

  visitJoinConstraintClause(ctx: JoinConstraintClauseContext): JoinConstraint {
    const columnExprList = this.visitExprList(ctx.columnExprList());
    if (columnExprList.length !== 1) {
      throw new NotImplementedError("Unsupported: JOIN ... ON with multiple expressions");
    }
    return {
      expression_type: "join_constraint",
      expr: columnExprList[0],
      constraint_type: ctx.USING() ? "USING" : "ON",
    };
  }

  visitSampleClause(ctx: SampleClauseContext): SampleExpr {
    const ratioExpressions = ctx.ratioExpr();
    const sampleRatioExpr = this.visitRatio(ratioExpressions[0]);
    const offsetRatioExpr =
      ratioExpressions.length > 1 && ctx.OFFSET()
        ? this.visitRatio(ratioExpressions[1])
        : undefined;

    return {
      expression_type: "sample_expr",
      sample_value: sampleRatioExpr,
      offset_value: offsetRatioExpr,
    };
  }

  visitOrderExprList(ctx: OrderExprListContext): OrderExpr[] {
    return ctx.orderExpr().map((expr: OrderExprContext) => this.visitOrderExpr(expr));
  }

  visitOrderExpr(ctx: OrderExprContext): OrderExpr {
    const order = ctx.DESC() || ctx.DESCENDING() ? "DESC" : "ASC";
    return {
      expression_type: "order_expr",
      expr: this.visitAsExpr(ctx.columnExpr()),
      order: order as "ASC" | "DESC",
    };
  }

  visitRatioExpr(ctx: RatioExprContext): RatioExpr {
    const placeholder = ctx.placeholder();
    if (placeholder) {
      return this.visitPlaceholderExpr(placeholder) as unknown as RatioExpr;
    }

    const numberLiterals = ctx.numberLiteral();
    const left = numberLiterals[0];
    const right = ctx.SLASH() && numberLiterals.length > 1 ? numberLiterals[1] : null;

    return {
      expression_type: "ratio_expr",
      left: this.visitNumberLiteral(left),
      right: right ? this.visitNumberLiteral(right) : undefined,
    };
  }

  visitWindowExpr(ctx: WindowExprContext): WindowExpr {
    const frame = ctx.winFrameClause();
    const visitedFrame = frame ? this.visitFrame(frame) : undefined;
    const partitionByClause = ctx.winPartitionByClause();
    const orderByClause = ctx.winOrderByClause();
    return {
      expression_type: "window_expr",
      partition_by: partitionByClause ? this.visitExprList(partitionByClause) : undefined,
      order_by: orderByClause ? this.visitOrderList(orderByClause) : undefined,
      frame_method: frame && frame.RANGE() ? "RANGE" : frame && frame.ROWS() ? "ROWS" : undefined,
      frame_start: Array.isArray(visitedFrame) ? visitedFrame[0] : visitedFrame,
      frame_end: Array.isArray(visitedFrame) ? visitedFrame[1] : undefined,
    };
  }

  visitWinPartitionByClause(ctx: WinPartitionByClauseContext): Expr[] {
    return this.visitExprList(ctx.columnExprList());
  }

  visitWinOrderByClause(ctx: WinOrderByClauseContext): OrderExpr[] {
    return this.visitOrderList(ctx.orderExprList());
  }

  visitWinFrameClause(
    ctx: WinFrameClauseContext
  ): WindowFrameExpr | [WindowFrameExpr, WindowFrameExpr] {
    return this.visitFrame(ctx.winFrameExtend());
  }

  visitFrameStart(ctx: FrameStartContext): WindowFrameExpr {
    return this.visitFrameBound(ctx.winFrameBound());
  }

  visitFrameBetween(ctx: FrameBetweenContext): [WindowFrameExpr, WindowFrameExpr] {
    return [this.visitFrameBound(ctx.winFrameBound(0)), this.visitFrameBound(ctx.winFrameBound(1))];
  }

  /** Helper for visiting a single frame bound */
  private visitFrameBound(ctx: WinFrameBoundContext): WindowFrameExpr {
    return this.visitWinFrameBound(ctx);
  }

  visitWinFrameBound(ctx: WinFrameBoundContext): WindowFrameExpr {
    if (ctx.PRECEDING()) {
      const numberLiteral = ctx.numberLiteral();
      return {
        expression_type: "window_frame_expr",
        frame_type: "PRECEDING",
        frame_value: numberLiteral ? this.visitNumberLiteral(numberLiteral).value : undefined,
      };
    }
    if (ctx.FOLLOWING()) {
      const numberLiteral = ctx.numberLiteral();
      return {
        expression_type: "window_frame_expr",
        frame_type: "FOLLOWING",
        frame_value: numberLiteral ? this.visitNumberLiteral(numberLiteral).value : undefined,
      };
    }
    return { expression_type: "window_frame_expr", frame_type: "CURRENT ROW" };
  }

  // Column expressions
  visitColumnExprList(ctx: ColumnExprListContext): Expression[] {
    return ctx.columnExpr().map((c: ParserRuleContext) => this.visitAsExpr(c));
  }

  visitColumnExprTernaryOp(ctx: ColumnExprTernaryOpContext): Call {
    return {
      expression_type: "call",
      name: "if",
      args: [
        this.visitAsExpr(ctx.columnExpr(0)),
        this.visitAsExpr(ctx.columnExpr(1)),
        this.visitAsExpr(ctx.columnExpr(2)),
      ],
    };
  }

  visitColumnExprAlias(ctx: ColumnExprAliasContext): Alias {
    let alias: string;
    const identifier = ctx.identifier();
    const stringLiteral = ctx.STRING_LITERAL();
    if (identifier) {
      alias = this.visitIdentifier(identifier);
    } else if (stringLiteral) {
      alias = parseStringLiteralText(stringLiteral.text);
    } else {
      throw new SyntaxError("Must specify an alias");
    }
    const expr = this.visitAsExpr(ctx.columnExpr());

    if (RESERVED_KEYWORDS.includes(alias.toLowerCase() as any)) {
      throw new SyntaxError(
        `"${alias}" cannot be an alias or identifier, as it's a reserved keyword`
      );
    }

    return { expression_type: "alias", expr, alias };
  }

  visitColumnExprNegate(ctx: ColumnExprNegateContext): ArithmeticOperation {
    return {
      expression_type: "arithmetic_operation",
      op: ArithmeticOperationOp.Sub,
      left: { value: 0 } as Constant,
      right: this.visitAsExpr(ctx.columnExpr()),
    };
  }

  visitColumnExprDict(ctx: ColumnExprDictContext): Dict {
    const kvPairList = ctx.kvPairList();
    return {
      expression_type: "dict",
      items: kvPairList ? this.visitKvPairList(kvPairList) : [],
    };
  }

  visitColumnExprSubquery(ctx: ColumnExprSubqueryContext): SelectQuery | SelectSetQuery {
    return this.visitSelectQuery(ctx.selectSetStmt());
  }

  visitColumnExprLiteral(ctx: ColumnExprLiteralContext): Expr {
    return this.visitChildren(ctx);
  }

  visitColumnExprArray(ctx: ColumnExprArrayContext): ArrayExpression {
    const columnExprList = ctx.columnExprList();
    return {
      expression_type: "array",
      exprs: columnExprList ? this.visitExprList(columnExprList) : [],
    };
  }

  visitColumnExprPrecedence1(ctx: ColumnExprPrecedence1Context): ArithmeticOperation {
    let op: ArithmeticOperationOp;
    if (ctx.SLASH()) {
      op = ArithmeticOperationOp.Div;
    } else if (ctx.ASTERISK()) {
      op = ArithmeticOperationOp.Mult;
    } else if (ctx.PERCENT()) {
      op = ArithmeticOperationOp.Mod;
    } else {
      throw new NotImplementedError(`Unsupported ColumnExprPrecedence1: ${ctx.text}`);
    }
    // Use columnExpr() method to get left and right operands
    const left = this.visitAsExpr(ctx.columnExpr(0));
    const right = this.visitAsExpr(ctx.columnExpr(1));
    return { expression_type: "arithmetic_operation", left, right, op };
  }

  visitColumnExprPrecedence2(ctx: ColumnExprPrecedence2Context): ArithmeticOperation | Call {
    // Use columnExpr() method to get left and right operands
    const left = this.visitAsExpr(ctx.columnExpr(0));
    const right = this.visitAsExpr(ctx.columnExpr(1));

    if (ctx.PLUS()) {
      return {
        expression_type: "arithmetic_operation",
        left,
        right,
        op: ArithmeticOperationOp.Add,
      };
    } else if (ctx.DASH()) {
      return {
        expression_type: "arithmetic_operation",
        left,
        right,
        op: ArithmeticOperationOp.Sub,
      };
    } else if (ctx.CONCAT()) {
      const args: Expression[] = [];
      if ("name" in left && left.name === "concat" && "args" in left && left.args) {
        args.push(...left.args);
      } else {
        args.push(left);
      }

      if ("name" in right && right.name === "concat" && "args" in right && right.args) {
        args.push(...right.args);
      } else {
        args.push(right);
      }

      return { expression_type: "call", name: "concat", args };
    } else {
      throw new NotImplementedError(`Unsupported ColumnExprPrecedence2: ${ctx.text}`);
    }
  }

  visitColumnExprPrecedence3(ctx: ColumnExprPrecedence3Context): CompareOperation {
    // Use columnExpr() method to get left and right operands
    const left = this.visitAsExpr(ctx.columnExpr(0));
    const right = this.visitAsExpr(ctx.columnExpr(1));

    let op: CompareOperationOp;
    if (ctx.EQ_SINGLE() || ctx.EQ_DOUBLE()) {
      op = CompareOperationOp.Eq;
    } else if (ctx.NOT_EQ()) {
      op = CompareOperationOp.NotEq;
    } else if (ctx.LT()) {
      op = CompareOperationOp.Lt;
    } else if (ctx.LT_EQ()) {
      op = CompareOperationOp.LtEq;
    } else if (ctx.GT()) {
      op = CompareOperationOp.Gt;
    } else if (ctx.GT_EQ()) {
      op = CompareOperationOp.GtEq;
    } else if (ctx.LIKE()) {
      op = ctx.NOT() ? CompareOperationOp.NotLike : CompareOperationOp.Like;
    } else if (ctx.ILIKE()) {
      op = ctx.NOT() ? CompareOperationOp.NotILike : CompareOperationOp.ILike;
    } else if (ctx.REGEX_SINGLE() || ctx.REGEX_DOUBLE()) {
      op = CompareOperationOp.Regex;
    } else if (ctx.NOT_REGEX()) {
      op = CompareOperationOp.NotRegex;
    } else if (ctx.IREGEX_SINGLE() || ctx.IREGEX_DOUBLE()) {
      op = CompareOperationOp.IRegex;
    } else if (ctx.NOT_IREGEX()) {
      op = CompareOperationOp.NotIRegex;
    } else if (ctx.IN()) {
      if (ctx.COHORT()) {
        op = ctx.NOT() ? CompareOperationOp.NotInCohort : CompareOperationOp.InCohort;
      } else {
        op = ctx.NOT() ? CompareOperationOp.NotIn : CompareOperationOp.In;
      }
    } else {
      throw new NotImplementedError(`Unsupported ColumnExprPrecedence3: ${ctx.text}`);
    }

    return { expression_type: "compare_operation", left, right, op };
  }

  visitColumnExprInterval(ctx: ColumnExprIntervalContext): Call {
    let name: string;
    const interval = ctx.interval();
    if (interval.SECOND()) {
      name = "toIntervalSecond";
    } else if (interval.MINUTE()) {
      name = "toIntervalMinute";
    } else if (interval.HOUR()) {
      name = "toIntervalHour";
    } else if (interval.DAY()) {
      name = "toIntervalDay";
    } else if (interval.WEEK()) {
      name = "toIntervalWeek";
    } else if (interval.MONTH()) {
      name = "toIntervalMonth";
    } else if (interval.QUARTER()) {
      name = "toIntervalQuarter";
    } else if (interval.YEAR()) {
      name = "toIntervalYear";
    } else {
      throw new NotImplementedError(`Unsupported interval type: ${interval.text}`);
    }

    return { expression_type: "call", name, args: [this.visitAsExpr(ctx.columnExpr())] };
  }

  visitColumnExprIsNull(ctx: ColumnExprIsNullContext): CompareOperation {
    return {
      expression_type: "compare_operation",
      left: this.visitAsExpr(ctx.columnExpr()),
      right: { value: null } as Constant,
      op: ctx.NOT() ? CompareOperationOp.NotEq : CompareOperationOp.Eq,
    };
  }

  visitColumnExprTuple(ctx: ColumnExprTupleContext): Tuple {
    const columnExprList = ctx.columnExprList();
    return {
      expression_type: "tuple",
      exprs: columnExprList ? this.visitExprList(columnExprList) : [],
    };
  }

  visitColumnExprArrayAccess(ctx: ColumnExprArrayAccessContext): ArrayAccess {
    const object: Expression = this.visitAsExpr(ctx.columnExpr(0));
    const property: Expression = this.visitAsExpr(ctx.columnExpr(1));
    return { expression_type: "array_access", array: object, property };
  }

  visitColumnExprNullArrayAccess(ctx: ColumnExprNullArrayAccessContext): ArrayAccess {
    const object: Expression = this.visitAsExpr(ctx.columnExpr(0));
    const property: Expression = this.visitAsExpr(ctx.columnExpr(1));
    return { expression_type: "array_access", array: object, property, nullish: true };
  }

  visitColumnExprPropertyAccess(ctx: ColumnExprPropertyAccessContext): ArrayAccess {
    const object = this.visitAsExpr(ctx.columnExpr());
    const property: Constant = {
      expression_type: "constant",
      value: this.visitIdentifier(ctx.identifier()),
    };
    return { expression_type: "array_access", array: object, property };
  }

  visitColumnExprNullPropertyAccess(ctx: ColumnExprNullPropertyAccessContext): ArrayAccess {
    const object = this.visitAsExpr(ctx.columnExpr());
    const property: Constant = {
      expression_type: "constant",
      value: this.visitIdentifier(ctx.identifier()),
    };
    return { expression_type: "array_access", array: object, property, nullish: true };
  }

  visitColumnExprBetween(ctx: ColumnExprBetweenContext): BetweenExpr {
    return {
      expression_type: "between_expr",
      expr: this.visitAsExpr(ctx.columnExpr(0)),
      low: this.visitAsExpr(ctx.columnExpr(1)),
      high: this.visitAsExpr(ctx.columnExpr(2)),
      negated: !!ctx.NOT(),
    };
  }

  visitColumnExprParens(ctx: ColumnExprParensContext): Expr {
    return this.visitAsExpr(ctx.columnExpr());
  }

  visitColumnExprAnd(ctx: ColumnExprAndContext): And {
    const left = this.visitAsExpr(ctx.columnExpr(0));
    const leftArray = "exprs" in left && left.exprs ? left.exprs : [left];

    const right = this.visitAsExpr(ctx.columnExpr(1));
    const rightArray = "exprs" in right && right.exprs ? right.exprs : [right];

    return { expression_type: "and", exprs: [...leftArray, ...rightArray] };
  }

  visitColumnExprOr(ctx: ColumnExprOrContext): Or {
    const left = this.visitAsExpr(ctx.columnExpr(0));
    const leftArray = "exprs" in left && left.exprs ? left.exprs : [left];

    const right = this.visitAsExpr(ctx.columnExpr(1));
    const rightArray = "exprs" in right && right.exprs ? right.exprs : [right];

    return { expression_type: "or", exprs: [...leftArray, ...rightArray] };
  }

  visitColumnExprTupleAccess(ctx: ColumnExprTupleAccessContext): TupleAccess {
    const tuple = this.visitAsExpr(ctx.columnExpr());
    const index = parseInt(ctx.DECIMAL_LITERAL().text);
    return { expression_type: "tuple_access", tuple, index };
  }

  visitColumnExprNullTupleAccess(ctx: ColumnExprNullTupleAccessContext): TupleAccess {
    const tuple = this.visitAsExpr(ctx.columnExpr());
    const index = parseInt(ctx.DECIMAL_LITERAL().text);
    return { expression_type: "tuple_access", tuple, index, nullish: true };
  }

  visitColumnExprCase(ctx: ColumnExprCaseContext): Call {
    const columns = ctx
      .columnExpr()
      .map((column: ParserRuleContext) => this.visitAsExpr(column) as Expression);
    if (ctx._caseExpr) {
      const args: (Expression | undefined)[] = [
        columns[0],
        { expression_type: "array", exprs: [] },
        { expression_type: "array", exprs: [] },
        undefined,
        columns[columns.length - 1],
      ];
      for (let index = 1; index < columns.length - 1; index++) {
        const arrayIndex = ((index - 1) % 2) + 1;
        (args[arrayIndex] as ArrayExpression).exprs.push(columns[index]);
      }
      return { expression_type: "call", name: "transform", args: args as Expression[] };
    } else if (columns.length === 3) {
      return { expression_type: "call", name: "if", args: columns };
    } else {
      return { expression_type: "call", name: "multiIf", args: columns };
    }
  }

  visitColumnExprNot(ctx: ColumnExprNotContext): Not {
    return { expression_type: "not", expr: this.visitAsExpr(ctx.columnExpr()) };
  }

  visitColumnExprWinFunctionTarget(ctx: ColumnExprWinFunctionTargetContext): WindowFunction {
    return {
      expression_type: "window_function",
      name: this.visitIdentifier(ctx.identifier(0)),
      exprs: ctx._columnExprs ? this.visitExprList(ctx._columnExprs) : [],
      args: ctx._columnArgList ? this.visitExprList(ctx._columnArgList) : [],
      over_identifier: this.visitIdentifier(ctx.identifier(1)),
    };
  }

  visitColumnExprWinFunction(ctx: ColumnExprWinFunctionContext): WindowFunction {
    const windowExpr = ctx.windowExpr();
    return {
      expression_type: "window_function",
      name: this.visitIdentifier(ctx.identifier()),
      exprs: ctx._columnExprs ? this.visitExprList(ctx._columnExprs) : [],
      args: ctx._columnArgList ? this.visitExprList(ctx._columnArgList) : [],
      over_expr: windowExpr ? this.visitWindowExpr(windowExpr) : undefined,
    };
  }

  visitColumnExprIdentifier(ctx: ColumnExprIdentifierContext): Expr {
    return this.visitColumnIdentifier(ctx.columnIdentifier());
  }

  visitColumnExprFunction(ctx: ColumnExprFunctionContext): Call {
    const name = this.visitIdentifier(ctx.identifier());

    let parameters: Expression[] | undefined = ctx._columnExprs
      ? this.visitExprList(ctx._columnExprs)
      : undefined;
    // two sets of parameters fn()(), return an empty list for the first even if no parameters
    if (ctx.LPAREN && ctx.LPAREN().length > 1 && parameters === undefined) {
      parameters = [];
    }

    const args: Expression[] = ctx._columnArgList ? this.visitExprList(ctx._columnArgList) : [];
    const distinct = ctx.DISTINCT() ? true : false;
    return { expression_type: "call", name, params: parameters, args, distinct };
  }

  visitColumnExprAsterisk(ctx: ColumnExprAsteriskContext): Field {
    const tableIdentifier = ctx.tableIdentifier();
    if (tableIdentifier) {
      const table = this.visitStringArray(tableIdentifier);
      return { expression_type: "field", chain: [...table, "*"] };
    }
    return { expression_type: "field", chain: ["*"] };
  }

  visitColumnLambdaExpr(ctx: ColumnLambdaExprContext): Lambda {
    const columnExpr = ctx.columnExpr();
    const block = ctx.block();
    let expr: Expression | Block;
    if (columnExpr) {
      expr = this.visitAsExpr(columnExpr);
    } else if (block) {
      expr = this.visitBlock(block) as Block;
    } else {
      throw new SyntaxError("Lambda expression must have either an expression or a block");
    }
    return {
      expression_type: "lambda",
      args: ctx
        .identifier()
        .map((identifier: IdentifierContext) => this.visitIdentifier(identifier)),
      expr,
    };
  }

  visitWithExprList(ctx: WithExprListContext): Record<string, CTE> {
    const ctes: Record<string, CTE> = {};
    for (const expr of ctx.withExpr()) {
      const cte = this.visitCTE(expr);
      ctes[cte.name] = cte;
    }
    return ctes;
  }

  /** Helper to visit a CTE expression */
  private visitCTE(ctx: ParserRuleContext): CTE {
    return this.visit(ctx) as CTE;
  }

  visitWithExprSubquery(ctx: WithExprSubqueryContext): CTE {
    const subquery = this.visitSelectQuery(ctx.selectSetStmt());
    const name = this.visitIdentifier(ctx.identifier());
    return { expression_type: "cte", name, expr: subquery, cte_type: "subquery" };
  }

  visitWithExprColumn(ctx: WithExprColumnContext): CTE {
    const expr = this.visitAsExpr(ctx.columnExpr());
    const name = this.visitIdentifier(ctx.identifier());
    return { expression_type: "cte", name, expr, cte_type: "column" };
  }

  visitColumnIdentifier(ctx: ColumnIdentifierContext): Expression {
    const placeholder = ctx.placeholder();
    if (placeholder) {
      return this.visitPlaceholder(placeholder);
    }

    const tableIdentifier = ctx.tableIdentifier();
    const table = tableIdentifier ? this.visitTableIdentifier(tableIdentifier) : [];

    const nestedIdentifier = ctx.nestedIdentifier();
    const nested = nestedIdentifier ? this.visitNestedIdentifier(nestedIdentifier) : [];

    if (table.length === 0 && nested.length > 0) {
      const text = ctx.text.toLowerCase();
      if (text === "true") {
        return { expression_type: "constant", value: true };
      }
      if (text === "false") {
        return { expression_type: "constant", value: false };
      }
      return { expression_type: "field", chain: nested };
    }

    return { expression_type: "field", chain: [...table, ...nested] };
  }

  visitNestedIdentifier(ctx: NestedIdentifierContext): string[] {
    return ctx
      .identifier()
      .map((identifier: IdentifierContext) => this.visitIdentifier(identifier));
  }

  visitTableExprIdentifier(ctx: TableExprIdentifierContext): Field {
    const chain = this.visitTableIdentifier(ctx.tableIdentifier());
    return { expression_type: "field", chain };
  }

  visitTableExprSubquery(ctx: TableExprSubqueryContext): SelectQuery | SelectSetQuery {
    return this.visitSelectQuery(ctx.selectSetStmt());
  }

  visitTableExprPlaceholder(ctx: TableExprPlaceholderContext): Placeholder {
    return this.visitPlaceholder(ctx.placeholder());
  }

  visitTableExprAlias(ctx: TableExprAliasContext): JoinExpr {
    const exp = ctx.alias() || ctx.identifier();
    if (!exp) {
      throw new SyntaxError("Must specify an alias");
    }
    const alias: string =
      exp instanceof AliasContext
        ? this.visitAlias(exp)
        : this.visitIdentifier(exp as IdentifierContext);
    if (RESERVED_KEYWORDS.includes(alias.toLowerCase() as any)) {
      throw new SyntaxError(
        `"${alias}" cannot be an alias or identifier, as it's a reserved keyword`
      );
    }
    const tableResult = this.visitTableExprResult(ctx.tableExpr());
    // Check if result is already a JoinExpr
    if ("expression_type" in tableResult && tableResult.expression_type === "join_expr") {
      tableResult.alias = alias;
      return tableResult;
    }
    // Otherwise, wrap in a JoinExpr
    const table = tableResult as SelectQuery | SelectSetQuery | Placeholder | HogQLXTag | Field;
    return { expression_type: "join_expr", table, alias };
  }

  visitTableExprFunction(ctx: TableExprFunctionContext): JoinExpr {
    return this.visitTableFunctionExpr(ctx.tableFunctionExpr());
  }

  visitTableExprTag(ctx: TableExprTagContext): HogQLXTag {
    return this.visitHogqlxTagElementNested(ctx.tSQLxTagElement());
  }

  visitTableFunctionExpr(ctx: TableFunctionExprContext): JoinExpr {
    const name = this.visitIdentifier(ctx.identifier());
    const tableArgList = ctx.tableArgList();
    const args = tableArgList ? this.visitTableArgList(tableArgList) : [];
    return {
      expression_type: "join_expr",
      table: { expression_type: "field", chain: [name] },
      table_args: args,
    };
  }

  visitTableIdentifier(ctx: TableIdentifierContext): string[] {
    const nestedIdentifier = ctx.nestedIdentifier();
    const nested = nestedIdentifier ? this.visitNestedIdentifier(nestedIdentifier) : [];
    // Ensure nested is always an array
    const nestedArray = Array.isArray(nested) ? nested : nested ? [nested] : [];

    const databaseIdentifier = ctx.databaseIdentifier();
    if (databaseIdentifier) {
      const dbId = this.visitDatabaseIdentifier(databaseIdentifier);
      return [dbId, ...nestedArray];
    }

    return nestedArray;
  }

  visitTableArgList(ctx: TableArgListContext): Expression[] {
    return ctx.columnExpr().map((arg: ParserRuleContext) => this.visitAsExpr(arg));
  }

  visitDatabaseIdentifier(ctx: DatabaseIdentifierContext): string {
    return this.visitIdentifier(ctx.identifier());
  }

  visitNumberLiteral(ctx: NumberLiteralContext): Constant {
    const text = ctx.text.toLowerCase();
    if (
      text.includes(".") ||
      text.includes("e") ||
      text === "-inf" ||
      text === "inf" ||
      text === "nan"
    ) {
      return { expression_type: "constant", value: parseFloat(text) };
    }
    return { expression_type: "constant", value: parseInt(text) };
  }

  visitLiteral(ctx: LiteralContext): Constant {
    if (ctx.NULL_SQL()) {
      return { expression_type: "constant", value: null };
    }

    const stringLiteral = ctx.STRING_LITERAL();
    if (stringLiteral) {
      // STRING_LITERAL() returns a TerminalNode, which has getText()
      const text = parseStringLiteralText(stringLiteral.text);
      return { expression_type: "constant", value: text };
    }

    const numberLiteral = ctx.numberLiteral();
    if (numberLiteral) {
      return this.visitNumberLiteral(numberLiteral);
    }
    return this.visitChildren(ctx);
  }

  visitAlias(ctx: AliasContext): string {
    let text = ctx.text;
    if (
      text.length >= 2 &&
      ((text.startsWith("`") && text.endsWith("`")) || (text.startsWith('"') && text.endsWith('"')))
    ) {
      text = parseStringLiteralText(text);
    }
    return text;
  }

  visitIdentifier(ctx: IdentifierContext): string {
    // IdentifierContext is a ParserRuleContext that has IDENTIFIER() method returning TerminalNode
    // If ctx has IDENTIFIER() method, extract the terminal node
    if (ctx.IDENTIFIER && typeof ctx.IDENTIFIER === "function") {
      const terminalNode = ctx.IDENTIFIER();
      if (terminalNode) {
        // TerminalNode has getText() at runtime but types don't expose it
        // Use symbol.text as fallback
        let text = (terminalNode as any).getText?.() || terminalNode.symbol?.text || "";
        if (
          text.length >= 2 &&
          ((text.startsWith("`") && text.endsWith("`")) ||
            (text.startsWith('"') && text.endsWith('"')))
        ) {
          text = parseStringLiteralText(text);
        }
        return text;
      }
    }

    // If it's already a string
    if (typeof ctx === "string") {
      return ctx;
    }
    // Fallback: if it's a ParserRuleContext, use getText()
    let text = ctx.text;
    if (
      text.length >= 2 &&
      ((text.startsWith("`") && text.endsWith("`")) || (text.startsWith('"') && text.endsWith('"')))
    ) {
      text = parseStringLiteralText(text);
    }
    return text;
  }

  visitColumnExprNullish(ctx: ColumnExprNullishContext): Call {
    return {
      expression_type: "call",
      name: "ifNull",
      args: [this.visitAsExpr(ctx.columnExpr(0)), this.visitAsExpr(ctx.columnExpr(1))],
    };
  }

  visitColumnExprCall(ctx: ColumnExprCallContext): ExprCall {
    const columnExprList = ctx.columnExprList();
    return {
      expression_type: "expr_call",
      expr: this.visitAsExpr(ctx.columnExpr()),
      args: columnExprList ? this.visitExprList(columnExprList) : [],
    };
  }

  visitColumnExprCallSelect(ctx: ColumnExprCallSelectContext): Call | ExprCall {
    const expr = this.visitAsExpr(ctx.columnExpr());
    if ("chain" in expr && expr.chain && expr.chain.length === 1) {
      return {
        expression_type: "call",
        name: String(expr.chain[0]),
        args: [this.visitSelectQuery(ctx.selectSetStmt())],
      };
    }
    return {
      expression_type: "expr_call",
      expr,
      args: [this.visitSelectQuery(ctx.selectSetStmt())],
    };
  }

  visitHogqlxChildElement(ctx: TSQLxChildElementContext): Expression {
    const tSQLxTagElement = ctx.tSQLxTagElement();
    if (tSQLxTagElement) {
      return this.visitHogqlxTagElementNested(tSQLxTagElement);
    }
    if (ctx.TSQLX_TEXT_TEXT()) {
      return this.visitHogqlxText(ctx);
    }
    return this.visitAsExpr(ctx.columnExpr()!);
  }

  visitHogqlxText(ctx: TSQLxChildElementContext): Constant {
    const text = ctx.TSQLX_TEXT_TEXT();
    return { expression_type: "constant", value: text ? text.text : "" };
  }

  visitHogqlxTagElementClosed(ctx: TSQLxTagElementContext): HogQLXTag {
    const kind = this.visitIdentifier(ctx.identifier()[0]);
    const attributes = ctx.tSQLxTagAttribute()
      ? ctx
          .tSQLxTagAttribute()
          .map((a: TSQLxTagAttributeContext) => this.visitHogqlxTagAttribute(a))
      : [];
    return { expression_type: "hogqlx_tag", kind, attributes };
  }

  visitHogqlxTagElementNested(ctx: TSQLxTagElementContext): HogQLXTag {
    const opening = this.visitIdentifier(ctx.identifier(0));
    const closing = this.visitIdentifier(ctx.identifier(1));
    if (opening !== closing) {
      throw new SyntaxError(
        `Opening and closing HogQLX tags must match. Got ${opening} and ${closing}`
      );
    }

    const attributes = ctx.tSQLxTagAttribute()
      ? ctx
          .tSQLxTagAttribute()
          .map((a: TSQLxTagAttributeContext) => this.visitHogqlxTagAttribute(a))
      : [];

    // ── collect child nodes, discarding pure-indentation whitespace ──
    const keptChildren: Expression[] = [];
    for (const element of ctx.tSQLxChildElement()) {
      const child = this.visitHogqlxChildElement(element);

      if ("value" in child && typeof child.value === "string") {
        const v = child.value;
        const onlyWs = /^\s*$/.test(v);
        const hasNl = v.includes("\n") || v.includes("\r");
        if (onlyWs && hasNl) {
          continue; // drop indentation text node
        }
      }

      keptChildren.push(child);
    }

    if (keptChildren.length > 0) {
      if (attributes.some((a: HogQLXAttribute) => a.name === "children")) {
        throw new SyntaxError(
          "Can't have a HogQLX tag with both children and a 'children' attribute"
        );
      }
      attributes.push({ name: "children", value: keptChildren });
    }

    return { expression_type: "hogqlx_tag", kind: opening, attributes };
  }

  visitHogqlxTagAttribute(ctx: TSQLxTagAttributeContext): HogQLXAttribute {
    const name = this.visitIdentifier(ctx.identifier());
    const columnExpr = ctx.columnExpr();
    const string = ctx.string();
    if (columnExpr) {
      return { name, value: this.visitAsExpr(columnExpr) };
    } else if (string) {
      return { name, value: this.visitStringExpr(string) };
    } else {
      return { name, value: { expression_type: "constant", value: true } as Constant };
    }
  }

  visitPlaceholder(ctx: PlaceholderContext): Placeholder {
    return { expression_type: "placeholder", expr: this.visitAsExpr(ctx.columnExpr()) };
  }

  visitColumnExprTemplateString(ctx: ColumnExprTemplateStringContext): Expr {
    return this.visitTemplateString(ctx.templateString());
  }

  /** Helper to visit a string context that returns Constant | Expr */
  private visitStringExpr(ctx: StringContext): Constant | Expr {
    return this.visitStringLiteral(ctx);
  }

  visitStringLiteral(ctx: StringContext): Constant | Expr {
    const stringLiteral = ctx.STRING_LITERAL();
    if (stringLiteral) {
      return { expression_type: "constant", value: parseStringLiteralText(stringLiteral.text) };
    }
    const templateString = ctx.templateString();
    if (templateString) {
      return this.visitTemplateString(templateString);
    }
    return { expression_type: "constant", value: "" };
  }

  visitTemplateString(ctx: TemplateStringContext): Constant | Call {
    const pieces: Expression[] = [];
    for (const chunk of ctx.stringContents()) {
      pieces.push(this.visitStringContents(chunk));
    }

    if (pieces.length === 0) {
      return { expression_type: "constant", value: "" };
    } else if (pieces.length === 1) {
      const first = pieces[0];
      // If it's already a Constant or Call, return as-is, otherwise wrap in Call
      if ("value" in first || "name" in first) {
        return first as Constant | Call;
      }
      return { expression_type: "call", name: "concat", args: [first] };
    }

    return { expression_type: "call", name: "concat", args: pieces };
  }

  visitFullTemplateString(ctx: FullTemplateStringContext): Constant | Call {
    const pieces: Expression[] = [];
    for (const chunk of ctx.stringContentsFull()) {
      pieces.push(this.visitStringContentsFull(chunk));
    }

    if (pieces.length === 0) {
      return { expression_type: "constant", value: "" };
    } else if (pieces.length === 1) {
      const first = pieces[0];
      // If it's already a Constant or Call, return as-is, otherwise wrap in Call
      if ("value" in first || "name" in first) {
        return first as Constant | Call;
      }
      return { expression_type: "call", name: "concat", args: [first] };
    }

    return { expression_type: "call", name: "concat", args: pieces };
  }

  visitStringContents(ctx: StringContentsContext): Constant | Expression {
    const stringText = ctx.STRING_TEXT();
    const columnExpr = ctx.columnExpr();
    if (stringText) {
      return { expression_type: "constant", value: parseStringLiteralText(stringText.text) };
    } else if (columnExpr) {
      return this.visitAsExpr(columnExpr);
    }
    return { expression_type: "constant", value: "" };
  }

  visitStringContentsFull(ctx: StringContentsFullContext): Constant | Expression {
    const fullStringText = ctx.FULL_STRING_TEXT();
    const columnExpr = ctx.columnExpr();
    if (fullStringText) {
      return {
        expression_type: "constant",
        value: parseStringLiteralText(fullStringText.text),
      };
    } else if (columnExpr) {
      return this.visitAsExpr(columnExpr);
    }
    return { expression_type: "constant", value: "" };
  }
}
