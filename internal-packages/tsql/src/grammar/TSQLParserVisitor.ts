// Generated from src/grammar/TSQLParser.g4 by ANTLR 4.9.0-SNAPSHOT


import { ParseTreeVisitor } from "antlr4ts/tree/ParseTreeVisitor";

import { JoinOpInnerContext } from "./TSQLParser";
import { JoinOpLeftRightContext } from "./TSQLParser";
import { JoinOpFullContext } from "./TSQLParser";
import { ColumnExprCaseContext } from "./TSQLParser";
import { ColumnExprCastContext } from "./TSQLParser";
import { ColumnExprDateContext } from "./TSQLParser";
import { ColumnExprIntervalStringContext } from "./TSQLParser";
import { ColumnExprIntervalContext } from "./TSQLParser";
import { ColumnExprSubstringContext } from "./TSQLParser";
import { ColumnExprTimestampContext } from "./TSQLParser";
import { ColumnExprTrimContext } from "./TSQLParser";
import { ColumnExprWinFunctionContext } from "./TSQLParser";
import { ColumnExprWinFunctionTargetContext } from "./TSQLParser";
import { ColumnExprFunctionContext } from "./TSQLParser";
import { ColumnExprCallSelectContext } from "./TSQLParser";
import { ColumnExprCallContext } from "./TSQLParser";
import { ColumnExprTagElementContext } from "./TSQLParser";
import { ColumnExprTemplateStringContext } from "./TSQLParser";
import { ColumnExprLiteralContext } from "./TSQLParser";
import { ColumnExprArrayAccessContext } from "./TSQLParser";
import { ColumnExprTupleAccessContext } from "./TSQLParser";
import { ColumnExprPropertyAccessContext } from "./TSQLParser";
import { ColumnExprNullArrayAccessContext } from "./TSQLParser";
import { ColumnExprNullTupleAccessContext } from "./TSQLParser";
import { ColumnExprNullPropertyAccessContext } from "./TSQLParser";
import { ColumnExprNegateContext } from "./TSQLParser";
import { ColumnExprPrecedence1Context } from "./TSQLParser";
import { ColumnExprPrecedence2Context } from "./TSQLParser";
import { ColumnExprPrecedence3Context } from "./TSQLParser";
import { ColumnExprIsNullContext } from "./TSQLParser";
import { ColumnExprNullishContext } from "./TSQLParser";
import { ColumnExprNotContext } from "./TSQLParser";
import { ColumnExprAndContext } from "./TSQLParser";
import { ColumnExprOrContext } from "./TSQLParser";
import { ColumnExprBetweenContext } from "./TSQLParser";
import { ColumnExprTernaryOpContext } from "./TSQLParser";
import { ColumnExprAliasContext } from "./TSQLParser";
import { ColumnExprAsteriskContext } from "./TSQLParser";
import { ColumnExprSubqueryContext } from "./TSQLParser";
import { ColumnExprParensContext } from "./TSQLParser";
import { ColumnExprTupleContext } from "./TSQLParser";
import { ColumnExprArrayContext } from "./TSQLParser";
import { ColumnExprDictContext } from "./TSQLParser";
import { ColumnExprLambdaContext } from "./TSQLParser";
import { ColumnExprIdentifierContext } from "./TSQLParser";
import { TableExprIdentifierContext } from "./TSQLParser";
import { TableExprFunctionContext } from "./TSQLParser";
import { TableExprSubqueryContext } from "./TSQLParser";
import { TableExprAliasContext } from "./TSQLParser";
import { TableExprTagContext } from "./TSQLParser";
import { TableExprPlaceholderContext } from "./TSQLParser";
import { WithExprSubqueryContext } from "./TSQLParser";
import { WithExprColumnContext } from "./TSQLParser";
import { JoinExprOpContext } from "./TSQLParser";
import { JoinExprCrossOpContext } from "./TSQLParser";
import { JoinExprTableContext } from "./TSQLParser";
import { JoinExprParensContext } from "./TSQLParser";
import { FrameStartContext } from "./TSQLParser";
import { FrameBetweenContext } from "./TSQLParser";
import { ColumnTypeExprSimpleContext } from "./TSQLParser";
import { ColumnTypeExprNestedContext } from "./TSQLParser";
import { ColumnTypeExprEnumContext } from "./TSQLParser";
import { ColumnTypeExprComplexContext } from "./TSQLParser";
import { ColumnTypeExprParamContext } from "./TSQLParser";
import { ProgramContext } from "./TSQLParser";
import { DeclarationContext } from "./TSQLParser";
import { ExpressionContext } from "./TSQLParser";
import { VarDeclContext } from "./TSQLParser";
import { IdentifierListContext } from "./TSQLParser";
import { StatementContext } from "./TSQLParser";
import { ReturnStmtContext } from "./TSQLParser";
import { ThrowStmtContext } from "./TSQLParser";
import { CatchBlockContext } from "./TSQLParser";
import { TryCatchStmtContext } from "./TSQLParser";
import { IfStmtContext } from "./TSQLParser";
import { WhileStmtContext } from "./TSQLParser";
import { ForStmtContext } from "./TSQLParser";
import { ForInStmtContext } from "./TSQLParser";
import { FuncStmtContext } from "./TSQLParser";
import { VarAssignmentContext } from "./TSQLParser";
import { ExprStmtContext } from "./TSQLParser";
import { EmptyStmtContext } from "./TSQLParser";
import { BlockContext } from "./TSQLParser";
import { KvPairContext } from "./TSQLParser";
import { KvPairListContext } from "./TSQLParser";
import { SelectContext } from "./TSQLParser";
import { SelectStmtWithParensContext } from "./TSQLParser";
import { SubsequentSelectSetClauseContext } from "./TSQLParser";
import { SelectSetStmtContext } from "./TSQLParser";
import { SelectStmtContext } from "./TSQLParser";
import { WithClauseContext } from "./TSQLParser";
import { TopClauseContext } from "./TSQLParser";
import { FromClauseContext } from "./TSQLParser";
import { ArrayJoinClauseContext } from "./TSQLParser";
import { WindowClauseContext } from "./TSQLParser";
import { PrewhereClauseContext } from "./TSQLParser";
import { WhereClauseContext } from "./TSQLParser";
import { GroupByClauseContext } from "./TSQLParser";
import { HavingClauseContext } from "./TSQLParser";
import { OrderByClauseContext } from "./TSQLParser";
import { ProjectionOrderByClauseContext } from "./TSQLParser";
import { LimitByClauseContext } from "./TSQLParser";
import { LimitAndOffsetClauseContext } from "./TSQLParser";
import { OffsetOnlyClauseContext } from "./TSQLParser";
import { SettingsClauseContext } from "./TSQLParser";
import { JoinExprContext } from "./TSQLParser";
import { JoinOpContext } from "./TSQLParser";
import { JoinOpCrossContext } from "./TSQLParser";
import { JoinConstraintClauseContext } from "./TSQLParser";
import { SampleClauseContext } from "./TSQLParser";
import { LimitExprContext } from "./TSQLParser";
import { OrderExprListContext } from "./TSQLParser";
import { OrderExprContext } from "./TSQLParser";
import { RatioExprContext } from "./TSQLParser";
import { SettingExprListContext } from "./TSQLParser";
import { SettingExprContext } from "./TSQLParser";
import { WindowExprContext } from "./TSQLParser";
import { WinPartitionByClauseContext } from "./TSQLParser";
import { WinOrderByClauseContext } from "./TSQLParser";
import { WinFrameClauseContext } from "./TSQLParser";
import { WinFrameExtendContext } from "./TSQLParser";
import { WinFrameBoundContext } from "./TSQLParser";
import { ExprContext } from "./TSQLParser";
import { ColumnTypeExprContext } from "./TSQLParser";
import { ColumnExprListContext } from "./TSQLParser";
import { ColumnExprContext } from "./TSQLParser";
import { ColumnLambdaExprContext } from "./TSQLParser";
import { TSQLxChildElementContext } from "./TSQLParser";
import { TSQLxTagElementContext } from "./TSQLParser";
import { TSQLxTagAttributeContext } from "./TSQLParser";
import { WithExprListContext } from "./TSQLParser";
import { WithExprContext } from "./TSQLParser";
import { ColumnIdentifierContext } from "./TSQLParser";
import { NestedIdentifierContext } from "./TSQLParser";
import { TableExprContext } from "./TSQLParser";
import { TableFunctionExprContext } from "./TSQLParser";
import { TableIdentifierContext } from "./TSQLParser";
import { TableArgListContext } from "./TSQLParser";
import { DatabaseIdentifierContext } from "./TSQLParser";
import { FloatingLiteralContext } from "./TSQLParser";
import { NumberLiteralContext } from "./TSQLParser";
import { LiteralContext } from "./TSQLParser";
import { IntervalContext } from "./TSQLParser";
import { KeywordContext } from "./TSQLParser";
import { KeywordForAliasContext } from "./TSQLParser";
import { AliasContext } from "./TSQLParser";
import { IdentifierContext } from "./TSQLParser";
import { EnumValueContext } from "./TSQLParser";
import { PlaceholderContext } from "./TSQLParser";
import { StringContext } from "./TSQLParser";
import { TemplateStringContext } from "./TSQLParser";
import { StringContentsContext } from "./TSQLParser";
import { FullTemplateStringContext } from "./TSQLParser";
import { StringContentsFullContext } from "./TSQLParser";


