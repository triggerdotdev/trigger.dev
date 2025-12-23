// Generated from src/grammar/TRQLParser.g4 by ANTLR 4.9.0-SNAPSHOT


import { ParseTreeVisitor } from "antlr4ts/tree/ParseTreeVisitor";

import { JoinOpInnerContext } from "./TRQLParser";
import { JoinOpLeftRightContext } from "./TRQLParser";
import { JoinOpFullContext } from "./TRQLParser";
import { ColumnExprCaseContext } from "./TRQLParser";
import { ColumnExprCastContext } from "./TRQLParser";
import { ColumnExprDateContext } from "./TRQLParser";
import { ColumnExprIntervalStringContext } from "./TRQLParser";
import { ColumnExprIntervalContext } from "./TRQLParser";
import { ColumnExprSubstringContext } from "./TRQLParser";
import { ColumnExprTimestampContext } from "./TRQLParser";
import { ColumnExprTrimContext } from "./TRQLParser";
import { ColumnExprWinFunctionContext } from "./TRQLParser";
import { ColumnExprWinFunctionTargetContext } from "./TRQLParser";
import { ColumnExprFunctionContext } from "./TRQLParser";
import { ColumnExprCallSelectContext } from "./TRQLParser";
import { ColumnExprCallContext } from "./TRQLParser";
import { ColumnExprTagElementContext } from "./TRQLParser";
import { ColumnExprTemplateStringContext } from "./TRQLParser";
import { ColumnExprLiteralContext } from "./TRQLParser";
import { ColumnExprArrayAccessContext } from "./TRQLParser";
import { ColumnExprTupleAccessContext } from "./TRQLParser";
import { ColumnExprPropertyAccessContext } from "./TRQLParser";
import { ColumnExprNullArrayAccessContext } from "./TRQLParser";
import { ColumnExprNullTupleAccessContext } from "./TRQLParser";
import { ColumnExprNullPropertyAccessContext } from "./TRQLParser";
import { ColumnExprNegateContext } from "./TRQLParser";
import { ColumnExprPrecedence1Context } from "./TRQLParser";
import { ColumnExprPrecedence2Context } from "./TRQLParser";
import { ColumnExprPrecedence3Context } from "./TRQLParser";
import { ColumnExprIsNullContext } from "./TRQLParser";
import { ColumnExprNullishContext } from "./TRQLParser";
import { ColumnExprNotContext } from "./TRQLParser";
import { ColumnExprAndContext } from "./TRQLParser";
import { ColumnExprOrContext } from "./TRQLParser";
import { ColumnExprBetweenContext } from "./TRQLParser";
import { ColumnExprTernaryOpContext } from "./TRQLParser";
import { ColumnExprAliasContext } from "./TRQLParser";
import { ColumnExprAsteriskContext } from "./TRQLParser";
import { ColumnExprSubqueryContext } from "./TRQLParser";
import { ColumnExprParensContext } from "./TRQLParser";
import { ColumnExprTupleContext } from "./TRQLParser";
import { ColumnExprArrayContext } from "./TRQLParser";
import { ColumnExprDictContext } from "./TRQLParser";
import { ColumnExprLambdaContext } from "./TRQLParser";
import { ColumnExprIdentifierContext } from "./TRQLParser";
import { TableExprIdentifierContext } from "./TRQLParser";
import { TableExprFunctionContext } from "./TRQLParser";
import { TableExprSubqueryContext } from "./TRQLParser";
import { TableExprAliasContext } from "./TRQLParser";
import { TableExprTagContext } from "./TRQLParser";
import { TableExprPlaceholderContext } from "./TRQLParser";
import { WithExprSubqueryContext } from "./TRQLParser";
import { WithExprColumnContext } from "./TRQLParser";
import { JoinExprOpContext } from "./TRQLParser";
import { JoinExprCrossOpContext } from "./TRQLParser";
import { JoinExprTableContext } from "./TRQLParser";
import { JoinExprParensContext } from "./TRQLParser";
import { FrameStartContext } from "./TRQLParser";
import { FrameBetweenContext } from "./TRQLParser";
import { ColumnTypeExprSimpleContext } from "./TRQLParser";
import { ColumnTypeExprNestedContext } from "./TRQLParser";
import { ColumnTypeExprEnumContext } from "./TRQLParser";
import { ColumnTypeExprComplexContext } from "./TRQLParser";
import { ColumnTypeExprParamContext } from "./TRQLParser";
import { ProgramContext } from "./TRQLParser";
import { DeclarationContext } from "./TRQLParser";
import { ExpressionContext } from "./TRQLParser";
import { VarDeclContext } from "./TRQLParser";
import { IdentifierListContext } from "./TRQLParser";
import { StatementContext } from "./TRQLParser";
import { ReturnStmtContext } from "./TRQLParser";
import { ThrowStmtContext } from "./TRQLParser";
import { CatchBlockContext } from "./TRQLParser";
import { TryCatchStmtContext } from "./TRQLParser";
import { IfStmtContext } from "./TRQLParser";
import { WhileStmtContext } from "./TRQLParser";
import { ForStmtContext } from "./TRQLParser";
import { ForInStmtContext } from "./TRQLParser";
import { FuncStmtContext } from "./TRQLParser";
import { VarAssignmentContext } from "./TRQLParser";
import { ExprStmtContext } from "./TRQLParser";
import { EmptyStmtContext } from "./TRQLParser";
import { BlockContext } from "./TRQLParser";
import { KvPairContext } from "./TRQLParser";
import { KvPairListContext } from "./TRQLParser";
import { SelectContext } from "./TRQLParser";
import { SelectStmtWithParensContext } from "./TRQLParser";
import { SubsequentSelectSetClauseContext } from "./TRQLParser";
import { SelectSetStmtContext } from "./TRQLParser";
import { SelectStmtContext } from "./TRQLParser";
import { WithClauseContext } from "./TRQLParser";
import { TopClauseContext } from "./TRQLParser";
import { FromClauseContext } from "./TRQLParser";
import { ArrayJoinClauseContext } from "./TRQLParser";
import { WindowClauseContext } from "./TRQLParser";
import { PrewhereClauseContext } from "./TRQLParser";
import { WhereClauseContext } from "./TRQLParser";
import { GroupByClauseContext } from "./TRQLParser";
import { HavingClauseContext } from "./TRQLParser";
import { OrderByClauseContext } from "./TRQLParser";
import { ProjectionOrderByClauseContext } from "./TRQLParser";
import { LimitByClauseContext } from "./TRQLParser";
import { LimitAndOffsetClauseContext } from "./TRQLParser";
import { OffsetOnlyClauseContext } from "./TRQLParser";
import { SettingsClauseContext } from "./TRQLParser";
import { JoinExprContext } from "./TRQLParser";
import { JoinOpContext } from "./TRQLParser";
import { JoinOpCrossContext } from "./TRQLParser";
import { JoinConstraintClauseContext } from "./TRQLParser";
import { SampleClauseContext } from "./TRQLParser";
import { LimitExprContext } from "./TRQLParser";
import { OrderExprListContext } from "./TRQLParser";
import { OrderExprContext } from "./TRQLParser";
import { RatioExprContext } from "./TRQLParser";
import { SettingExprListContext } from "./TRQLParser";
import { SettingExprContext } from "./TRQLParser";
import { WindowExprContext } from "./TRQLParser";
import { WinPartitionByClauseContext } from "./TRQLParser";
import { WinOrderByClauseContext } from "./TRQLParser";
import { WinFrameClauseContext } from "./TRQLParser";
import { WinFrameExtendContext } from "./TRQLParser";
import { WinFrameBoundContext } from "./TRQLParser";
import { ExprContext } from "./TRQLParser";
import { ColumnTypeExprContext } from "./TRQLParser";
import { ColumnExprListContext } from "./TRQLParser";
import { ColumnExprContext } from "./TRQLParser";
import { ColumnLambdaExprContext } from "./TRQLParser";
import { TRQLxChildElementContext } from "./TRQLParser";
import { TRQLxTagElementContext } from "./TRQLParser";
import { TRQLxTagAttributeContext } from "./TRQLParser";
import { WithExprListContext } from "./TRQLParser";
import { WithExprContext } from "./TRQLParser";
import { ColumnIdentifierContext } from "./TRQLParser";
import { NestedIdentifierContext } from "./TRQLParser";
import { TableExprContext } from "./TRQLParser";
import { TableFunctionExprContext } from "./TRQLParser";
import { TableIdentifierContext } from "./TRQLParser";
import { TableArgListContext } from "./TRQLParser";
import { DatabaseIdentifierContext } from "./TRQLParser";
import { FloatingLiteralContext } from "./TRQLParser";
import { NumberLiteralContext } from "./TRQLParser";
import { LiteralContext } from "./TRQLParser";
import { IntervalContext } from "./TRQLParser";
import { KeywordContext } from "./TRQLParser";
import { KeywordForAliasContext } from "./TRQLParser";
import { AliasContext } from "./TRQLParser";
import { IdentifierContext } from "./TRQLParser";
import { EnumValueContext } from "./TRQLParser";
import { PlaceholderContext } from "./TRQLParser";
import { StringContext } from "./TRQLParser";
import { TemplateStringContext } from "./TRQLParser";
import { StringContentsContext } from "./TRQLParser";
import { FullTemplateStringContext } from "./TRQLParser";
import { StringContentsFullContext } from "./TRQLParser";


