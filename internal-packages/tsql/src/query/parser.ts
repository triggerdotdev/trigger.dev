import { ParserRuleContext } from "antlr4ts/ParserRuleContext";
import { ParseTree } from "antlr4ts/tree/ParseTree";
import { TerminalNode } from "antlr4ts/tree/TerminalNode";
import { ErrorNode } from "antlr4ts/tree/ErrorNode";
import { Token } from "antlr4ts/Token";
import { TSQLParserVisitor } from "../grammar/TSQLParserVisitor.js";
import {
  Alias,
  And,
  ArithmeticOperation,
  ArithmeticOperationOp,
  Array as ArrayExpression,
  ArrayAccess,
  BetweenExpr,
  Block,
  Call,
  CompareOperation,
  CompareOperationOp,
  Constant,
  CTE,
  Dict,
  Expr,
  ExprCall,
  ExprStatement,
  Field,
  ForInStatement,
  ForStatement,
  Function,
  IfStatement,
  JoinConstraint,
  JoinExpr,
  Lambda,
  LimitByExpr,
  Not,
  OrderExpr,
  Or,
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
  HogQLXAttribute,
  HogQLXTag,
  Declaration,
  Expression,
  AST,
} from "./ast";
import { RESERVED_KEYWORDS } from "./constants";
import { SyntaxError, BaseHogQLError, NotImplementedError } from "./errors";
import type { HogQLTimings } from "./timings";
import { parseStringLiteralCtx, parseStringLiteralText, parseStringTextCtx } from "./parse_string";
import {
  CatchBlockContext,
  DeclarationContext,
  ExprContext,
  ExpressionContext,
  ExprStmtContext,
  ForInStmtContext,
  ForStmtContext,
  FuncStmtContext,
  IdentifierListContext,
  IfStmtContext,
  KvPairContext,
  KvPairListContext,
  ProgramContext,
  ReturnStmtContext,
  StatementContext,
  ThrowStmtContext,
  TryCatchStmtContext,
  VarAssignmentContext,
  VarDeclContext,
  WhileStmtContext,
} from "../grammar/TSQLParser.js";

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

  visit(ctx: ParserRuleContext): any {
    const start = getTokenStart(ctx.start);
    const stop = getTokenStop(ctx.stop);
    const end = stop !== undefined ? stop + 1 : undefined;
    try {
      const node = this.visitChildren(ctx);
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

  visitExpression(ctx: ExpressionContext): Expr {
    return this.visitChildren(ctx);
  }

  visitVarDecl(ctx: VarDeclContext): VariableDeclaration {
    const expr = ctx.expression();
    return {
      name: this.visitIdentifier(ctx.identifier()),
      expr: expr ? this.visit(expr) : undefined,
    };
  }

  visitVarAssignment(ctx: VarAssignmentContext): VariableAssignment {
    return {
      left: this.visit(ctx.expression(0)),
      right: this.visit(ctx.expression(1)),
    };
  }

  visitStatement(ctx: StatementContext): Statement {
    return this.visitChildren(ctx);
  }

  visitExprStmt(ctx: ExprStmtContext): ExprStatement {
    return {
      expr: this.visit(ctx.expression()),
    };
  }

  visitReturnStmt(ctx: ReturnStmtContext): ReturnStatement {
    const expr = ctx.expression();
    return {
      expr: expr ? this.visit(expr) : undefined,
    };
  }

  visitThrowStmt(ctx: ThrowStmtContext): ThrowStatement {
    const expr = ctx.expression();
    return {
      expr: expr ? this.visit(expr) : undefined,
    };
  }

  visitCatchBlock(ctx: CatchBlockContext): [string | null, string | null, Statement] {
    const catchVar = ctx._catchVar;
    const catchType = ctx._catchType;
    const catchStmt = ctx._catchStmt;
    return [
      catchVar ? this.visit(catchVar) : null,
      catchType ? this.visit(catchType) : null,
      catchStmt ? this.visit(catchStmt) : undefined,
    ];
  }

  visitTryCatchStmt(ctx: TryCatchStmtContext): TryCatchStatement {
    const tryStmt = ctx._tryStmt;
    const catchBlocks = ctx.catchBlock();
    const finallyStmt = ctx._finallyStmt;
    return {
      try_stmt: tryStmt ? this.visit(tryStmt) : undefined,
      catches: catchBlocks.map((c: CatchBlockContext) => this.visit(c)),
      finally_stmt: finallyStmt ? this.visit(finallyStmt) : undefined,
    };
  }

  visitIfStmt(ctx: IfStmtContext): IfStatement {
    return {
      expr: this.visit(ctx.expression()),
      then: this.visit(ctx.statement(0)),
      else_: ctx.statement(1) ? this.visit(ctx.statement(1)) : undefined,
    };
  }

  visitWhileStmt(ctx: WhileStmtContext): WhileStatement {
    return {
      expr: this.visit(ctx.expression()),
      body: ctx.statement() ? this.visit(ctx.statement()) : undefined,
    };
  }

  visitForInStmt(ctx: ForInStmtContext): ForInStatement {
    const firstIdentifier = this.visitIdentifier(ctx.identifier(0));
    const secondIdentifier = ctx.identifier(1) ? this.visitIdentifier(ctx.identifier(1)) : null;
    return {
      valueVar: secondIdentifier ?? firstIdentifier,
      keyVar: secondIdentifier ? firstIdentifier : undefined,
      expr: this.visit(ctx.expression()),
      body: this.visit(ctx.statement()),
    };
  }

  visitForStmt(ctx: ForStmtContext): ForStatement {
    const initializer =
      ctx._initializerVarDeclr || ctx._initializerVarAssignment || ctx._initializerExpression;
    const increment =
      ctx._incrementVarDeclr || ctx._incrementVarAssignment || ctx._incrementExpression;

    return {
      initializer: initializer ? this.visit(initializer) : undefined,
      condition: ctx._condition ? this.visit(ctx._condition) : undefined,
      increment: increment ? this.visit(increment) : undefined,
      body: this.visit(ctx.statement()),
    };
  }

  visitFuncStmt(ctx: FuncStmtContext): Function {
    const params = ctx.identifierList();
    return {
      name: this.visitIdentifier(ctx.identifier()),
      params: params ? this.visit(params) : [],
      body: this.visit(ctx.block()),
    };
  }

  visitKvPairList(ctx: KvPairListContext): [Expr, Expr][] {
    return ctx.kvPair().map((kv: any) => this.visit(kv));
  }

  visitKvPair(ctx: KvPairContext): [Expr, Expr] {
    const exprs = ctx.expression();
    return [this.visit(exprs[0]), this.visit(exprs[1])];
  }

  visitIdentifierList(ctx: IdentifierListContext): string[] {
    return ctx.identifier().map((ident: any) => this.visitIdentifier(ident));
  }

  visitEmptyStmt(ctx: any): ExprStatement {
    return { expr: undefined };
  }

  visitBlock(ctx: any): Block {
    const declarations: Declaration[] = [];
    // Implement based on your parser structure
    throw new NotImplementedError("visitBlock not implemented");
  }

  // SELECT statements
  visitSelect(ctx: any): SelectQuery | SelectSetQuery | HogQLXTag {
    return this.visit(ctx.selectSetStmt() || ctx.selectStmt() || ctx.hogqlxTagElement());
  }

  visitSelectSetStmt(ctx: any): SelectQuery | SelectSetQuery {
    const selectQueries: SelectSetNode[] = [];
    const initialQuery = this.visit(ctx.selectStmtWithParens());

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
      const selectQuery = this.visit(subsequent.selectStmtWithParens());
      selectQueries.push({
        select_query: selectQuery,
        set_operator: unionType,
      });
    }

    if (selectQueries.length === 0) {
      return initialQuery;
    }
    return {
      expression_type: "select_set_query",
      initial_select_query: initialQuery,
      subsequent_select_queries: selectQueries,
    };
  }

  visitSelectStmtWithParens(ctx: any): SelectQuery | SelectSetQuery | Placeholder {
    return this.visit(ctx.selectStmt() || ctx.selectSetStmt() || ctx.placeholder());
  }

  visitSelectStmt(ctx: any): SelectQuery {
    const selectQuery: SelectQuery = {
      expression_type: "select_query",
      ctes: ctx.withClause() ? this.visit(ctx.withClause()) : undefined,
      select: ctx.columnExprList() ? this.visit(ctx.columnExprList()) : [],
      distinct: ctx.DISTINCT() ? true : undefined,
      select_from: ctx.fromClause() ? this.visit(ctx.fromClause()) : undefined,
      where: ctx.whereClause() ? this.visit(ctx.whereClause()) : undefined,
      prewhere: ctx.prewhereClause() ? this.visit(ctx.prewhereClause()) : undefined,
      having: ctx.havingClause() ? this.visit(ctx.havingClause()) : undefined,
      group_by: ctx.groupByClause() ? this.visit(ctx.groupByClause()) : undefined,
      order_by: ctx.orderByClause() ? this.visit(ctx.orderByClause()) : undefined,
      limit_by: ctx.limitByClause() ? this.visit(ctx.limitByClause()) : undefined,
    };

    if (ctx.windowClause()) {
      selectQuery.window_exprs = {};
      const windowClause = ctx.windowClause();
      for (let index = 0; index < windowClause.windowExpr().length; index++) {
        const name = this.visit(windowClause.identifier()[index]);
        selectQuery.window_exprs![name] = this.visit(windowClause.windowExpr()[index]);
      }
    }

    if (ctx.limitAndOffsetClause()) {
      const limitAndOffsetClause = ctx.limitAndOffsetClause();
      selectQuery.limit = this.visit(limitAndOffsetClause.columnExpr(0));
      if (limitAndOffsetClause.columnExpr(1)) {
        selectQuery.offset = this.visit(limitAndOffsetClause.columnExpr(1));
      }
      if (limitAndOffsetClause.WITH() && limitAndOffsetClause.TIES()) {
        selectQuery.limit_with_ties = true;
      }
    } else if (ctx.offsetOnlyClause()) {
      selectQuery.offset = this.visit(ctx.offsetOnlyClause().columnExpr());
    }

    if (ctx.arrayJoinClause()) {
      const arrayJoinClause = ctx.arrayJoinClause();
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
      selectQuery.array_join_list = this.visit(arrayJoinClause.columnExprList());
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

  visitWithClause(ctx: any): Record<string, CTE> {
    return this.visit(ctx.withExprList());
  }

  visitFromClause(ctx: any): JoinExpr {
    return this.visit(ctx.joinExpr());
  }

  visitPrewhereClause(ctx: any): Expr {
    return this.visit(ctx.columnExpr());
  }

  visitWhereClause(ctx: any): Expr {
    return this.visit(ctx.columnExpr());
  }

  visitGroupByClause(ctx: any): Expr[] {
    return this.visit(ctx.columnExprList());
  }

  visitHavingClause(ctx: any): Expr {
    return this.visit(ctx.columnExpr());
  }

  visitOrderByClause(ctx: any): OrderExpr[] {
    return this.visit(ctx.orderExprList());
  }

  visitLimitByClause(ctx: any): LimitByExpr {
    const limitExpr = this.visit(ctx.limitExpr());

    // If limitExpr is a tuple (n, offset), split it
    if (Array.isArray(limitExpr) && limitExpr.length === 2) {
      const [n, offsetValue] = limitExpr;
      return {
        expression_type: "limit_by_expr",
        n,
        offset_value: offsetValue,
        exprs: this.visit(ctx.columnExprList()),
      };
    }

    // If no offset, just use limitExpr as n
    return {
      expression_type: "limit_by_expr",
      n: limitExpr,
      offset_value: undefined,
      exprs: this.visit(ctx.columnExprList()),
    };
  }

  visitLimitExpr(ctx: any): Expr | [Expr, Expr] {
    const n = this.visit(ctx.columnExpr(0));

    // Check if we have an offset (second expression)
    if (ctx.columnExpr(1)) {
      const offsetValue = this.visit(ctx.columnExpr(1));
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
  visitJoinExprOp(ctx: any): JoinExpr {
    const join1: JoinExpr = this.visit(ctx.joinExpr(0));
    const join2: JoinExpr = this.visit(ctx.joinExpr(1));

    if (ctx.joinOp()) {
      join2.join_type = `${this.visit(ctx.joinOp())} JOIN`;
    } else {
      join2.join_type = "JOIN";
    }
    join2.constraint = this.visit(ctx.joinConstraintClause());

    let lastJoin = join1;
    while (lastJoin.next_join) {
      lastJoin = lastJoin.next_join;
    }
    lastJoin.next_join = join2;

    return join1;
  }

  visitJoinExprTable(ctx: any): JoinExpr {
    const sample = ctx.sampleClause() ? this.visit(ctx.sampleClause()) : undefined;
    const table = this.visit(ctx.tableExpr());
    const tableFinal = ctx.FINAL() ? true : undefined;
    if ("table" in table) {
      // visitTableExprAlias returns a JoinExpr to pass the alias
      // visitTableExprFunction returns a JoinExpr to pass the args
      table.table_final = tableFinal;
      table.sample = sample;
      return table;
    }
    return {
      expression_type: "join_expr",
      table,
      table_final: tableFinal,
      sample,
    };
  }

  visitJoinExprParens(ctx: any): JoinExpr {
    return this.visit(ctx.joinExpr());
  }

  visitJoinExprCrossOp(ctx: any): JoinExpr {
    const join1: JoinExpr = this.visit(ctx.joinExpr(0));
    const join2: JoinExpr = this.visit(ctx.joinExpr(1));
    join2.join_type = "CROSS JOIN";
    let lastJoin = join1;
    while (lastJoin.next_join) {
      lastJoin = lastJoin.next_join;
    }
    lastJoin.next_join = join2;
    return join1;
  }

  visitJoinOpInner(ctx: any): string {
    const tokens: string[] = [];
    if (ctx.ALL()) tokens.push("ALL");
    if (ctx.ANY()) tokens.push("ANY");
    if (ctx.ASOF()) tokens.push("ASOF");
    tokens.push("INNER");
    return tokens.join(" ");
  }

  visitJoinOpLeftRight(ctx: any): string {
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

  visitJoinOpFull(ctx: any): string {
    const tokens: string[] = [];
    if (ctx.FULL()) tokens.push("FULL");
    if (ctx.OUTER()) tokens.push("OUTER");
    if (ctx.ALL()) tokens.push("ALL");
    if (ctx.ANY()) tokens.push("ANY");
    return tokens.join(" ");
  }

  visitJoinConstraintClause(ctx: any): JoinConstraint {
    const columnExprList = this.visit(ctx.columnExprList());
    if (columnExprList.length !== 1) {
      throw new NotImplementedError("Unsupported: JOIN ... ON with multiple expressions");
    }
    return {
      expression_type: "join_constraint",
      expr: columnExprList[0],
      constraint_type: ctx.USING() ? "USING" : "ON",
    };
  }

  visitSampleClause(ctx: any): SampleExpr {
    const ratioExpressions = ctx.ratioExpr();
    const sampleRatioExpr = this.visit(ratioExpressions[0]);
    const offsetRatioExpr =
      ratioExpressions.length > 1 && ctx.OFFSET() ? this.visit(ratioExpressions[1]) : undefined;

    return {
      expression_type: "sample_expr",
      sample_value: sampleRatioExpr,
      offset_value: offsetRatioExpr,
    };
  }

  visitOrderExprList(ctx: any): OrderExpr[] {
    return ctx.orderExpr().map((expr: any) => this.visit(expr));
  }

  visitOrderExpr(ctx: any): OrderExpr {
    const order = ctx.DESC() || ctx.DESCENDING() ? "DESC" : "ASC";
    return {
      expression_type: "order_expr",
      expr: this.visit(ctx.columnExpr()),
      order: order as "ASC" | "DESC",
    };
  }

  visitRatioExpr(ctx: any): RatioExpr {
    if (ctx.placeholder()) {
      return this.visit(ctx.placeholder());
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

  visitWindowExpr(ctx: any): WindowExpr {
    const frame = ctx.winFrameClause();
    const visitedFrame = frame ? this.visit(frame) : undefined;
    return {
      expression_type: "window_expr",
      partition_by: ctx.winPartitionByClause() ? this.visit(ctx.winPartitionByClause()) : undefined,
      order_by: ctx.winOrderByClause() ? this.visit(ctx.winOrderByClause()) : undefined,
      frame_method: frame && frame.RANGE() ? "RANGE" : frame && frame.ROWS() ? "ROWS" : undefined,
      frame_start: Array.isArray(visitedFrame) ? visitedFrame[0] : visitedFrame,
      frame_end: Array.isArray(visitedFrame) ? visitedFrame[1] : undefined,
    };
  }

  visitWinPartitionByClause(ctx: any): Expr[] {
    return this.visit(ctx.columnExprList());
  }

  visitWinOrderByClause(ctx: any): OrderExpr[] {
    return this.visit(ctx.orderExprList());
  }

  visitWinFrameClause(ctx: any): WindowFrameExpr | [WindowFrameExpr, WindowFrameExpr] {
    return this.visit(ctx.winFrameExtend());
  }

  visitFrameStart(ctx: any): WindowFrameExpr {
    return this.visit(ctx.winFrameBound());
  }

  visitFrameBetween(ctx: any): [WindowFrameExpr, WindowFrameExpr] {
    return [this.visit(ctx.winFrameBound(0)), this.visit(ctx.winFrameBound(1))];
  }

  visitWinFrameBound(ctx: any): WindowFrameExpr {
    if (ctx.PRECEDING()) {
      return {
        expression_type: "window_frame_expr",
        frame_type: "PRECEDING",
        frame_value: ctx.numberLiteral()
          ? (this.visit(ctx.numberLiteral()) as Constant).value
          : undefined,
      };
    }
    if (ctx.FOLLOWING()) {
      return {
        expression_type: "window_frame_expr",
        frame_type: "FOLLOWING",
        frame_value: ctx.numberLiteral()
          ? (this.visit(ctx.numberLiteral()) as Constant).value
          : undefined,
      };
    }
    return { expression_type: "window_frame_expr", frame_type: "CURRENT ROW" };
  }

  // Column expressions
  visitColumnExprList(ctx: any): Expr[] {
    return ctx.columnExpr().map((c: any) => this.visit(c));
  }

  visitColumnExprTernaryOp(ctx: any): Call {
    return {
      expression_type: "call",
      name: "if",
      args: [
        this.visit(ctx.columnExpr(0)),
        this.visit(ctx.columnExpr(1)),
        this.visit(ctx.columnExpr(2)),
      ],
    };
  }

  visitColumnExprAlias(ctx: any): Alias {
    let alias: string;
    if (ctx.identifier()) {
      alias = this.visitIdentifier(ctx.identifier());
    } else if (ctx.STRING_LITERAL()) {
      alias = parseStringLiteralCtx(ctx.STRING_LITERAL());
    } else {
      throw new SyntaxError("Must specify an alias");
    }
    const expr = this.visit(ctx.columnExpr());

    if (RESERVED_KEYWORDS.includes(alias.toLowerCase() as any)) {
      throw new SyntaxError(
        `"${alias}" cannot be an alias or identifier, as it's a reserved keyword`
      );
    }

    return { expression_type: "alias", expr, alias };
  }

  visitColumnExprNegate(ctx: any): ArithmeticOperation {
    return {
      expression_type: "arithmetic_operation",
      op: ArithmeticOperationOp.Sub,
      left: { value: 0 } as Constant,
      right: this.visit(ctx.columnExpr()),
    };
  }

  visitColumnExprDict(ctx: any): Dict {
    return {
      expression_type: "dict",
      items: ctx.kvPairList() ? this.visit(ctx.kvPairList()) : [],
    };
  }

  visitColumnExprSubquery(ctx: any): SelectQuery | SelectSetQuery {
    return this.visit(ctx.selectSetStmt());
  }

  visitColumnExprLiteral(ctx: any): Expr {
    return this.visitChildren(ctx);
  }

  visitColumnExprArray(ctx: any): ArrayExpression {
    return {
      expression_type: "array",
      exprs: ctx.columnExprList() ? this.visit(ctx.columnExprList()) : [],
    };
  }

  visitColumnExprPrecedence1(ctx: any): ArithmeticOperation {
    let op: ArithmeticOperationOp;
    if (ctx.SLASH()) {
      op = ArithmeticOperationOp.Div;
    } else if (ctx.ASTERISK()) {
      op = ArithmeticOperationOp.Mult;
    } else if (ctx.PERCENT()) {
      op = ArithmeticOperationOp.Mod;
    } else {
      throw new NotImplementedError(`Unsupported ColumnExprPrecedence1: ${ctx.getText()}`);
    }
    // Use columnExpr() method to get left and right operands
    const left = this.visit(ctx.columnExpr(0));
    const right = this.visit(ctx.columnExpr(1));
    return { expression_type: "arithmetic_operation", left, right, op };
  }

  visitColumnExprPrecedence2(ctx: any): ArithmeticOperation | Call {
    // Use columnExpr() method to get left and right operands
    const left = this.visit(ctx.columnExpr(0));
    const right = this.visit(ctx.columnExpr(1));

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
      if ("name" in left && left.name === "concat" && "args" in left) {
        args.push(...left.args);
      } else {
        args.push(left);
      }

      if ("name" in right && right.name === "concat" && "args" in right) {
        args.push(...right.args);
      } else {
        args.push(right);
      }

      return { expression_type: "call", name: "concat", args };
    } else {
      throw new NotImplementedError(`Unsupported ColumnExprPrecedence2: ${ctx.getText()}`);
    }
  }

  visitColumnExprPrecedence3(ctx: any): CompareOperation {
    // Use columnExpr() method to get left and right operands
    const left = this.visit(ctx.columnExpr(0));
    const right = this.visit(ctx.columnExpr(1));

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
      throw new NotImplementedError(`Unsupported ColumnExprPrecedence3: ${ctx.getText()}`);
    }

    return { expression_type: "compare_operation", left, right, op };
  }

  visitColumnExprInterval(ctx: any): Call {
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
      throw new NotImplementedError(`Unsupported interval type: ${interval.getText()}`);
    }

    return { expression_type: "call", name, args: [this.visit(ctx.columnExpr())] };
  }

  visitColumnExprIsNull(ctx: any): CompareOperation {
    return {
      expression_type: "compare_operation",
      left: this.visit(ctx.columnExpr()),
      right: { value: null } as Constant,
      op: ctx.NOT() ? CompareOperationOp.NotEq : CompareOperationOp.Eq,
    };
  }

  visitColumnExprTuple(ctx: any): Tuple {
    return {
      expression_type: "tuple",
      exprs: ctx.columnExprList() ? this.visit(ctx.columnExprList()) : [],
    };
  }

  visitColumnExprArrayAccess(ctx: any): ArrayAccess {
    const object: Expression = this.visit(ctx.columnExpr(0));
    const property: Expression = this.visit(ctx.columnExpr(1));
    return { expression_type: "array_access", array: object, property };
  }

  visitColumnExprNullArrayAccess(ctx: any): ArrayAccess {
    const object: Expression = this.visit(ctx.columnExpr(0));
    const property: Expression = this.visit(ctx.columnExpr(1));
    return { expression_type: "array_access", array: object, property, nullish: true };
  }

  visitColumnExprPropertyAccess(ctx: any): ArrayAccess {
    const object = this.visit(ctx.columnExpr());
    const property = { value: this.visitIdentifier(ctx.identifier()) } as Constant;
    return { expression_type: "array_access", array: object, property };
  }

  visitColumnExprNullPropertyAccess(ctx: any): ArrayAccess {
    const object = this.visit(ctx.columnExpr());
    const property = { value: this.visitIdentifier(ctx.identifier()) } as Constant;
    return { expression_type: "array_access", array: object, property, nullish: true };
  }

  visitColumnExprBetween(ctx: any): BetweenExpr {
    return {
      expression_type: "between_expr",
      expr: this.visit(ctx.columnExpr(0)),
      low: this.visit(ctx.columnExpr(1)),
      high: this.visit(ctx.columnExpr(2)),
      negated: !!ctx.NOT(),
    };
  }

  visitColumnExprParens(ctx: any): Expr {
    return this.visit(ctx.columnExpr());
  }

  visitColumnExprAnd(ctx: any): And {
    let left = this.visit(ctx.columnExpr(0));
    const leftArray = "exprs" in left ? left.exprs : [left];

    let right = this.visit(ctx.columnExpr(1));
    const rightArray = "exprs" in right ? right.exprs : [right];

    return { expression_type: "and", exprs: [...leftArray, ...rightArray] };
  }

  visitColumnExprOr(ctx: any): Or {
    let left = this.visit(ctx.columnExpr(0));
    const leftArray = "exprs" in left ? left.exprs : [left];

    let right = this.visit(ctx.columnExpr(1));
    const rightArray = "exprs" in right ? right.exprs : [right];

    return { expression_type: "or", exprs: [...leftArray, ...rightArray] };
  }

  visitColumnExprTupleAccess(ctx: any): TupleAccess {
    const tuple = this.visit(ctx.columnExpr());
    const index = parseInt(ctx.DECIMAL_LITERAL().getText());
    return { expression_type: "tuple_access", tuple, index };
  }

  visitColumnExprNullTupleAccess(ctx: any): TupleAccess {
    const tuple = this.visit(ctx.columnExpr());
    const index = parseInt(ctx.DECIMAL_LITERAL().getText());
    return { expression_type: "tuple_access", tuple, index, nullish: true };
  }

  visitColumnExprCase(ctx: any): Call {
    const columns = ctx.columnExpr().map((column: any) => this.visit(column));
    if (ctx.caseExpr) {
      const args: Expression[] = [
        columns[0],
        { expression_type: "array", exprs: [] },
        { expression_type: "array", exprs: [] },
        ,
        columns[columns.length - 1],
      ];
      for (let index = 1; index < columns.length - 1; index++) {
        const arrayIndex = ((index - 1) % 2) + 1;
        (args[arrayIndex] as ArrayExpression).exprs.push(columns[index]);
      }
      return { expression_type: "call", name: "transform", args };
    } else if (columns.length === 3) {
      return { expression_type: "call", name: "if", args: columns };
    } else {
      return { expression_type: "call", name: "multiIf", args: columns };
    }
  }

  visitColumnExprNot(ctx: any): Not {
    return { expression_type: "not", expr: this.visit(ctx.columnExpr()) };
  }

  visitColumnExprWinFunctionTarget(ctx: any): WindowFunction {
    return {
      expression_type: "window_function",
      name: this.visitIdentifier(ctx.identifier(0)),
      exprs: ctx.columnExprs ? this.visit(ctx.columnExprs) : [],
      args: ctx.columnArgList ? this.visit(ctx.columnArgList) : [],
      over_identifier: this.visitIdentifier(ctx.identifier(1)),
    };
  }

  visitColumnExprWinFunction(ctx: any): WindowFunction {
    return {
      expression_type: "window_function",
      name: this.visitIdentifier(ctx.identifier()),
      exprs: ctx.columnExprs ? this.visit(ctx.columnExprs) : [],
      args: ctx.columnArgList ? this.visit(ctx.columnArgList) : [],
      over_expr: ctx.windowExpr() ? this.visit(ctx.windowExpr()) : undefined,
    };
  }

  visitColumnExprIdentifier(ctx: any): Expr {
    return this.visit(ctx.columnIdentifier());
  }

  visitColumnExprFunction(ctx: any): Call {
    const name = this.visitIdentifier(ctx.identifier());

    let parameters: Expression[] | undefined = ctx.columnExprs
      ? this.visit(ctx.columnExprs)
      : undefined;
    // two sets of parameters fn()(), return an empty list for the first even if no parameters
    if (ctx.LPAREN && ctx.LPAREN().length > 1 && parameters === undefined) {
      parameters = [];
    }

    const args: Expression[] = ctx.columnArgList ? this.visit(ctx.columnArgList) : [];
    const distinct = ctx.DISTINCT() ? true : false;
    return { expression_type: "call", name, params: parameters, args, distinct };
  }

  visitColumnExprAsterisk(ctx: any): Field {
    if (ctx.tableIdentifier()) {
      const table = this.visit(ctx.tableIdentifier());
      return { expression_type: "field", chain: [...table, "*"] };
    }
    return { expression_type: "field", chain: ["*"] };
  }

  visitColumnLambdaExpr(ctx: any): Lambda {
    return {
      expression_type: "lambda",
      args: ctx.identifier().map((identifier: any) => this.visitIdentifier(identifier)),
      expr: ctx.columnExpr() ? this.visit(ctx.columnExpr()) : this.visit(ctx.block()),
    };
  }

  visitWithExprList(ctx: any): Record<string, CTE> {
    const ctes: Record<string, CTE> = {};
    for (const expr of ctx.withExpr()) {
      const cte = this.visit(expr);
      ctes[cte.name] = cte;
    }
    return ctes;
  }

  visitWithExprSubquery(ctx: any): CTE {
    const subquery = this.visit(ctx.selectSetStmt());
    const name = this.visitIdentifier(ctx.identifier());
    return { expression_type: "cte", name, expr: subquery, cte_type: "subquery" };
  }

  visitWithExprColumn(ctx: any): CTE {
    const expr = this.visit(ctx.columnExpr());
    const name = this.visitIdentifier(ctx.identifier());
    return { expression_type: "cte", name, expr, cte_type: "column" };
  }

  visitColumnIdentifier(ctx: any): Expression {
    if (ctx.placeholder()) {
      return this.visit(ctx.placeholder());
    }

    const table = ctx.tableIdentifier() ? this.visit(ctx.tableIdentifier()) : [];
    const nested = ctx.nestedIdentifier() ? this.visit(ctx.nestedIdentifier()) : [];

    if (table.length === 0 && nested.length > 0) {
      const text = ctx.getText().toLowerCase();
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

  visitNestedIdentifier(ctx: any): string[] {
    return ctx.identifier().map((identifier: any) => this.visitIdentifier(identifier));
  }

  visitTableExprIdentifier(ctx: any): Field {
    const chain = this.visit(ctx.tableIdentifier());
    return { expression_type: "field", chain };
  }

  visitTableExprSubquery(ctx: any): SelectQuery | SelectSetQuery {
    return this.visit(ctx.selectSetStmt());
  }

  visitTableExprPlaceholder(ctx: any): Placeholder {
    return this.visit(ctx.placeholder());
  }

  visitTableExprAlias(ctx: any): JoinExpr {
    const alias: string = this.visit(ctx.alias() || ctx.identifier());
    if (RESERVED_KEYWORDS.includes(alias.toLowerCase() as any)) {
      throw new SyntaxError(
        `"${alias}" cannot be an alias or identifier, as it's a reserved keyword`
      );
    }
    const table = this.visit(ctx.tableExpr());
    if ("table" in table) {
      table.alias = alias;
      return table;
    }
    return { expression_type: "join_expr", table, alias };
  }

  visitTableExprFunction(ctx: any): JoinExpr {
    return this.visit(ctx.tableFunctionExpr());
  }

  visitTableExprTag(ctx: any): HogQLXTag {
    return this.visit(ctx.hogqlxTagElement());
  }

  visitTableFunctionExpr(ctx: any): JoinExpr {
    const name = this.visitIdentifier(ctx.identifier());
    const args = ctx.tableArgList() ? this.visit(ctx.tableArgList()) : [];
    return {
      expression_type: "join_expr",
      table: { expression_type: "field", chain: [name] },
      table_args: args,
    };
  }

  visitTableIdentifier(ctx: any): string[] {
    const nested = ctx.nestedIdentifier() ? this.visit(ctx.nestedIdentifier()) : [];
    // Ensure nested is always an array
    const nestedArray = Array.isArray(nested) ? nested : nested ? [nested] : [];

    if (ctx.databaseIdentifier()) {
      const dbId = this.visit(ctx.databaseIdentifier());
      return [dbId, ...nestedArray];
    }

    return nestedArray;
  }

  visitTableArgList(ctx: any): Expression[] {
    return ctx.columnExpr().map((arg: any) => this.visit(arg));
  }

  visitDatabaseIdentifier(ctx: any): string {
    return this.visitIdentifier(ctx.identifier());
  }

  visitNumberLiteral(ctx: any): Constant {
    // NumberLiteralContext is a ParserRuleContext, use getText() to get the text
    if (!ctx || typeof ctx.getText !== "function") {
      throw new SyntaxError(
        "Invalid number literal context - expected ParserRuleContext with getText()"
      );
    }
    const text = ctx.getText().toLowerCase();
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

  visitLiteral(ctx: any): Constant {
    if (ctx.NULL_SQL()) {
      return { expression_type: "constant", value: null };
    }
    if (ctx.STRING_LITERAL()) {
      // STRING_LITERAL() returns a TerminalNode, which has getText()
      const stringLiteral = ctx.STRING_LITERAL();
      const text = parseStringLiteralCtx(stringLiteral);
      return { expression_type: "constant", value: text };
    }
    if (ctx.numberLiteral()) {
      return this.visitNumberLiteral(ctx.numberLiteral());
    }
    return this.visitChildren(ctx);
  }

  visitAlias(ctx: any): string {
    let text = ctx.getText();
    if (
      text.length >= 2 &&
      ((text.startsWith("`") && text.endsWith("`")) || (text.startsWith('"') && text.endsWith('"')))
    ) {
      text = parseStringLiteralText(text);
    }
    return text;
  }

  visitIdentifier(ctx: any): string {
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
    // Fallback: if it's a ParserRuleContext, use getText()
    if (typeof ctx.getText === "function") {
      let text = ctx.getText();
      if (
        text.length >= 2 &&
        ((text.startsWith("`") && text.endsWith("`")) ||
          (text.startsWith('"') && text.endsWith('"')))
      ) {
        text = parseStringLiteralText(text);
      }
      return text;
    }
    // If it's already a string
    if (typeof ctx === "string") {
      return ctx;
    }
    // Try to get text from symbol if it's a TerminalNode
    if (ctx.symbol && ctx.symbol.text) {
      return ctx.symbol.text;
    }
    throw new SyntaxError("Invalid identifier context");
  }

  visitColumnExprNullish(ctx: any): Call {
    return {
      expression_type: "call",
      name: "ifNull",
      args: [this.visit(ctx.columnExpr(0)), this.visit(ctx.columnExpr(1))],
    };
  }

  visitColumnExprCall(ctx: any): ExprCall {
    return {
      expression_type: "expr_call",
      expr: this.visit(ctx.columnExpr()),
      args: ctx.columnExprList() ? this.visit(ctx.columnExprList()) : [],
    };
  }

  visitColumnExprCallSelect(ctx: any): Call | ExprCall {
    const expr = this.visit(ctx.columnExpr());
    if ("chain" in expr && expr.chain.length === 1) {
      return {
        expression_type: "call",
        name: String(expr.chain[0]),
        args: [this.visit(ctx.selectSetStmt())],
      };
    }
    return {
      expression_type: "expr_call",
      expr,
      args: [this.visit(ctx.selectSetStmt())],
    };
  }

  visitHogqlxChildElement(ctx: any): Expr | HogQLXTag {
    if (ctx.hogqlxTagElement()) {
      return this.visit(ctx.hogqlxTagElement());
    }
    if (ctx.hogqlxText()) {
      return this.visit(ctx.hogqlxText());
    }
    return this.visit(ctx.columnExpr());
  }

  visitHogqlxText(ctx: any): Constant {
    return { expression_type: "constant", value: ctx.HOGQLX_TEXT_TEXT().getText() };
  }

  visitHogqlxTagElementClosed(ctx: any): HogQLXTag {
    const kind = this.visitIdentifier(ctx.identifier());
    const attributes = ctx.hogqlxTagAttribute()
      ? ctx.hogqlxTagAttribute().map((a: any) => this.visit(a))
      : [];
    return { expression_type: "hogqlx_tag", kind, attributes };
  }

  visitHogqlxTagElementNested(ctx: any): HogQLXTag {
    const opening = this.visitIdentifier(ctx.identifier(0));
    const closing = this.visitIdentifier(ctx.identifier(1));
    if (opening !== closing) {
      throw new SyntaxError(
        `Opening and closing HogQLX tags must match. Got ${opening} and ${closing}`
      );
    }

    const attributes = ctx.hogqlxTagAttribute()
      ? ctx.hogqlxTagAttribute().map((a: any) => this.visit(a))
      : [];

    // ── collect child nodes, discarding pure-indentation whitespace ──
    const keptChildren: Expression[] = [];
    for (const element of ctx.hogqlxChildElement()) {
      const child = this.visit(element);

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

  visitHogqlxTagAttribute(ctx: any): HogQLXAttribute {
    const name = this.visitIdentifier(ctx.identifier());
    if (ctx.columnExpr()) {
      return { name, value: this.visit(ctx.columnExpr()) };
    } else if (ctx.string()) {
      return { name, value: this.visit(ctx.string()) };
    } else {
      return { name, value: { value: true } as Constant };
    }
  }

  visitPlaceholder(ctx: any): Placeholder {
    return { expression_type: "placeholder", expr: this.visit(ctx.columnExpr()) };
  }

  visitColumnExprTemplateString(ctx: any): Expr {
    return this.visit(ctx.templateString());
  }

  visitString(ctx: any): Constant | Expr {
    if (ctx.STRING_LITERAL()) {
      return { expression_type: "constant", value: parseStringLiteralCtx(ctx.STRING_LITERAL()) };
    }
    return this.visit(ctx.templateString());
  }

  visitTemplateString(ctx: any): Constant | Call {
    const pieces: Expression[] = [];
    for (const chunk of ctx.stringContents()) {
      pieces.push(this.visit(chunk));
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

  visitFullTemplateString(ctx: any): Constant | Call {
    const pieces: Expression[] = [];
    for (const chunk of ctx.stringContentsFull()) {
      pieces.push(this.visit(chunk));
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

  visitStringContents(ctx: any): Constant | Expression {
    if (ctx.STRING_TEXT()) {
      return { expression_type: "constant", value: parseStringTextCtx(ctx.STRING_TEXT(), true) };
    } else if (ctx.columnExpr()) {
      return this.visit(ctx.columnExpr());
    }
    return { expression_type: "constant", value: "" };
  }

  visitStringContentsFull(ctx: any): Constant | Expression {
    if (ctx.FULL_STRING_TEXT()) {
      return {
        expression_type: "constant",
        value: parseStringTextCtx(ctx.FULL_STRING_TEXT(), false),
      };
    } else if (ctx.columnExpr()) {
      return this.visit(ctx.columnExpr());
    }
    return { expression_type: "constant", value: "" };
  }
}