/**
 * This interface defines a complete generic visitor for a parse tree produced
 * by `TSQLParser`.
 *
 * @param <Result> The return type of the visit operation. Use `void` for
 * operations with no return type.
 */
export interface TSQLParserVisitor<Result> extends ParseTreeVisitor<Result> {
	/**
	 * Visit a parse tree produced by the `JoinOpInner`
	 * labeled alternative in `TSQLParser.joinOp`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinOpInner?: (ctx: JoinOpInnerContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinOpLeftRight`
	 * labeled alternative in `TSQLParser.joinOp`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinOpLeftRight?: (ctx: JoinOpLeftRightContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinOpFull`
	 * labeled alternative in `TSQLParser.joinOp`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinOpFull?: (ctx: JoinOpFullContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprCase`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprCase?: (ctx: ColumnExprCaseContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprCast`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprCast?: (ctx: ColumnExprCastContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprDate`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprDate?: (ctx: ColumnExprDateContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprIntervalString`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprIntervalString?: (ctx: ColumnExprIntervalStringContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprInterval`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprInterval?: (ctx: ColumnExprIntervalContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprSubstring`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprSubstring?: (ctx: ColumnExprSubstringContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTimestamp`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTimestamp?: (ctx: ColumnExprTimestampContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTrim`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTrim?: (ctx: ColumnExprTrimContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprWinFunction`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprWinFunction?: (ctx: ColumnExprWinFunctionContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprWinFunctionTarget`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprWinFunctionTarget?: (ctx: ColumnExprWinFunctionTargetContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprFunction`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprFunction?: (ctx: ColumnExprFunctionContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprCallSelect`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprCallSelect?: (ctx: ColumnExprCallSelectContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprCall`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprCall?: (ctx: ColumnExprCallContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTagElement`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTagElement?: (ctx: ColumnExprTagElementContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTemplateString`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTemplateString?: (ctx: ColumnExprTemplateStringContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprLiteral`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprLiteral?: (ctx: ColumnExprLiteralContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprArrayAccess`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprArrayAccess?: (ctx: ColumnExprArrayAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTupleAccess`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTupleAccess?: (ctx: ColumnExprTupleAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprPropertyAccess`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprPropertyAccess?: (ctx: ColumnExprPropertyAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNullArrayAccess`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNullArrayAccess?: (ctx: ColumnExprNullArrayAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNullTupleAccess`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNullTupleAccess?: (ctx: ColumnExprNullTupleAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNullPropertyAccess`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNullPropertyAccess?: (ctx: ColumnExprNullPropertyAccessContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNegate`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNegate?: (ctx: ColumnExprNegateContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprPrecedence1`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprPrecedence1?: (ctx: ColumnExprPrecedence1Context) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprPrecedence2`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprPrecedence2?: (ctx: ColumnExprPrecedence2Context) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprPrecedence3`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprPrecedence3?: (ctx: ColumnExprPrecedence3Context) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprIsNull`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprIsNull?: (ctx: ColumnExprIsNullContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNullish`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNullish?: (ctx: ColumnExprNullishContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprNot`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprNot?: (ctx: ColumnExprNotContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprAnd`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprAnd?: (ctx: ColumnExprAndContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprOr`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprOr?: (ctx: ColumnExprOrContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprBetween`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprBetween?: (ctx: ColumnExprBetweenContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTernaryOp`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTernaryOp?: (ctx: ColumnExprTernaryOpContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprAlias`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprAlias?: (ctx: ColumnExprAliasContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprAsterisk`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprAsterisk?: (ctx: ColumnExprAsteriskContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprSubquery`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprSubquery?: (ctx: ColumnExprSubqueryContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprParens`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprParens?: (ctx: ColumnExprParensContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprTuple`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprTuple?: (ctx: ColumnExprTupleContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprArray`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprArray?: (ctx: ColumnExprArrayContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprDict`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprDict?: (ctx: ColumnExprDictContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprLambda`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprLambda?: (ctx: ColumnExprLambdaContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnExprIdentifier`
	 * labeled alternative in `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprIdentifier?: (ctx: ColumnExprIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprIdentifier`
	 * labeled alternative in `TSQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprIdentifier?: (ctx: TableExprIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprFunction`
	 * labeled alternative in `TSQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprFunction?: (ctx: TableExprFunctionContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprSubquery`
	 * labeled alternative in `TSQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprSubquery?: (ctx: TableExprSubqueryContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprAlias`
	 * labeled alternative in `TSQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprAlias?: (ctx: TableExprAliasContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprTag`
	 * labeled alternative in `TSQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprTag?: (ctx: TableExprTagContext) => Result;

	/**
	 * Visit a parse tree produced by the `TableExprPlaceholder`
	 * labeled alternative in `TSQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExprPlaceholder?: (ctx: TableExprPlaceholderContext) => Result;

	/**
	 * Visit a parse tree produced by the `WithExprSubquery`
	 * labeled alternative in `TSQLParser.withExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWithExprSubquery?: (ctx: WithExprSubqueryContext) => Result;

	/**
	 * Visit a parse tree produced by the `WithExprColumn`
	 * labeled alternative in `TSQLParser.withExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWithExprColumn?: (ctx: WithExprColumnContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinExprOp`
	 * labeled alternative in `TSQLParser.joinExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinExprOp?: (ctx: JoinExprOpContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinExprCrossOp`
	 * labeled alternative in `TSQLParser.joinExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinExprCrossOp?: (ctx: JoinExprCrossOpContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinExprTable`
	 * labeled alternative in `TSQLParser.joinExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinExprTable?: (ctx: JoinExprTableContext) => Result;

	/**
	 * Visit a parse tree produced by the `JoinExprParens`
	 * labeled alternative in `TSQLParser.joinExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinExprParens?: (ctx: JoinExprParensContext) => Result;

	/**
	 * Visit a parse tree produced by the `frameStart`
	 * labeled alternative in `TSQLParser.winFrameExtend`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFrameStart?: (ctx: FrameStartContext) => Result;

	/**
	 * Visit a parse tree produced by the `frameBetween`
	 * labeled alternative in `TSQLParser.winFrameExtend`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFrameBetween?: (ctx: FrameBetweenContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnTypeExprSimple`
	 * labeled alternative in `TSQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExprSimple?: (ctx: ColumnTypeExprSimpleContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnTypeExprNested`
	 * labeled alternative in `TSQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExprNested?: (ctx: ColumnTypeExprNestedContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnTypeExprEnum`
	 * labeled alternative in `TSQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExprEnum?: (ctx: ColumnTypeExprEnumContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnTypeExprComplex`
	 * labeled alternative in `TSQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExprComplex?: (ctx: ColumnTypeExprComplexContext) => Result;

	/**
	 * Visit a parse tree produced by the `ColumnTypeExprParam`
	 * labeled alternative in `TSQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExprParam?: (ctx: ColumnTypeExprParamContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.program`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitProgram?: (ctx: ProgramContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.declaration`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitDeclaration?: (ctx: DeclarationContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.expression`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitExpression?: (ctx: ExpressionContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.varDecl`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitVarDecl?: (ctx: VarDeclContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.identifierList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitIdentifierList?: (ctx: IdentifierListContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.statement`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitStatement?: (ctx: StatementContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.returnStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitReturnStmt?: (ctx: ReturnStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.throwStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitThrowStmt?: (ctx: ThrowStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.catchBlock`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitCatchBlock?: (ctx: CatchBlockContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.tryCatchStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTryCatchStmt?: (ctx: TryCatchStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.ifStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitIfStmt?: (ctx: IfStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.whileStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWhileStmt?: (ctx: WhileStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.forStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitForStmt?: (ctx: ForStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.forInStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitForInStmt?: (ctx: ForInStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.funcStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFuncStmt?: (ctx: FuncStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.varAssignment`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitVarAssignment?: (ctx: VarAssignmentContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.exprStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitExprStmt?: (ctx: ExprStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.emptyStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitEmptyStmt?: (ctx: EmptyStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.block`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitBlock?: (ctx: BlockContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.kvPair`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitKvPair?: (ctx: KvPairContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.kvPairList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitKvPairList?: (ctx: KvPairListContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.select`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSelect?: (ctx: SelectContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.selectStmtWithParens`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSelectStmtWithParens?: (ctx: SelectStmtWithParensContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.subsequentSelectSetClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSubsequentSelectSetClause?: (ctx: SubsequentSelectSetClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.selectSetStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSelectSetStmt?: (ctx: SelectSetStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.selectStmt`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSelectStmt?: (ctx: SelectStmtContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.withClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWithClause?: (ctx: WithClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.topClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTopClause?: (ctx: TopClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.fromClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFromClause?: (ctx: FromClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.arrayJoinClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitArrayJoinClause?: (ctx: ArrayJoinClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.windowClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWindowClause?: (ctx: WindowClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.prewhereClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitPrewhereClause?: (ctx: PrewhereClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.whereClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWhereClause?: (ctx: WhereClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.groupByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitGroupByClause?: (ctx: GroupByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.havingClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitHavingClause?: (ctx: HavingClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.orderByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitOrderByClause?: (ctx: OrderByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.projectionOrderByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitProjectionOrderByClause?: (ctx: ProjectionOrderByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.limitByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitLimitByClause?: (ctx: LimitByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.limitAndOffsetClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitLimitAndOffsetClause?: (ctx: LimitAndOffsetClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.offsetOnlyClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitOffsetOnlyClause?: (ctx: OffsetOnlyClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.settingsClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSettingsClause?: (ctx: SettingsClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.joinExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinExpr?: (ctx: JoinExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.joinOp`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinOp?: (ctx: JoinOpContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.joinOpCross`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinOpCross?: (ctx: JoinOpCrossContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.joinConstraintClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitJoinConstraintClause?: (ctx: JoinConstraintClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.sampleClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSampleClause?: (ctx: SampleClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.limitExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitLimitExpr?: (ctx: LimitExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.orderExprList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitOrderExprList?: (ctx: OrderExprListContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.orderExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitOrderExpr?: (ctx: OrderExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.ratioExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitRatioExpr?: (ctx: RatioExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.settingExprList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSettingExprList?: (ctx: SettingExprListContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.settingExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitSettingExpr?: (ctx: SettingExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.windowExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWindowExpr?: (ctx: WindowExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.winPartitionByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWinPartitionByClause?: (ctx: WinPartitionByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.winOrderByClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWinOrderByClause?: (ctx: WinOrderByClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.winFrameClause`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWinFrameClause?: (ctx: WinFrameClauseContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.winFrameExtend`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWinFrameExtend?: (ctx: WinFrameExtendContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.winFrameBound`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWinFrameBound?: (ctx: WinFrameBoundContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.expr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitExpr?: (ctx: ExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.columnTypeExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnTypeExpr?: (ctx: ColumnTypeExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.columnExprList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExprList?: (ctx: ColumnExprListContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.columnExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnExpr?: (ctx: ColumnExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.columnLambdaExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnLambdaExpr?: (ctx: ColumnLambdaExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.tSQLxChildElement`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTSQLxChildElement?: (ctx: TSQLxChildElementContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.tSQLxTagElement`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTSQLxTagElement?: (ctx: TSQLxTagElementContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.tSQLxTagAttribute`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTSQLxTagAttribute?: (ctx: TSQLxTagAttributeContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.withExprList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWithExprList?: (ctx: WithExprListContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.withExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitWithExpr?: (ctx: WithExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.columnIdentifier`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitColumnIdentifier?: (ctx: ColumnIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.nestedIdentifier`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitNestedIdentifier?: (ctx: NestedIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.tableExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableExpr?: (ctx: TableExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.tableFunctionExpr`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableFunctionExpr?: (ctx: TableFunctionExprContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.tableIdentifier`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableIdentifier?: (ctx: TableIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.tableArgList`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTableArgList?: (ctx: TableArgListContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.databaseIdentifier`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitDatabaseIdentifier?: (ctx: DatabaseIdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.floatingLiteral`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFloatingLiteral?: (ctx: FloatingLiteralContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.numberLiteral`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitNumberLiteral?: (ctx: NumberLiteralContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.literal`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitLiteral?: (ctx: LiteralContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.interval`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitInterval?: (ctx: IntervalContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.keyword`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitKeyword?: (ctx: KeywordContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.keywordForAlias`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitKeywordForAlias?: (ctx: KeywordForAliasContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.alias`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitAlias?: (ctx: AliasContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.identifier`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitIdentifier?: (ctx: IdentifierContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.enumValue`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitEnumValue?: (ctx: EnumValueContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.placeholder`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitPlaceholder?: (ctx: PlaceholderContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.string`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitString?: (ctx: StringContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.templateString`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitTemplateString?: (ctx: TemplateStringContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.stringContents`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitStringContents?: (ctx: StringContentsContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.fullTemplateString`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitFullTemplateString?: (ctx: FullTemplateStringContext) => Result;

	/**
	 * Visit a parse tree produced by `TSQLParser.stringContentsFull`.
	 * @param ctx the parse tree
	 * @return the visitor result
	 */
	visitStringContentsFull?: (ctx: StringContentsFullContext) => Result;
}