/**
 * This interface defines a complete generic visitor for a parse tree produced
 * by `TRQLParser`.
 *
 * @param <Result> The return type of the visit operation. Use `void` for
 * operations with no return type.
 */
export interface TRQLParserVisitor<Result> extends ParseTreeVisitor<Result> {
	/**
	 * Visit a parse tree produced by the `JoinOpInner`
	 * labeled alternative in `TRQLParser.joinOp`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinOpInner?: (ctx: JoinOpInnerContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinOpLeftRight`
	 * labeled alternative in `TRQLParser.joinOp`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinOpLeftRight?: (ctx: JoinOpLeftRightContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinOpFull`
	 * labeled alternative in `TRQLParser.joinOp`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinOpFull?: (ctx: JoinOpFullContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprCase`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprCase?: (ctx: ColumnExprCaseContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprCast`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprCast?: (ctx: ColumnExprCastContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprDate`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprDate?: (ctx: ColumnExprDateContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprIntervalString`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprIntervalString?: (ctx: ColumnExprIntervalStringContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprInterval`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprInterval?: (ctx: ColumnExprIntervalContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprSubstring`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprSubstring?: (ctx: ColumnExprSubstringContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTimestamp`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTimestamp?: (ctx: ColumnExprTimestampContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTrim`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTrim?: (ctx: ColumnExprTrimContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprWinFunction`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprWinFunction?: (ctx: ColumnExprWinFunctionContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprWinFunctionTarget`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprWinFunctionTarget?: (ctx: ColumnExprWinFunctionTargetContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprFunction`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprFunction?: (ctx: ColumnExprFunctionContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprCallSelect`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprCallSelect?: (ctx: ColumnExprCallSelectContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprCall`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprCall?: (ctx: ColumnExprCallContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTagElement`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTagElement?: (ctx: ColumnExprTagElementContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTemplateString`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTemplateString?: (ctx: ColumnExprTemplateStringContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprLiteral`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprLiteral?: (ctx: ColumnExprLiteralContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprArrayAccess`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprArrayAccess?: (ctx: ColumnExprArrayAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTupleAccess`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTupleAccess?: (ctx: ColumnExprTupleAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprPropertyAccess`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprPropertyAccess?: (ctx: ColumnExprPropertyAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNullArrayAccess`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNullArrayAccess?: (ctx: ColumnExprNullArrayAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNullTupleAccess`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNullTupleAccess?: (ctx: ColumnExprNullTupleAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNullPropertyAccess`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNullPropertyAccess?: (ctx: ColumnExprNullPropertyAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNegate`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNegate?: (ctx: ColumnExprNegateContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprPrecedence1`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprPrecedence1?: (ctx: ColumnExprPrecedence1Context) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprPrecedence2`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprPrecedence2?: (ctx: ColumnExprPrecedence2Context) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprPrecedence3`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprPrecedence3?: (ctx: ColumnExprPrecedence3Context) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprIsNull`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprIsNull?: (ctx: ColumnExprIsNullContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNullish`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNullish?: (ctx: ColumnExprNullishContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNot`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNot?: (ctx: ColumnExprNotContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprAnd`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprAnd?: (ctx: ColumnExprAndContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprOr`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprOr?: (ctx: ColumnExprOrContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprBetween`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprBetween?: (ctx: ColumnExprBetweenContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTernaryOp`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTernaryOp?: (ctx: ColumnExprTernaryOpContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprAlias`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprAlias?: (ctx: ColumnExprAliasContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprAsterisk`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprAsterisk?: (ctx: ColumnExprAsteriskContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprSubquery`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprSubquery?: (ctx: ColumnExprSubqueryContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprParens`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprParens?: (ctx: ColumnExprParensContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTuple`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTuple?: (ctx: ColumnExprTupleContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprArray`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprArray?: (ctx: ColumnExprArrayContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprDict`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprDict?: (ctx: ColumnExprDictContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprLambda`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprLambda?: (ctx: ColumnExprLambdaContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprIdentifier`
	 * labeled alternative in `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprIdentifier?: (ctx: ColumnExprIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprIdentifier`
	 * labeled alternative in `TRQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprIdentifier?: (ctx: TableExprIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprFunction`
	 * labeled alternative in `TRQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprFunction?: (ctx: TableExprFunctionContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprSubquery`
	 * labeled alternative in `TRQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprSubquery?: (ctx: TableExprSubqueryContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprAlias`
	 * labeled alternative in `TRQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprAlias?: (ctx: TableExprAliasContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprTag`
	 * labeled alternative in `TRQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprTag?: (ctx: TableExprTagContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprPlaceholder`
	 * labeled alternative in `TRQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprPlaceholder?: (ctx: TableExprPlaceholderContext) => Result;

	/**
	 * Visit a parse tree produced by the `WithExprSubquery`
	 * labeled alternative in `TRQLParser.withExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWithExprSubquery?: (ctx: WithExprSubqueryContext) => Result;

	/**
	 * Visit a parse tree produced by the `WithExprColumn`
	 * labeled alternative in `TRQLParser.withExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWithExprColumn?: (ctx: WithExprColumnContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinExprOp`
	 * labeled alternative in `TRQLParser.joinExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinExprOp?: (ctx: JoinExprOpContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinExprCrossOp`
	 * labeled alternative in `TRQLParser.joinExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinExprCrossOp?: (ctx: JoinExprCrossOpContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinExprTable`
	 * labeled alternative in `TRQLParser.joinExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinExprTable?: (ctx: JoinExprTableContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinExprParens`
	 * labeled alternative in `TRQLParser.joinExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinExprParens?: (ctx: JoinExprParensContext) => Result;

	/**
	 * Visit a parse tree produced by the `frameStart`
	 * labeled alternative in `TRQLParser.winFrameExtend`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFrameStart?: (ctx: FrameStartContext) => Result;

	/**
	 * Visit a parse tree produced by the `frameBetween`
	 * labeled alternative in `TRQLParser.winFrameExtend`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFrameBetween?: (ctx: FrameBetweenContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnTypeExprSimple`
	 * labeled alternative in `TRQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExprSimple?: (ctx: ColumnTypeExprSimpleContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnTypeExprNested`
	 * labeled alternative in `TRQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExprNested?: (ctx: ColumnTypeExprNestedContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnTypeExprEnum`
	 * labeled alternative in `TRQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExprEnum?: (ctx: ColumnTypeExprEnumContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnTypeExprComplex`
	 * labeled alternative in `TRQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExprComplex?: (ctx: ColumnTypeExprComplexContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnTypeExprParam`
	 * labeled alternative in `TRQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExprParam?: (ctx: ColumnTypeExprParamContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.program`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitProgram?: (ctx: ProgramContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.declaration`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitDeclaration?: (ctx: DeclarationContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.expression`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitExpression?: (ctx: ExpressionContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.varDecl`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitVarDecl?: (ctx: VarDeclContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.identifierList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitIdentifierList?: (ctx: IdentifierListContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.statement`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitStatement?: (ctx: StatementContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.returnStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitReturnStmt?: (ctx: ReturnStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.throwStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitThrowStmt?: (ctx: ThrowStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.catchBlock`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitCatchBlock?: (ctx: CatchBlockContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.tryCatchStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTryCatchStmt?: (ctx: TryCatchStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.ifStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitIfStmt?: (ctx: IfStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.whileStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWhileStmt?: (ctx: WhileStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.forStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitForStmt?: (ctx: ForStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.forInStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitForInStmt?: (ctx: ForInStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.funcStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFuncStmt?: (ctx: FuncStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.varAssignment`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitVarAssignment?: (ctx: VarAssignmentContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.exprStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitExprStmt?: (ctx: ExprStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.emptyStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitEmptyStmt?: (ctx: EmptyStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.block`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitBlock?: (ctx: BlockContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.kvPair`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitKvPair?: (ctx: KvPairContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.kvPairList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitKvPairList?: (ctx: KvPairListContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.select`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSelect?: (ctx: SelectContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.selectStmtWithParens`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSelectStmtWithParens?: (ctx: SelectStmtWithParensContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.subsequentSelectSetClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSubsequentSelectSetClause?: (ctx: SubsequentSelectSetClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.selectSetStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSelectSetStmt?: (ctx: SelectSetStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.selectStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSelectStmt?: (ctx: SelectStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.withClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWithClause?: (ctx: WithClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.topClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTopClause?: (ctx: TopClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.fromClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFromClause?: (ctx: FromClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.arrayJoinClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitArrayJoinClause?: (ctx: ArrayJoinClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.windowClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWindowClause?: (ctx: WindowClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.prewhereClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitPrewhereClause?: (ctx: PrewhereClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.whereClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWhereClause?: (ctx: WhereClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.groupByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitGroupByClause?: (ctx: GroupByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.havingClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitHavingClause?: (ctx: HavingClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.orderByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitOrderByClause?: (ctx: OrderByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.projectionOrderByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitProjectionOrderByClause?: (ctx: ProjectionOrderByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.limitByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitLimitByClause?: (ctx: LimitByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.limitAndOffsetClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitLimitAndOffsetClause?: (ctx: LimitAndOffsetClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.offsetOnlyClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitOffsetOnlyClause?: (ctx: OffsetOnlyClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.settingsClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSettingsClause?: (ctx: SettingsClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.joinExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinExpr?: (ctx: JoinExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.joinOp`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinOp?: (ctx: JoinOpContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.joinOpCross`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinOpCross?: (ctx: JoinOpCrossContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.joinConstraintClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinConstraintClause?: (ctx: JoinConstraintClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.sampleClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSampleClause?: (ctx: SampleClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.limitExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitLimitExpr?: (ctx: LimitExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.orderExprList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitOrderExprList?: (ctx: OrderExprListContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.orderExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitOrderExpr?: (ctx: OrderExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.ratioExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitRatioExpr?: (ctx: RatioExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.settingExprList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSettingExprList?: (ctx: SettingExprListContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.settingExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSettingExpr?: (ctx: SettingExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.windowExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWindowExpr?: (ctx: WindowExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.winPartitionByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWinPartitionByClause?: (ctx: WinPartitionByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.winOrderByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWinOrderByClause?: (ctx: WinOrderByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.winFrameClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWinFrameClause?: (ctx: WinFrameClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.winFrameExtend`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWinFrameExtend?: (ctx: WinFrameExtendContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.winFrameBound`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWinFrameBound?: (ctx: WinFrameBoundContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.expr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitExpr?: (ctx: ExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExpr?: (ctx: ColumnTypeExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.columnExprList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprList?: (ctx: ColumnExprListContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExpr?: (ctx: ColumnExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.columnLambdaExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnLambdaExpr?: (ctx: ColumnLambdaExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.tRQLxChildElement`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTRQLxChildElement?: (ctx: TRQLxChildElementContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.tRQLxTagElement`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTRQLxTagElement?: (ctx: TRQLxTagElementContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.tRQLxTagAttribute`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTRQLxTagAttribute?: (ctx: TRQLxTagAttributeContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.withExprList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWithExprList?: (ctx: WithExprListContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.withExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWithExpr?: (ctx: WithExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.columnIdentifier`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnIdentifier?: (ctx: ColumnIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.nestedIdentifier`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitNestedIdentifier?: (ctx: NestedIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExpr?: (ctx: TableExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.tableFunctionExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableFunctionExpr?: (ctx: TableFunctionExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.tableIdentifier`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableIdentifier?: (ctx: TableIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.tableArgList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableArgList?: (ctx: TableArgListContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.databaseIdentifier`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitDatabaseIdentifier?: (ctx: DatabaseIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.floatingLiteral`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFloatingLiteral?: (ctx: FloatingLiteralContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.numberLiteral`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitNumberLiteral?: (ctx: NumberLiteralContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.literal`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitLiteral?: (ctx: LiteralContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.interval`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitInterval?: (ctx: IntervalContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.keyword`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitKeyword?: (ctx: KeywordContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.keywordForAlias`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitKeywordForAlias?: (ctx: KeywordForAliasContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.alias`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitAlias?: (ctx: AliasContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.identifier`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitIdentifier?: (ctx: IdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.enumValue`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitEnumValue?: (ctx: EnumValueContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.placeholder`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitPlaceholder?: (ctx: PlaceholderContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.string`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitString?: (ctx: StringContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.templateString`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTemplateString?: (ctx: TemplateStringContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.stringContents`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitStringContents?: (ctx: StringContentsContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.fullTemplateString`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFullTemplateString?: (ctx: FullTemplateStringContext) => Result;

	/**
	 * Visit a parse tree produced by `TRQLParser.stringContentsFull`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitStringContentsFull?: (ctx: StringContentsFullContext) => Result;
}

