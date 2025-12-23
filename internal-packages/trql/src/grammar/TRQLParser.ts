// Generated from src/grammar/TRQLParser.g4 by ANTLR 4.9.0-SNAPSHOT


import { ATN } from "antlr4ts/atn/ATN";
import { ATNDeserializer } from "antlr4ts/atn/ATNDeserializer";
import { FailedPredicateException } from "antlr4ts/FailedPredicateException";
import { NotNull } from "antlr4ts/Decorators";
import { NoViableAltException } from "antlr4ts/NoViableAltException";
import { Override } from "antlr4ts/Decorators";
import { Parser } from "antlr4ts/Parser";
import { ParserRuleContext } from "antlr4ts/ParserRuleContext";
import { ParserATNSimulator } from "antlr4ts/atn/ParserATNSimulator";
import { ParseTreeListener } from "antlr4ts/tree/ParseTreeListener";
import { ParseTreeVisitor } from "antlr4ts/tree/ParseTreeVisitor";
import { RecognitionException } from "antlr4ts/RecognitionException";
import { RuleContext } from "antlr4ts/RuleContext";
//import { RuleVersion } from "antlr4ts/RuleVersion";
import { TerminalNode } from "antlr4ts/tree/TerminalNode";
import { Token } from "antlr4ts/Token";
import { TokenStream } from "antlr4ts/TokenStream";
import { Vocabulary } from "antlr4ts/Vocabulary";
import { VocabularyImpl } from "antlr4ts/VocabularyImpl";

import * as Utils from "antlr4ts/misc/Utils";

import { TRQLParserVisitor } from "./TRQLParserVisitor";


export class TRQLParser extends Parser {
	public static readonly ALL = 1;
	public static readonly AND = 2;
	public static readonly ANTI = 3;
	public static readonly ANY = 4;
	public static readonly ARRAY = 5;
	public static readonly AS = 6;
	public static readonly ASCENDING = 7;
	public static readonly ASOF = 8;
	public static readonly BETWEEN = 9;
	public static readonly BOTH = 10;
	public static readonly BY = 11;
	public static readonly CASE = 12;
	public static readonly CAST = 13;
	public static readonly CATCH = 14;
	public static readonly COHORT = 15;
	public static readonly COLLATE = 16;
	public static readonly CROSS = 17;
	public static readonly CUBE = 18;
	public static readonly CURRENT = 19;
	public static readonly DATE = 20;
	public static readonly DAY = 21;
	public static readonly DESC = 22;
	public static readonly DESCENDING = 23;
	public static readonly DISTINCT = 24;
	public static readonly ELSE = 25;
	public static readonly END = 26;
	public static readonly EXCEPT = 27;
	public static readonly EXTRACT = 28;
	public static readonly FINAL = 29;
	public static readonly FINALLY = 30;
	public static readonly FIRST = 31;
	public static readonly FN = 32;
	public static readonly FOLLOWING = 33;
	public static readonly FOR = 34;
	public static readonly FROM = 35;
	public static readonly FULL = 36;
	public static readonly FUN = 37;
	public static readonly GROUP = 38;
	public static readonly HAVING = 39;
	public static readonly HOUR = 40;
	public static readonly ID = 41;
	public static readonly IF = 42;
	public static readonly ILIKE = 43;
	public static readonly IN = 44;
	public static readonly INF = 45;
	public static readonly INNER = 46;
	public static readonly INTERSECT = 47;
	public static readonly INTERVAL = 48;
	public static readonly IS = 49;
	public static readonly JOIN = 50;
	public static readonly KEY = 51;
	public static readonly LAST = 52;
	public static readonly LEADING = 53;
	public static readonly LEFT = 54;
	public static readonly LET = 55;
	public static readonly LIKE = 56;
	public static readonly LIMIT = 57;
	public static readonly MINUTE = 58;
	public static readonly MONTH = 59;
	public static readonly NAN_SQL = 60;
	public static readonly NOT = 61;
	public static readonly NULL_SQL = 62;
	public static readonly NULLS = 63;
	public static readonly OFFSET = 64;
	public static readonly ON = 65;
	public static readonly OR = 66;
	public static readonly ORDER = 67;
	public static readonly OUTER = 68;
	public static readonly OVER = 69;
	public static readonly PARTITION = 70;
	public static readonly PRECEDING = 71;
	public static readonly PREWHERE = 72;
	public static readonly QUARTER = 73;
	public static readonly RANGE = 74;
	public static readonly RETURN = 75;
	public static readonly RIGHT = 76;
	public static readonly ROLLUP = 77;
	public static readonly ROW = 78;
	public static readonly ROWS = 79;
	public static readonly SAMPLE = 80;
	public static readonly SECOND = 81;
	public static readonly SELECT = 82;
	public static readonly SEMI = 83;
	public static readonly SETTINGS = 84;
	public static readonly SUBSTRING = 85;
	public static readonly THEN = 86;
	public static readonly THROW = 87;
	public static readonly TIES = 88;
	public static readonly TIMESTAMP = 89;
	public static readonly TO = 90;
	public static readonly TOP = 91;
	public static readonly TOTALS = 92;
	public static readonly TRAILING = 93;
	public static readonly TRIM = 94;
	public static readonly TRUNCATE = 95;
	public static readonly TRY = 96;
	public static readonly UNBOUNDED = 97;
	public static readonly UNION = 98;
	public static readonly USING = 99;
	public static readonly WEEK = 100;
	public static readonly WHEN = 101;
	public static readonly WHERE = 102;
	public static readonly WHILE = 103;
	public static readonly WINDOW = 104;
	public static readonly WITH = 105;
	public static readonly YEAR = 106;
	public static readonly ESCAPE_CHAR_COMMON = 107;
	public static readonly IDENTIFIER = 108;
	public static readonly FLOATING_LITERAL = 109;
	public static readonly OCTAL_LITERAL = 110;
	public static readonly DECIMAL_LITERAL = 111;
	public static readonly HEXADECIMAL_LITERAL = 112;
	public static readonly STRING_LITERAL = 113;
	public static readonly ARROW = 114;
	public static readonly ASTERISK = 115;
	public static readonly BACKQUOTE = 116;
	public static readonly BACKSLASH = 117;
	public static readonly COLON = 118;
	public static readonly COMMA = 119;
	public static readonly CONCAT = 120;
	public static readonly DASH = 121;
	public static readonly DOLLAR = 122;
	public static readonly DOT = 123;
	public static readonly EQ_DOUBLE = 124;
	public static readonly EQ_SINGLE = 125;
	public static readonly GT_EQ = 126;
	public static readonly GT = 127;
	public static readonly HASH = 128;
	public static readonly IREGEX_SINGLE = 129;
	public static readonly IREGEX_DOUBLE = 130;
	public static readonly LBRACE = 131;
	public static readonly LBRACKET = 132;
	public static readonly LPAREN = 133;
	public static readonly LT_EQ = 134;
	public static readonly LT = 135;
	public static readonly LT_SLASH = 136;
	public static readonly NOT_EQ = 137;
	public static readonly NOT_IREGEX = 138;
	public static readonly NOT_REGEX = 139;
	public static readonly NULL_PROPERTY = 140;
	public static readonly NULLISH = 141;
	public static readonly PERCENT = 142;
	public static readonly PLUS = 143;
	public static readonly QUERY = 144;
	public static readonly QUOTE_DOUBLE = 145;
	public static readonly QUOTE_SINGLE_TEMPLATE = 146;
	public static readonly QUOTE_SINGLE_TEMPLATE_FULL = 147;
	public static readonly QUOTE_SINGLE = 148;
	public static readonly REGEX_SINGLE = 149;
	public static readonly REGEX_DOUBLE = 150;
	public static readonly RBRACE = 151;
	public static readonly RBRACKET = 152;
	public static readonly RPAREN = 153;
	public static readonly SEMICOLON = 154;
	public static readonly SLASH = 155;
	public static readonly SLASH_GT = 156;
	public static readonly UNDERSCORE = 157;
	public static readonly MULTI_LINE_COMMENT = 158;
	public static readonly SINGLE_LINE_COMMENT = 159;
	public static readonly WHITESPACE = 160;
	public static readonly STRING_TEXT = 161;
	public static readonly STRING_ESCAPE_TRIGGER = 162;
	public static readonly FULL_STRING_TEXT = 163;
	public static readonly FULL_STRING_ESCAPE_TRIGGER = 164;
	public static readonly TAG_WS = 165;
	public static readonly TAGC_WS = 166;
	public static readonly TRQLX_TEXT_TEXT = 167;
	public static readonly TRQLX_TEXT_WS = 168;
	public static readonly RULE_program = 0;
	public static readonly RULE_declaration = 1;
	public static readonly RULE_expression = 2;
	public static readonly RULE_varDecl = 3;
	public static readonly RULE_identifierList = 4;
	public static readonly RULE_statement = 5;
	public static readonly RULE_returnStmt = 6;
	public static readonly RULE_throwStmt = 7;
	public static readonly RULE_catchBlock = 8;
	public static readonly RULE_tryCatchStmt = 9;
	public static readonly RULE_ifStmt = 10;
	public static readonly RULE_whileStmt = 11;
	public static readonly RULE_forStmt = 12;
	public static readonly RULE_forInStmt = 13;
	public static readonly RULE_funcStmt = 14;
	public static readonly RULE_varAssignment = 15;
	public static readonly RULE_exprStmt = 16;
	public static readonly RULE_emptyStmt = 17;
	public static readonly RULE_block = 18;
	public static readonly RULE_kvPair = 19;
	public static readonly RULE_kvPairList = 20;
	public static readonly RULE_select = 21;
	public static readonly RULE_selectStmtWithParens = 22;
	public static readonly RULE_subsequentSelectSetClause = 23;
	public static readonly RULE_selectSetStmt = 24;
	public static readonly RULE_selectStmt = 25;
	public static readonly RULE_withClause = 26;
	public static readonly RULE_topClause = 27;
	public static readonly RULE_fromClause = 28;
	public static readonly RULE_arrayJoinClause = 29;
	public static readonly RULE_windowClause = 30;
	public static readonly RULE_prewhereClause = 31;
	public static readonly RULE_whereClause = 32;
	public static readonly RULE_groupByClause = 33;
	public static readonly RULE_havingClause = 34;
	public static readonly RULE_orderByClause = 35;
	public static readonly RULE_projectionOrderByClause = 36;
	public static readonly RULE_limitByClause = 37;
	public static readonly RULE_limitAndOffsetClause = 38;
	public static readonly RULE_offsetOnlyClause = 39;
	public static readonly RULE_settingsClause = 40;
	public static readonly RULE_joinExpr = 41;
	public static readonly RULE_joinOp = 42;
	public static readonly RULE_joinOpCross = 43;
	public static readonly RULE_joinConstraintClause = 44;
	public static readonly RULE_sampleClause = 45;
	public static readonly RULE_limitExpr = 46;
	public static readonly RULE_orderExprList = 47;
	public static readonly RULE_orderExpr = 48;
	public static readonly RULE_ratioExpr = 49;
	public static readonly RULE_settingExprList = 50;
	public static readonly RULE_settingExpr = 51;
	public static readonly RULE_windowExpr = 52;
	public static readonly RULE_winPartitionByClause = 53;
	public static readonly RULE_winOrderByClause = 54;
	public static readonly RULE_winFrameClause = 55;
	public static readonly RULE_winFrameExtend = 56;
	public static readonly RULE_winFrameBound = 57;
	public static readonly RULE_expr = 58;
	public static readonly RULE_columnTypeExpr = 59;
	public static readonly RULE_columnExprList = 60;
	public static readonly RULE_columnExpr = 61;
	public static readonly RULE_columnLambdaExpr = 62;
	public static readonly RULE_tRQLxChildElement = 63;
	public static readonly RULE_tRQLxTagElement = 64;
	public static readonly RULE_tRQLxTagAttribute = 65;
	public static readonly RULE_withExprList = 66;
	public static readonly RULE_withExpr = 67;
	public static readonly RULE_columnIdentifier = 68;
	public static readonly RULE_nestedIdentifier = 69;
	public static readonly RULE_tableExpr = 70;
	public static readonly RULE_tableFunctionExpr = 71;
	public static readonly RULE_tableIdentifier = 72;
	public static readonly RULE_tableArgList = 73;
	public static readonly RULE_databaseIdentifier = 74;
	public static readonly RULE_floatingLiteral = 75;
	public static readonly RULE_numberLiteral = 76;
	public static readonly RULE_literal = 77;
	public static readonly RULE_interval = 78;
	public static readonly RULE_keyword = 79;
	public static readonly RULE_keywordForAlias = 80;
	public static readonly RULE_alias = 81;
	public static readonly RULE_identifier = 82;
	public static readonly RULE_enumValue = 83;
	public static readonly RULE_placeholder = 84;
	public static readonly RULE_string = 85;
	public static readonly RULE_templateString = 86;
	public static readonly RULE_stringContents = 87;
	public static readonly RULE_fullTemplateString = 88;
	public static readonly RULE_stringContentsFull = 89;
	// tslint:disable:no-trailing-whitespace
	public static readonly ruleNames: string[] = [
		"program", "declaration", "expression", "varDecl", "identifierList", "statement", 
		"returnStmt", "throwStmt", "catchBlock", "tryCatchStmt", "ifStmt", "whileStmt", 
		"forStmt", "forInStmt", "funcStmt", "varAssignment", "exprStmt", "emptyStmt", 
		"block", "kvPair", "kvPairList", "select", "selectStmtWithParens", "subsequentSelectSetClause", 
		"selectSetStmt", "selectStmt", "withClause", "topClause", "fromClause", 
		"arrayJoinClause", "windowClause", "prewhereClause", "whereClause", "groupByClause", 
		"havingClause", "orderByClause", "projectionOrderByClause", "limitByClause", 
		"limitAndOffsetClause", "offsetOnlyClause", "settingsClause", "joinExpr", 
		"joinOp", "joinOpCross", "joinConstraintClause", "sampleClause", "limitExpr", 
		"orderExprList", "orderExpr", "ratioExpr", "settingExprList", "settingExpr", 
		"windowExpr", "winPartitionByClause", "winOrderByClause", "winFrameClause", 
		"winFrameExtend", "winFrameBound", "expr", "columnTypeExpr", "columnExprList", 
		"columnExpr", "columnLambdaExpr", "tRQLxChildElement", "tRQLxTagElement", 
		"tRQLxTagAttribute", "withExprList", "withExpr", "columnIdentifier", "nestedIdentifier", 
		"tableExpr", "tableFunctionExpr", "tableIdentifier", "tableArgList", "databaseIdentifier", 
		"floatingLiteral", "numberLiteral", "literal", "interval", "keyword", 
		"keywordForAlias", "alias", "identifier", "enumValue", "placeholder", 
		"string", "templateString", "stringContents", "fullTemplateString", "stringContentsFull",
	];

	private static readonly _LITERAL_NAMES: Array<string | undefined> = [
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, 
		undefined, undefined, "'->'", "'*'", "'`'", "'\\'", "':'", "','", "'||'", 
		"'-'", "'$'", "'.'", "'=='", undefined, "'>='", undefined, "'#'", "'~*'", 
		"'=~*'", "'{'", "'['", "'('", "'<='", "'<'", "'</'", undefined, "'!~*'", 
		"'!~'", "'?.'", "'??'", "'%'", "'+'", "'?'", "'\"'", "'f''", "'F''", "'''", 
		"'~'", "'=~'", "'}'", "']'", "')'", "';'", "'/'", undefined, "'_'",
	];
	private static readonly _SYMBOLIC_NAMES: Array<string | undefined> = [
		undefined, "ALL", "AND", "ANTI", "ANY", "ARRAY", "AS", "ASCENDING", "ASOF", 
		"BETWEEN", "BOTH", "BY", "CASE", "CAST", "CATCH", "COHORT", "COLLATE", 
		"CROSS", "CUBE", "CURRENT", "DATE", "DAY", "DESC", "DESCENDING", "DISTINCT", 
		"ELSE", "END", "EXCEPT", "EXTRACT", "FINAL", "FINALLY", "FIRST", "FN", 
		"FOLLOWING", "FOR", "FROM", "FULL", "FUN", "GROUP", "HAVING", "HOUR", 
		"ID", "IF", "ILIKE", "IN", "INF", "INNER", "INTERSECT", "INTERVAL", "IS", 
		"JOIN", "KEY", "LAST", "LEADING", "LEFT", "LET", "LIKE", "LIMIT", "MINUTE", 
		"MONTH", "NAN_SQL", "NOT", "NULL_SQL", "NULLS", "OFFSET", "ON", "OR", 
		"ORDER", "OUTER", "OVER", "PARTITION", "PRECEDING", "PREWHERE", "QUARTER", 
		"RANGE", "RETURN", "RIGHT", "ROLLUP", "ROW", "ROWS", "SAMPLE", "SECOND", 
		"SELECT", "SEMI", "SETTINGS", "SUBSTRING", "THEN", "THROW", "TIES", "TIMESTAMP", 
		"TO", "TOP", "TOTALS", "TRAILING", "TRIM", "TRUNCATE", "TRY", "UNBOUNDED", 
		"UNION", "USING", "WEEK", "WHEN", "WHERE", "WHILE", "WINDOW", "WITH", 
		"YEAR", "ESCAPE_CHAR_COMMON", "IDENTIFIER", "FLOATING_LITERAL", "OCTAL_LITERAL", 
		"DECIMAL_LITERAL", "HEXADECIMAL_LITERAL", "STRING_LITERAL", "ARROW", "ASTERISK", 
		"BACKQUOTE", "BACKSLASH", "COLON", "COMMA", "CONCAT", "DASH", "DOLLAR", 
		"DOT", "EQ_DOUBLE", "EQ_SINGLE", "GT_EQ", "GT", "HASH", "IREGEX_SINGLE", 
		"IREGEX_DOUBLE", "LBRACE", "LBRACKET", "LPAREN", "LT_EQ", "LT", "LT_SLASH", 
		"NOT_EQ", "NOT_IREGEX", "NOT_REGEX", "NULL_PROPERTY", "NULLISH", "PERCENT", 
		"PLUS", "QUERY", "QUOTE_DOUBLE", "QUOTE_SINGLE_TEMPLATE", "QUOTE_SINGLE_TEMPLATE_FULL", 
		"QUOTE_SINGLE", "REGEX_SINGLE", "REGEX_DOUBLE", "RBRACE", "RBRACKET", 
		"RPAREN", "SEMICOLON", "SLASH", "SLASH_GT", "UNDERSCORE", "MULTI_LINE_COMMENT", 
		"SINGLE_LINE_COMMENT", "WHITESPACE", "STRING_TEXT", "STRING_ESCAPE_TRIGGER", 
		"FULL_STRING_TEXT", "FULL_STRING_ESCAPE_TRIGGER", "TAG_WS", "TAGC_WS", 
		"TRQLX_TEXT_TEXT", "TRQLX_TEXT_WS",
	];
	public static readonly VOCABULARY: Vocabulary = new VocabularyImpl(TRQLParser._LITERAL_NAMES, TRQLParser._SYMBOLIC_NAMES, []);

	// @Override
	// @NotNull
	public get vocabulary(): Vocabulary {
		return TRQLParser.VOCABULARY;
	}
	// tslint:enable:no-trailing-whitespace

	// @Override
	public get grammarFileName(): string { return "TRQLParser.g4"; }

	// @Override
	public get ruleNames(): string[] { return TRQLParser.ruleNames; }

	// @Override
	public get serializedATN(): string { return TRQLParser._serializedATN; }

	protected createFailedPredicateException(predicate?: string, message?: string): FailedPredicateException {
		return new FailedPredicateException(this, predicate, message);
	}

	constructor(input: TokenStream) {
		super(input);
		this._interp = new ParserATNSimulator(TRQLParser._ATN, this);
	}
	// @RuleVersion(0)
	public program(): ProgramContext {
		let _localctx: ProgramContext = new ProgramContext(this._ctx, this.state);
		this.enterRule(_localctx, 0, TRQLParser.RULE_program);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 183;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			while ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 32)) & ~0x1F) === 0 && ((1 << (_la - 32)) & ((1 << (TRQLParser.FN - 32)) | (1 << (TRQLParser.FOLLOWING - 32)) | (1 << (TRQLParser.FOR - 32)) | (1 << (TRQLParser.FROM - 32)) | (1 << (TRQLParser.FULL - 32)) | (1 << (TRQLParser.FUN - 32)) | (1 << (TRQLParser.GROUP - 32)) | (1 << (TRQLParser.HAVING - 32)) | (1 << (TRQLParser.HOUR - 32)) | (1 << (TRQLParser.ID - 32)) | (1 << (TRQLParser.IF - 32)) | (1 << (TRQLParser.ILIKE - 32)) | (1 << (TRQLParser.IN - 32)) | (1 << (TRQLParser.INF - 32)) | (1 << (TRQLParser.INNER - 32)) | (1 << (TRQLParser.INTERVAL - 32)) | (1 << (TRQLParser.IS - 32)) | (1 << (TRQLParser.JOIN - 32)) | (1 << (TRQLParser.KEY - 32)) | (1 << (TRQLParser.LAST - 32)) | (1 << (TRQLParser.LEADING - 32)) | (1 << (TRQLParser.LEFT - 32)) | (1 << (TRQLParser.LET - 32)) | (1 << (TRQLParser.LIKE - 32)) | (1 << (TRQLParser.LIMIT - 32)) | (1 << (TRQLParser.MINUTE - 32)) | (1 << (TRQLParser.MONTH - 32)) | (1 << (TRQLParser.NAN_SQL - 32)) | (1 << (TRQLParser.NOT - 32)) | (1 << (TRQLParser.NULL_SQL - 32)) | (1 << (TRQLParser.NULLS - 32)))) !== 0) || ((((_la - 64)) & ~0x1F) === 0 && ((1 << (_la - 64)) & ((1 << (TRQLParser.OFFSET - 64)) | (1 << (TRQLParser.ON - 64)) | (1 << (TRQLParser.OR - 64)) | (1 << (TRQLParser.ORDER - 64)) | (1 << (TRQLParser.OUTER - 64)) | (1 << (TRQLParser.OVER - 64)) | (1 << (TRQLParser.PARTITION - 64)) | (1 << (TRQLParser.PRECEDING - 64)) | (1 << (TRQLParser.PREWHERE - 64)) | (1 << (TRQLParser.QUARTER - 64)) | (1 << (TRQLParser.RANGE - 64)) | (1 << (TRQLParser.RETURN - 64)) | (1 << (TRQLParser.RIGHT - 64)) | (1 << (TRQLParser.ROLLUP - 64)) | (1 << (TRQLParser.ROW - 64)) | (1 << (TRQLParser.ROWS - 64)) | (1 << (TRQLParser.SAMPLE - 64)) | (1 << (TRQLParser.SECOND - 64)) | (1 << (TRQLParser.SELECT - 64)) | (1 << (TRQLParser.SEMI - 64)) | (1 << (TRQLParser.SETTINGS - 64)) | (1 << (TRQLParser.SUBSTRING - 64)) | (1 << (TRQLParser.THEN - 64)) | (1 << (TRQLParser.THROW - 64)) | (1 << (TRQLParser.TIES - 64)) | (1 << (TRQLParser.TIMESTAMP - 64)) | (1 << (TRQLParser.TO - 64)) | (1 << (TRQLParser.TOP - 64)) | (1 << (TRQLParser.TOTALS - 64)) | (1 << (TRQLParser.TRAILING - 64)) | (1 << (TRQLParser.TRIM - 64)) | (1 << (TRQLParser.TRUNCATE - 64)))) !== 0) || ((((_la - 96)) & ~0x1F) === 0 && ((1 << (_la - 96)) & ((1 << (TRQLParser.TRY - 96)) | (1 << (TRQLParser.UNBOUNDED - 96)) | (1 << (TRQLParser.UNION - 96)) | (1 << (TRQLParser.USING - 96)) | (1 << (TRQLParser.WEEK - 96)) | (1 << (TRQLParser.WHEN - 96)) | (1 << (TRQLParser.WHERE - 96)) | (1 << (TRQLParser.WHILE - 96)) | (1 << (TRQLParser.WINDOW - 96)) | (1 << (TRQLParser.WITH - 96)) | (1 << (TRQLParser.YEAR - 96)) | (1 << (TRQLParser.IDENTIFIER - 96)) | (1 << (TRQLParser.FLOATING_LITERAL - 96)) | (1 << (TRQLParser.OCTAL_LITERAL - 96)) | (1 << (TRQLParser.DECIMAL_LITERAL - 96)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 96)) | (1 << (TRQLParser.STRING_LITERAL - 96)) | (1 << (TRQLParser.ASTERISK - 96)) | (1 << (TRQLParser.DASH - 96)) | (1 << (TRQLParser.DOT - 96)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)) | (1 << (TRQLParser.SEMICOLON - 131)))) !== 0)) {
				{
				{
				this.state = 180;
				this.declaration();
				}
				}
				this.state = 185;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
			}
			this.state = 186;
			this.match(TRQLParser.EOF);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public declaration(): DeclarationContext {
		let _localctx: DeclarationContext = new DeclarationContext(this._ctx, this.state);
		this.enterRule(_localctx, 2, TRQLParser.RULE_declaration);
		try {
			this.state = 190;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.LET:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 188;
				this.varDecl();
				}
				break;
			case TRQLParser.ALL:
			case TRQLParser.AND:
			case TRQLParser.ANTI:
			case TRQLParser.ANY:
			case TRQLParser.ARRAY:
			case TRQLParser.AS:
			case TRQLParser.ASCENDING:
			case TRQLParser.ASOF:
			case TRQLParser.BETWEEN:
			case TRQLParser.BOTH:
			case TRQLParser.BY:
			case TRQLParser.CASE:
			case TRQLParser.CAST:
			case TRQLParser.COHORT:
			case TRQLParser.COLLATE:
			case TRQLParser.CROSS:
			case TRQLParser.CUBE:
			case TRQLParser.CURRENT:
			case TRQLParser.DATE:
			case TRQLParser.DAY:
			case TRQLParser.DESC:
			case TRQLParser.DESCENDING:
			case TRQLParser.DISTINCT:
			case TRQLParser.ELSE:
			case TRQLParser.END:
			case TRQLParser.EXTRACT:
			case TRQLParser.FINAL:
			case TRQLParser.FIRST:
			case TRQLParser.FN:
			case TRQLParser.FOLLOWING:
			case TRQLParser.FOR:
			case TRQLParser.FROM:
			case TRQLParser.FULL:
			case TRQLParser.FUN:
			case TRQLParser.GROUP:
			case TRQLParser.HAVING:
			case TRQLParser.HOUR:
			case TRQLParser.ID:
			case TRQLParser.IF:
			case TRQLParser.ILIKE:
			case TRQLParser.IN:
			case TRQLParser.INF:
			case TRQLParser.INNER:
			case TRQLParser.INTERVAL:
			case TRQLParser.IS:
			case TRQLParser.JOIN:
			case TRQLParser.KEY:
			case TRQLParser.LAST:
			case TRQLParser.LEADING:
			case TRQLParser.LEFT:
			case TRQLParser.LIKE:
			case TRQLParser.LIMIT:
			case TRQLParser.MINUTE:
			case TRQLParser.MONTH:
			case TRQLParser.NAN_SQL:
			case TRQLParser.NOT:
			case TRQLParser.NULL_SQL:
			case TRQLParser.NULLS:
			case TRQLParser.OFFSET:
			case TRQLParser.ON:
			case TRQLParser.OR:
			case TRQLParser.ORDER:
			case TRQLParser.OUTER:
			case TRQLParser.OVER:
			case TRQLParser.PARTITION:
			case TRQLParser.PRECEDING:
			case TRQLParser.PREWHERE:
			case TRQLParser.QUARTER:
			case TRQLParser.RANGE:
			case TRQLParser.RETURN:
			case TRQLParser.RIGHT:
			case TRQLParser.ROLLUP:
			case TRQLParser.ROW:
			case TRQLParser.ROWS:
			case TRQLParser.SAMPLE:
			case TRQLParser.SECOND:
			case TRQLParser.SELECT:
			case TRQLParser.SEMI:
			case TRQLParser.SETTINGS:
			case TRQLParser.SUBSTRING:
			case TRQLParser.THEN:
			case TRQLParser.THROW:
			case TRQLParser.TIES:
			case TRQLParser.TIMESTAMP:
			case TRQLParser.TO:
			case TRQLParser.TOP:
			case TRQLParser.TOTALS:
			case TRQLParser.TRAILING:
			case TRQLParser.TRIM:
			case TRQLParser.TRUNCATE:
			case TRQLParser.TRY:
			case TRQLParser.UNBOUNDED:
			case TRQLParser.UNION:
			case TRQLParser.USING:
			case TRQLParser.WEEK:
			case TRQLParser.WHEN:
			case TRQLParser.WHERE:
			case TRQLParser.WHILE:
			case TRQLParser.WINDOW:
			case TRQLParser.WITH:
			case TRQLParser.YEAR:
			case TRQLParser.IDENTIFIER:
			case TRQLParser.FLOATING_LITERAL:
			case TRQLParser.OCTAL_LITERAL:
			case TRQLParser.DECIMAL_LITERAL:
			case TRQLParser.HEXADECIMAL_LITERAL:
			case TRQLParser.STRING_LITERAL:
			case TRQLParser.ASTERISK:
			case TRQLParser.DASH:
			case TRQLParser.DOT:
			case TRQLParser.LBRACE:
			case TRQLParser.LBRACKET:
			case TRQLParser.LPAREN:
			case TRQLParser.LT:
			case TRQLParser.PLUS:
			case TRQLParser.QUOTE_SINGLE_TEMPLATE:
			case TRQLParser.SEMICOLON:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 189;
				this.statement();
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public expression(): ExpressionContext {
		let _localctx: ExpressionContext = new ExpressionContext(this._ctx, this.state);
		this.enterRule(_localctx, 4, TRQLParser.RULE_expression);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 192;
			this.columnExpr(0);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public varDecl(): VarDeclContext {
		let _localctx: VarDeclContext = new VarDeclContext(this._ctx, this.state);
		this.enterRule(_localctx, 6, TRQLParser.RULE_varDecl);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 194;
			this.match(TRQLParser.LET);
			this.state = 195;
			this.identifier();
			this.state = 199;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.COLON) {
				{
				this.state = 196;
				this.match(TRQLParser.COLON);
				this.state = 197;
				this.match(TRQLParser.EQ_SINGLE);
				this.state = 198;
				this.expression();
				}
			}

			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public identifierList(): IdentifierListContext {
		let _localctx: IdentifierListContext = new IdentifierListContext(this._ctx, this.state);
		this.enterRule(_localctx, 8, TRQLParser.RULE_identifierList);
		let _la: number;
		try {
			let _alt: number;
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 201;
			this.identifier();
			this.state = 206;
			this._errHandler.sync(this);
			_alt = this.interpreter.adaptivePredict(this._input, 3, this._ctx);
			while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
				if (_alt === 1) {
					{
					{
					this.state = 202;
					this.match(TRQLParser.COMMA);
					this.state = 203;
					this.identifier();
					}
					}
				}
				this.state = 208;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 3, this._ctx);
			}
			this.state = 210;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.COMMA) {
				{
				this.state = 209;
				this.match(TRQLParser.COMMA);
				}
			}

			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public statement(): StatementContext {
		let _localctx: StatementContext = new StatementContext(this._ctx, this.state);
		this.enterRule(_localctx, 10, TRQLParser.RULE_statement);
		try {
			this.state = 224;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 5, this._ctx) ) {
			case 1:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 212;
				this.returnStmt();
				}
				break;

			case 2:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 213;
				this.throwStmt();
				}
				break;

			case 3:
				this.enterOuterAlt(_localctx, 3);
				{
				this.state = 214;
				this.tryCatchStmt();
				}
				break;

			case 4:
				this.enterOuterAlt(_localctx, 4);
				{
				this.state = 215;
				this.ifStmt();
				}
				break;

			case 5:
				this.enterOuterAlt(_localctx, 5);
				{
				this.state = 216;
				this.whileStmt();
				}
				break;

			case 6:
				this.enterOuterAlt(_localctx, 6);
				{
				this.state = 217;
				this.forInStmt();
				}
				break;

			case 7:
				this.enterOuterAlt(_localctx, 7);
				{
				this.state = 218;
				this.forStmt();
				}
				break;

			case 8:
				this.enterOuterAlt(_localctx, 8);
				{
				this.state = 219;
				this.funcStmt();
				}
				break;

			case 9:
				this.enterOuterAlt(_localctx, 9);
				{
				this.state = 220;
				this.varAssignment();
				}
				break;

			case 10:
				this.enterOuterAlt(_localctx, 10);
				{
				this.state = 221;
				this.block();
				}
				break;

			case 11:
				this.enterOuterAlt(_localctx, 11);
				{
				this.state = 222;
				this.exprStmt();
				}
				break;

			case 12:
				this.enterOuterAlt(_localctx, 12);
				{
				this.state = 223;
				this.emptyStmt();
				}
				break;
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public returnStmt(): ReturnStmtContext {
		let _localctx: ReturnStmtContext = new ReturnStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 12, TRQLParser.RULE_returnStmt);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 226;
			this.match(TRQLParser.RETURN);
			this.state = 228;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 6, this._ctx) ) {
			case 1:
				{
				this.state = 227;
				this.expression();
				}
				break;
			}
			this.state = 231;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 7, this._ctx) ) {
			case 1:
				{
				this.state = 230;
				this.match(TRQLParser.SEMICOLON);
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public throwStmt(): ThrowStmtContext {
		let _localctx: ThrowStmtContext = new ThrowStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 14, TRQLParser.RULE_throwStmt);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 233;
			this.match(TRQLParser.THROW);
			this.state = 235;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 8, this._ctx) ) {
			case 1:
				{
				this.state = 234;
				this.expression();
				}
				break;
			}
			this.state = 238;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 9, this._ctx) ) {
			case 1:
				{
				this.state = 237;
				this.match(TRQLParser.SEMICOLON);
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public catchBlock(): CatchBlockContext {
		let _localctx: CatchBlockContext = new CatchBlockContext(this._ctx, this.state);
		this.enterRule(_localctx, 16, TRQLParser.RULE_catchBlock);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 240;
			this.match(TRQLParser.CATCH);
			this.state = 249;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.LPAREN) {
				{
				this.state = 241;
				this.match(TRQLParser.LPAREN);
				this.state = 242;
				_localctx._catchVar = this.identifier();
				this.state = 245;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.COLON) {
					{
					this.state = 243;
					this.match(TRQLParser.COLON);
					this.state = 244;
					_localctx._catchType = this.identifier();
					}
				}

				this.state = 247;
				this.match(TRQLParser.RPAREN);
				}
			}

			this.state = 251;
			_localctx._catchStmt = this.block();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public tryCatchStmt(): TryCatchStmtContext {
		let _localctx: TryCatchStmtContext = new TryCatchStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 18, TRQLParser.RULE_tryCatchStmt);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 253;
			this.match(TRQLParser.TRY);
			this.state = 254;
			_localctx._tryStmt = this.block();
			this.state = 258;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			while (_la === TRQLParser.CATCH) {
				{
				{
				this.state = 255;
				this.catchBlock();
				}
				}
				this.state = 260;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
			}
			this.state = 263;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.FINALLY) {
				{
				this.state = 261;
				this.match(TRQLParser.FINALLY);
				this.state = 262;
				_localctx._finallyStmt = this.block();
				}
			}

			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public ifStmt(): IfStmtContext {
		let _localctx: IfStmtContext = new IfStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 20, TRQLParser.RULE_ifStmt);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 265;
			this.match(TRQLParser.IF);
			this.state = 266;
			this.match(TRQLParser.LPAREN);
			this.state = 267;
			this.expression();
			this.state = 268;
			this.match(TRQLParser.RPAREN);
			this.state = 269;
			this.statement();
			this.state = 272;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 14, this._ctx) ) {
			case 1:
				{
				this.state = 270;
				this.match(TRQLParser.ELSE);
				this.state = 271;
				this.statement();
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public whileStmt(): WhileStmtContext {
		let _localctx: WhileStmtContext = new WhileStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 22, TRQLParser.RULE_whileStmt);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 274;
			this.match(TRQLParser.WHILE);
			this.state = 275;
			this.match(TRQLParser.LPAREN);
			this.state = 276;
			this.expression();
			this.state = 277;
			this.match(TRQLParser.RPAREN);
			this.state = 278;
			this.statement();
			this.state = 280;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 15, this._ctx) ) {
			case 1:
				{
				this.state = 279;
				this.match(TRQLParser.SEMICOLON);
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public forStmt(): ForStmtContext {
		let _localctx: ForStmtContext = new ForStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 24, TRQLParser.RULE_forStmt);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 282;
			this.match(TRQLParser.FOR);
			this.state = 283;
			this.match(TRQLParser.LPAREN);
			this.state = 287;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 16, this._ctx) ) {
			case 1:
				{
				this.state = 284;
				_localctx._initializerVarDeclr = this.varDecl();
				}
				break;

			case 2:
				{
				this.state = 285;
				_localctx._initializerVarAssignment = this.varAssignment();
				}
				break;

			case 3:
				{
				this.state = 286;
				_localctx._initializerExpression = this.expression();
				}
				break;
			}
			this.state = 289;
			this.match(TRQLParser.SEMICOLON);
			this.state = 291;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
				{
				this.state = 290;
				_localctx._condition = this.expression();
				}
			}

			this.state = 293;
			this.match(TRQLParser.SEMICOLON);
			this.state = 297;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 18, this._ctx) ) {
			case 1:
				{
				this.state = 294;
				_localctx._incrementVarDeclr = this.varDecl();
				}
				break;

			case 2:
				{
				this.state = 295;
				_localctx._incrementVarAssignment = this.varAssignment();
				}
				break;

			case 3:
				{
				this.state = 296;
				_localctx._incrementExpression = this.expression();
				}
				break;
			}
			this.state = 299;
			this.match(TRQLParser.RPAREN);
			this.state = 300;
			this.statement();
			this.state = 302;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 19, this._ctx) ) {
			case 1:
				{
				this.state = 301;
				this.match(TRQLParser.SEMICOLON);
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public forInStmt(): ForInStmtContext {
		let _localctx: ForInStmtContext = new ForInStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 26, TRQLParser.RULE_forInStmt);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 304;
			this.match(TRQLParser.FOR);
			this.state = 305;
			this.match(TRQLParser.LPAREN);
			this.state = 306;
			this.match(TRQLParser.LET);
			this.state = 307;
			this.identifier();
			this.state = 310;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.COMMA) {
				{
				this.state = 308;
				this.match(TRQLParser.COMMA);
				this.state = 309;
				this.identifier();
				}
			}

			this.state = 312;
			this.match(TRQLParser.IN);
			this.state = 313;
			this.expression();
			this.state = 314;
			this.match(TRQLParser.RPAREN);
			this.state = 315;
			this.statement();
			this.state = 317;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 21, this._ctx) ) {
			case 1:
				{
				this.state = 316;
				this.match(TRQLParser.SEMICOLON);
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public funcStmt(): FuncStmtContext {
		let _localctx: FuncStmtContext = new FuncStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 28, TRQLParser.RULE_funcStmt);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 319;
			_la = this._input.LA(1);
			if (!(_la === TRQLParser.FN || _la === TRQLParser.FUN)) {
			this._errHandler.recoverInline(this);
			} else {
				if (this._input.LA(1) === Token.EOF) {
					this.matchedEOF = true;
				}

				this._errHandler.reportMatch(this);
				this.consume();
			}
			this.state = 320;
			this.identifier();
			this.state = 321;
			this.match(TRQLParser.LPAREN);
			this.state = 323;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)))) !== 0)) {
				{
				this.state = 322;
				this.identifierList();
				}
			}

			this.state = 325;
			this.match(TRQLParser.RPAREN);
			this.state = 326;
			this.block();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public varAssignment(): VarAssignmentContext {
		let _localctx: VarAssignmentContext = new VarAssignmentContext(this._ctx, this.state);
		this.enterRule(_localctx, 30, TRQLParser.RULE_varAssignment);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 328;
			this.expression();
			this.state = 329;
			this.match(TRQLParser.COLON);
			this.state = 330;
			this.match(TRQLParser.EQ_SINGLE);
			this.state = 331;
			this.expression();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public exprStmt(): ExprStmtContext {
		let _localctx: ExprStmtContext = new ExprStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 32, TRQLParser.RULE_exprStmt);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 333;
			this.expression();
			this.state = 335;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 23, this._ctx) ) {
			case 1:
				{
				this.state = 334;
				this.match(TRQLParser.SEMICOLON);
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public emptyStmt(): EmptyStmtContext {
		let _localctx: EmptyStmtContext = new EmptyStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 34, TRQLParser.RULE_emptyStmt);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 337;
			this.match(TRQLParser.SEMICOLON);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public block(): BlockContext {
		let _localctx: BlockContext = new BlockContext(this._ctx, this.state);
		this.enterRule(_localctx, 36, TRQLParser.RULE_block);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 339;
			this.match(TRQLParser.LBRACE);
			this.state = 343;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			while ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 32)) & ~0x1F) === 0 && ((1 << (_la - 32)) & ((1 << (TRQLParser.FN - 32)) | (1 << (TRQLParser.FOLLOWING - 32)) | (1 << (TRQLParser.FOR - 32)) | (1 << (TRQLParser.FROM - 32)) | (1 << (TRQLParser.FULL - 32)) | (1 << (TRQLParser.FUN - 32)) | (1 << (TRQLParser.GROUP - 32)) | (1 << (TRQLParser.HAVING - 32)) | (1 << (TRQLParser.HOUR - 32)) | (1 << (TRQLParser.ID - 32)) | (1 << (TRQLParser.IF - 32)) | (1 << (TRQLParser.ILIKE - 32)) | (1 << (TRQLParser.IN - 32)) | (1 << (TRQLParser.INF - 32)) | (1 << (TRQLParser.INNER - 32)) | (1 << (TRQLParser.INTERVAL - 32)) | (1 << (TRQLParser.IS - 32)) | (1 << (TRQLParser.JOIN - 32)) | (1 << (TRQLParser.KEY - 32)) | (1 << (TRQLParser.LAST - 32)) | (1 << (TRQLParser.LEADING - 32)) | (1 << (TRQLParser.LEFT - 32)) | (1 << (TRQLParser.LET - 32)) | (1 << (TRQLParser.LIKE - 32)) | (1 << (TRQLParser.LIMIT - 32)) | (1 << (TRQLParser.MINUTE - 32)) | (1 << (TRQLParser.MONTH - 32)) | (1 << (TRQLParser.NAN_SQL - 32)) | (1 << (TRQLParser.NOT - 32)) | (1 << (TRQLParser.NULL_SQL - 32)) | (1 << (TRQLParser.NULLS - 32)))) !== 0) || ((((_la - 64)) & ~0x1F) === 0 && ((1 << (_la - 64)) & ((1 << (TRQLParser.OFFSET - 64)) | (1 << (TRQLParser.ON - 64)) | (1 << (TRQLParser.OR - 64)) | (1 << (TRQLParser.ORDER - 64)) | (1 << (TRQLParser.OUTER - 64)) | (1 << (TRQLParser.OVER - 64)) | (1 << (TRQLParser.PARTITION - 64)) | (1 << (TRQLParser.PRECEDING - 64)) | (1 << (TRQLParser.PREWHERE - 64)) | (1 << (TRQLParser.QUARTER - 64)) | (1 << (TRQLParser.RANGE - 64)) | (1 << (TRQLParser.RETURN - 64)) | (1 << (TRQLParser.RIGHT - 64)) | (1 << (TRQLParser.ROLLUP - 64)) | (1 << (TRQLParser.ROW - 64)) | (1 << (TRQLParser.ROWS - 64)) | (1 << (TRQLParser.SAMPLE - 64)) | (1 << (TRQLParser.SECOND - 64)) | (1 << (TRQLParser.SELECT - 64)) | (1 << (TRQLParser.SEMI - 64)) | (1 << (TRQLParser.SETTINGS - 64)) | (1 << (TRQLParser.SUBSTRING - 64)) | (1 << (TRQLParser.THEN - 64)) | (1 << (TRQLParser.THROW - 64)) | (1 << (TRQLParser.TIES - 64)) | (1 << (TRQLParser.TIMESTAMP - 64)) | (1 << (TRQLParser.TO - 64)) | (1 << (TRQLParser.TOP - 64)) | (1 << (TRQLParser.TOTALS - 64)) | (1 << (TRQLParser.TRAILING - 64)) | (1 << (TRQLParser.TRIM - 64)) | (1 << (TRQLParser.TRUNCATE - 64)))) !== 0) || ((((_la - 96)) & ~0x1F) === 0 && ((1 << (_la - 96)) & ((1 << (TRQLParser.TRY - 96)) | (1 << (TRQLParser.UNBOUNDED - 96)) | (1 << (TRQLParser.UNION - 96)) | (1 << (TRQLParser.USING - 96)) | (1 << (TRQLParser.WEEK - 96)) | (1 << (TRQLParser.WHEN - 96)) | (1 << (TRQLParser.WHERE - 96)) | (1 << (TRQLParser.WHILE - 96)) | (1 << (TRQLParser.WINDOW - 96)) | (1 << (TRQLParser.WITH - 96)) | (1 << (TRQLParser.YEAR - 96)) | (1 << (TRQLParser.IDENTIFIER - 96)) | (1 << (TRQLParser.FLOATING_LITERAL - 96)) | (1 << (TRQLParser.OCTAL_LITERAL - 96)) | (1 << (TRQLParser.DECIMAL_LITERAL - 96)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 96)) | (1 << (TRQLParser.STRING_LITERAL - 96)) | (1 << (TRQLParser.ASTERISK - 96)) | (1 << (TRQLParser.DASH - 96)) | (1 << (TRQLParser.DOT - 96)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)) | (1 << (TRQLParser.SEMICOLON - 131)))) !== 0)) {
				{
				{
				this.state = 340;
				this.declaration();
				}
				}
				this.state = 345;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
			}
			this.state = 346;
			this.match(TRQLParser.RBRACE);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public kvPair(): KvPairContext {
		let _localctx: KvPairContext = new KvPairContext(this._ctx, this.state);
		this.enterRule(_localctx, 38, TRQLParser.RULE_kvPair);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 348;
			this.expression();
			this.state = 349;
			this.match(TRQLParser.COLON);
			this.state = 350;
			this.expression();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public kvPairList(): KvPairListContext {
		let _localctx: KvPairListContext = new KvPairListContext(this._ctx, this.state);
		this.enterRule(_localctx, 40, TRQLParser.RULE_kvPairList);
		let _la: number;
		try {
			let _alt: number;
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 352;
			this.kvPair();
			this.state = 357;
			this._errHandler.sync(this);
			_alt = this.interpreter.adaptivePredict(this._input, 25, this._ctx);
			while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
				if (_alt === 1) {
					{
					{
					this.state = 353;
					this.match(TRQLParser.COMMA);
					this.state = 354;
					this.kvPair();
					}
					}
				}
				this.state = 359;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 25, this._ctx);
			}
			this.state = 361;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.COMMA) {
				{
				this.state = 360;
				this.match(TRQLParser.COMMA);
				}
			}

			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public select(): SelectContext {
		let _localctx: SelectContext = new SelectContext(this._ctx, this.state);
		this.enterRule(_localctx, 42, TRQLParser.RULE_select);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 366;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 27, this._ctx) ) {
			case 1:
				{
				this.state = 363;
				this.selectSetStmt();
				}
				break;

			case 2:
				{
				this.state = 364;
				this.selectStmt();
				}
				break;

			case 3:
				{
				this.state = 365;
				this.tRQLxTagElement();
				}
				break;
			}
			this.state = 369;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.SEMICOLON) {
				{
				this.state = 368;
				this.match(TRQLParser.SEMICOLON);
				}
			}

			this.state = 371;
			this.match(TRQLParser.EOF);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public selectStmtWithParens(): SelectStmtWithParensContext {
		let _localctx: SelectStmtWithParensContext = new SelectStmtWithParensContext(this._ctx, this.state);
		this.enterRule(_localctx, 44, TRQLParser.RULE_selectStmtWithParens);
		try {
			this.state = 379;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.SELECT:
			case TRQLParser.WITH:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 373;
				this.selectStmt();
				}
				break;
			case TRQLParser.LPAREN:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 374;
				this.match(TRQLParser.LPAREN);
				this.state = 375;
				this.selectSetStmt();
				this.state = 376;
				this.match(TRQLParser.RPAREN);
				}
				break;
			case TRQLParser.LBRACE:
				this.enterOuterAlt(_localctx, 3);
				{
				this.state = 378;
				this.placeholder();
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public subsequentSelectSetClause(): SubsequentSelectSetClauseContext {
		let _localctx: SubsequentSelectSetClauseContext = new SubsequentSelectSetClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 46, TRQLParser.RULE_subsequentSelectSetClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 389;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 30, this._ctx) ) {
			case 1:
				{
				this.state = 381;
				this.match(TRQLParser.EXCEPT);
				}
				break;

			case 2:
				{
				this.state = 382;
				this.match(TRQLParser.UNION);
				this.state = 383;
				this.match(TRQLParser.ALL);
				}
				break;

			case 3:
				{
				this.state = 384;
				this.match(TRQLParser.UNION);
				this.state = 385;
				this.match(TRQLParser.DISTINCT);
				}
				break;

			case 4:
				{
				this.state = 386;
				this.match(TRQLParser.INTERSECT);
				}
				break;

			case 5:
				{
				this.state = 387;
				this.match(TRQLParser.INTERSECT);
				this.state = 388;
				this.match(TRQLParser.DISTINCT);
				}
				break;
			}
			this.state = 391;
			this.selectStmtWithParens();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public selectSetStmt(): SelectSetStmtContext {
		let _localctx: SelectSetStmtContext = new SelectSetStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 48, TRQLParser.RULE_selectSetStmt);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 393;
			this.selectStmtWithParens();
			this.state = 397;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			while (_la === TRQLParser.EXCEPT || _la === TRQLParser.INTERSECT || _la === TRQLParser.UNION) {
				{
				{
				this.state = 394;
				this.subsequentSelectSetClause();
				}
				}
				this.state = 399;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public selectStmt(): SelectStmtContext {
		let _localctx: SelectStmtContext = new SelectStmtContext(this._ctx, this.state);
		this.enterRule(_localctx, 50, TRQLParser.RULE_selectStmt);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 401;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.WITH) {
				{
				this.state = 400;
				_localctx._with = this.withClause();
				}
			}

			this.state = 403;
			this.match(TRQLParser.SELECT);
			this.state = 405;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 33, this._ctx) ) {
			case 1:
				{
				this.state = 404;
				this.match(TRQLParser.DISTINCT);
				}
				break;
			}
			this.state = 408;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 34, this._ctx) ) {
			case 1:
				{
				this.state = 407;
				this.topClause();
				}
				break;
			}
			this.state = 410;
			_localctx._columns = this.columnExprList();
			this.state = 412;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.FROM) {
				{
				this.state = 411;
				_localctx._from = this.fromClause();
				}
			}

			this.state = 415;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.ARRAY || _la === TRQLParser.INNER || _la === TRQLParser.LEFT) {
				{
				this.state = 414;
				this.arrayJoinClause();
				}
			}

			this.state = 418;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.PREWHERE) {
				{
				this.state = 417;
				this.prewhereClause();
				}
			}

			this.state = 421;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.WHERE) {
				{
				this.state = 420;
				_localctx._where = this.whereClause();
				}
			}

			this.state = 424;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.GROUP) {
				{
				this.state = 423;
				this.groupByClause();
				}
			}

			this.state = 428;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 40, this._ctx) ) {
			case 1:
				{
				this.state = 426;
				this.match(TRQLParser.WITH);
				this.state = 427;
				_la = this._input.LA(1);
				if (!(_la === TRQLParser.CUBE || _la === TRQLParser.ROLLUP)) {
				this._errHandler.recoverInline(this);
				} else {
					if (this._input.LA(1) === Token.EOF) {
						this.matchedEOF = true;
					}

					this._errHandler.reportMatch(this);
					this.consume();
				}
				}
				break;
			}
			this.state = 432;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.WITH) {
				{
				this.state = 430;
				this.match(TRQLParser.WITH);
				this.state = 431;
				this.match(TRQLParser.TOTALS);
				}
			}

			this.state = 435;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.HAVING) {
				{
				this.state = 434;
				this.havingClause();
				}
			}

			this.state = 438;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.WINDOW) {
				{
				this.state = 437;
				this.windowClause();
				}
			}

			this.state = 441;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.ORDER) {
				{
				this.state = 440;
				this.orderByClause();
				}
			}

			this.state = 444;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 45, this._ctx) ) {
			case 1:
				{
				this.state = 443;
				this.limitByClause();
				}
				break;
			}
			this.state = 448;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.LIMIT:
				{
				this.state = 446;
				this.limitAndOffsetClause();
				}
				break;
			case TRQLParser.OFFSET:
				{
				this.state = 447;
				this.offsetOnlyClause();
				}
				break;
			case TRQLParser.EOF:
			case TRQLParser.EXCEPT:
			case TRQLParser.INTERSECT:
			case TRQLParser.SETTINGS:
			case TRQLParser.UNION:
			case TRQLParser.RPAREN:
			case TRQLParser.SEMICOLON:
				break;
			default:
				break;
			}
			this.state = 451;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.SETTINGS) {
				{
				this.state = 450;
				this.settingsClause();
				}
			}

			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public withClause(): WithClauseContext {
		let _localctx: WithClauseContext = new WithClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 52, TRQLParser.RULE_withClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 453;
			this.match(TRQLParser.WITH);
			this.state = 454;
			this.withExprList();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public topClause(): TopClauseContext {
		let _localctx: TopClauseContext = new TopClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 54, TRQLParser.RULE_topClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 456;
			this.match(TRQLParser.TOP);
			this.state = 457;
			this.match(TRQLParser.DECIMAL_LITERAL);
			this.state = 460;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 48, this._ctx) ) {
			case 1:
				{
				this.state = 458;
				this.match(TRQLParser.WITH);
				this.state = 459;
				this.match(TRQLParser.TIES);
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public fromClause(): FromClauseContext {
		let _localctx: FromClauseContext = new FromClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 56, TRQLParser.RULE_fromClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 462;
			this.match(TRQLParser.FROM);
			this.state = 463;
			this.joinExpr(0);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public arrayJoinClause(): ArrayJoinClauseContext {
		let _localctx: ArrayJoinClauseContext = new ArrayJoinClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 58, TRQLParser.RULE_arrayJoinClause);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 466;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.INNER || _la === TRQLParser.LEFT) {
				{
				this.state = 465;
				_la = this._input.LA(1);
				if (!(_la === TRQLParser.INNER || _la === TRQLParser.LEFT)) {
				this._errHandler.recoverInline(this);
				} else {
					if (this._input.LA(1) === Token.EOF) {
						this.matchedEOF = true;
					}

					this._errHandler.reportMatch(this);
					this.consume();
				}
				}
			}

			this.state = 468;
			this.match(TRQLParser.ARRAY);
			this.state = 469;
			this.match(TRQLParser.JOIN);
			this.state = 470;
			this.columnExprList();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public windowClause(): WindowClauseContext {
		let _localctx: WindowClauseContext = new WindowClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 60, TRQLParser.RULE_windowClause);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 472;
			this.match(TRQLParser.WINDOW);
			this.state = 473;
			this.identifier();
			this.state = 474;
			this.match(TRQLParser.AS);
			this.state = 475;
			this.match(TRQLParser.LPAREN);
			this.state = 476;
			this.windowExpr();
			this.state = 477;
			this.match(TRQLParser.RPAREN);
			this.state = 487;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			while (_la === TRQLParser.COMMA) {
				{
				{
				this.state = 478;
				this.match(TRQLParser.COMMA);
				this.state = 479;
				this.identifier();
				this.state = 480;
				this.match(TRQLParser.AS);
				this.state = 481;
				this.match(TRQLParser.LPAREN);
				this.state = 482;
				this.windowExpr();
				this.state = 483;
				this.match(TRQLParser.RPAREN);
				}
				}
				this.state = 489;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public prewhereClause(): PrewhereClauseContext {
		let _localctx: PrewhereClauseContext = new PrewhereClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 62, TRQLParser.RULE_prewhereClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 490;
			this.match(TRQLParser.PREWHERE);
			this.state = 491;
			this.columnExpr(0);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public whereClause(): WhereClauseContext {
		let _localctx: WhereClauseContext = new WhereClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 64, TRQLParser.RULE_whereClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 493;
			this.match(TRQLParser.WHERE);
			this.state = 494;
			this.columnExpr(0);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public groupByClause(): GroupByClauseContext {
		let _localctx: GroupByClauseContext = new GroupByClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 66, TRQLParser.RULE_groupByClause);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 496;
			this.match(TRQLParser.GROUP);
			this.state = 497;
			this.match(TRQLParser.BY);
			this.state = 504;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 51, this._ctx) ) {
			case 1:
				{
				this.state = 498;
				_la = this._input.LA(1);
				if (!(_la === TRQLParser.CUBE || _la === TRQLParser.ROLLUP)) {
				this._errHandler.recoverInline(this);
				} else {
					if (this._input.LA(1) === Token.EOF) {
						this.matchedEOF = true;
					}

					this._errHandler.reportMatch(this);
					this.consume();
				}
				this.state = 499;
				this.match(TRQLParser.LPAREN);
				this.state = 500;
				this.columnExprList();
				this.state = 501;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 2:
				{
				this.state = 503;
				this.columnExprList();
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public havingClause(): HavingClauseContext {
		let _localctx: HavingClauseContext = new HavingClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 68, TRQLParser.RULE_havingClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 506;
			this.match(TRQLParser.HAVING);
			this.state = 507;
			this.columnExpr(0);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public orderByClause(): OrderByClauseContext {
		let _localctx: OrderByClauseContext = new OrderByClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 70, TRQLParser.RULE_orderByClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 509;
			this.match(TRQLParser.ORDER);
			this.state = 510;
			this.match(TRQLParser.BY);
			this.state = 511;
			this.orderExprList();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public projectionOrderByClause(): ProjectionOrderByClauseContext {
		let _localctx: ProjectionOrderByClauseContext = new ProjectionOrderByClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 72, TRQLParser.RULE_projectionOrderByClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 513;
			this.match(TRQLParser.ORDER);
			this.state = 514;
			this.match(TRQLParser.BY);
			this.state = 515;
			this.columnExprList();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public limitByClause(): LimitByClauseContext {
		let _localctx: LimitByClauseContext = new LimitByClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 74, TRQLParser.RULE_limitByClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 517;
			this.match(TRQLParser.LIMIT);
			this.state = 518;
			this.limitExpr();
			this.state = 519;
			this.match(TRQLParser.BY);
			this.state = 520;
			this.columnExprList();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public limitAndOffsetClause(): LimitAndOffsetClauseContext {
		let _localctx: LimitAndOffsetClauseContext = new LimitAndOffsetClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 76, TRQLParser.RULE_limitAndOffsetClause);
		let _la: number;
		try {
			this.state = 541;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 55, this._ctx) ) {
			case 1:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 522;
				this.match(TRQLParser.LIMIT);
				this.state = 523;
				this.columnExpr(0);
				this.state = 526;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.COMMA) {
					{
					this.state = 524;
					this.match(TRQLParser.COMMA);
					this.state = 525;
					this.columnExpr(0);
					}
				}

				this.state = 530;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.WITH) {
					{
					this.state = 528;
					this.match(TRQLParser.WITH);
					this.state = 529;
					this.match(TRQLParser.TIES);
					}
				}

				}
				break;

			case 2:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 532;
				this.match(TRQLParser.LIMIT);
				this.state = 533;
				this.columnExpr(0);
				this.state = 536;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.WITH) {
					{
					this.state = 534;
					this.match(TRQLParser.WITH);
					this.state = 535;
					this.match(TRQLParser.TIES);
					}
				}

				this.state = 538;
				this.match(TRQLParser.OFFSET);
				this.state = 539;
				this.columnExpr(0);
				}
				break;
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public offsetOnlyClause(): OffsetOnlyClauseContext {
		let _localctx: OffsetOnlyClauseContext = new OffsetOnlyClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 78, TRQLParser.RULE_offsetOnlyClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 543;
			this.match(TRQLParser.OFFSET);
			this.state = 544;
			this.columnExpr(0);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public settingsClause(): SettingsClauseContext {
		let _localctx: SettingsClauseContext = new SettingsClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 80, TRQLParser.RULE_settingsClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 546;
			this.match(TRQLParser.SETTINGS);
			this.state = 547;
			this.settingExprList();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}

	public joinExpr(): JoinExprContext;
	public joinExpr(_p: number): JoinExprContext;
	// @RuleVersion(0)
	public joinExpr(_p?: number): JoinExprContext {
		if (_p === undefined) {
			_p = 0;
		}

		let _parentctx: ParserRuleContext = this._ctx;
		let _parentState: number = this.state;
		let _localctx: JoinExprContext = new JoinExprContext(this._ctx, _parentState);
		let _prevctx: JoinExprContext = _localctx;
		let _startState: number = 82;
		this.enterRecursionRule(_localctx, 82, TRQLParser.RULE_joinExpr, _p);
		let _la: number;
		try {
			let _alt: number;
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 561;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 58, this._ctx) ) {
			case 1:
				{
				_localctx = new JoinExprTableContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;

				this.state = 550;
				this.tableExpr(0);
				this.state = 552;
				this._errHandler.sync(this);
				switch ( this.interpreter.adaptivePredict(this._input, 56, this._ctx) ) {
				case 1:
					{
					this.state = 551;
					this.match(TRQLParser.FINAL);
					}
					break;
				}
				this.state = 555;
				this._errHandler.sync(this);
				switch ( this.interpreter.adaptivePredict(this._input, 57, this._ctx) ) {
				case 1:
					{
					this.state = 554;
					this.sampleClause();
					}
					break;
				}
				}
				break;

			case 2:
				{
				_localctx = new JoinExprParensContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 557;
				this.match(TRQLParser.LPAREN);
				this.state = 558;
				this.joinExpr(0);
				this.state = 559;
				this.match(TRQLParser.RPAREN);
				}
				break;
			}
			this._ctx._stop = this._input.tryLT(-1);
			this.state = 577;
			this._errHandler.sync(this);
			_alt = this.interpreter.adaptivePredict(this._input, 61, this._ctx);
			while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
				if (_alt === 1) {
					if (this._parseListeners != null) {
						this.triggerExitRuleEvent();
					}
					_prevctx = _localctx;
					{
					this.state = 575;
					this._errHandler.sync(this);
					switch ( this.interpreter.adaptivePredict(this._input, 60, this._ctx) ) {
					case 1:
						{
						_localctx = new JoinExprCrossOpContext(new JoinExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_joinExpr);
						this.state = 563;
						if (!(this.precpred(this._ctx, 3))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 3)");
						}
						this.state = 564;
						this.joinOpCross();
						this.state = 565;
						this.joinExpr(4);
						}
						break;

					case 2:
						{
						_localctx = new JoinExprOpContext(new JoinExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_joinExpr);
						this.state = 567;
						if (!(this.precpred(this._ctx, 4))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 4)");
						}
						this.state = 569;
						this._errHandler.sync(this);
						_la = this._input.LA(1);
						if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ASOF))) !== 0) || ((((_la - 36)) & ~0x1F) === 0 && ((1 << (_la - 36)) & ((1 << (TRQLParser.FULL - 36)) | (1 << (TRQLParser.INNER - 36)) | (1 << (TRQLParser.LEFT - 36)))) !== 0) || _la === TRQLParser.RIGHT || _la === TRQLParser.SEMI) {
							{
							this.state = 568;
							this.joinOp();
							}
						}

						this.state = 571;
						this.match(TRQLParser.JOIN);
						this.state = 572;
						this.joinExpr(0);
						this.state = 573;
						this.joinConstraintClause();
						}
						break;
					}
					}
				}
				this.state = 579;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 61, this._ctx);
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.unrollRecursionContexts(_parentctx);
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public joinOp(): JoinOpContext {
		let _localctx: JoinOpContext = new JoinOpContext(this._ctx, this.state);
		this.enterRule(_localctx, 84, TRQLParser.RULE_joinOp);
		let _la: number;
		try {
			this.state = 623;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 75, this._ctx) ) {
			case 1:
				_localctx = new JoinOpInnerContext(_localctx);
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 589;
				this._errHandler.sync(this);
				switch ( this.interpreter.adaptivePredict(this._input, 64, this._ctx) ) {
				case 1:
					{
					this.state = 581;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ASOF))) !== 0)) {
						{
						this.state = 580;
						_la = this._input.LA(1);
						if (!((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ASOF))) !== 0))) {
						this._errHandler.recoverInline(this);
						} else {
							if (this._input.LA(1) === Token.EOF) {
								this.matchedEOF = true;
							}

							this._errHandler.reportMatch(this);
							this.consume();
						}
						}
					}

					this.state = 583;
					this.match(TRQLParser.INNER);
					}
					break;

				case 2:
					{
					this.state = 584;
					this.match(TRQLParser.INNER);
					this.state = 586;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ASOF))) !== 0)) {
						{
						this.state = 585;
						_la = this._input.LA(1);
						if (!((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ASOF))) !== 0))) {
						this._errHandler.recoverInline(this);
						} else {
							if (this._input.LA(1) === Token.EOF) {
								this.matchedEOF = true;
							}

							this._errHandler.reportMatch(this);
							this.consume();
						}
						}
					}

					}
					break;

				case 3:
					{
					this.state = 588;
					_la = this._input.LA(1);
					if (!((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ASOF))) !== 0))) {
					this._errHandler.recoverInline(this);
					} else {
						if (this._input.LA(1) === Token.EOF) {
							this.matchedEOF = true;
						}

						this._errHandler.reportMatch(this);
						this.consume();
					}
					}
					break;
				}
				}
				break;

			case 2:
				_localctx = new JoinOpLeftRightContext(_localctx);
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 605;
				this._errHandler.sync(this);
				switch ( this.interpreter.adaptivePredict(this._input, 69, this._ctx) ) {
				case 1:
					{
					this.state = 592;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ASOF))) !== 0) || _la === TRQLParser.SEMI) {
						{
						this.state = 591;
						_la = this._input.LA(1);
						if (!((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ASOF))) !== 0) || _la === TRQLParser.SEMI)) {
						this._errHandler.recoverInline(this);
						} else {
							if (this._input.LA(1) === Token.EOF) {
								this.matchedEOF = true;
							}

							this._errHandler.reportMatch(this);
							this.consume();
						}
						}
					}

					this.state = 594;
					_la = this._input.LA(1);
					if (!(_la === TRQLParser.LEFT || _la === TRQLParser.RIGHT)) {
					this._errHandler.recoverInline(this);
					} else {
						if (this._input.LA(1) === Token.EOF) {
							this.matchedEOF = true;
						}

						this._errHandler.reportMatch(this);
						this.consume();
					}
					this.state = 596;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if (_la === TRQLParser.OUTER) {
						{
						this.state = 595;
						this.match(TRQLParser.OUTER);
						}
					}

					}
					break;

				case 2:
					{
					this.state = 598;
					_la = this._input.LA(1);
					if (!(_la === TRQLParser.LEFT || _la === TRQLParser.RIGHT)) {
					this._errHandler.recoverInline(this);
					} else {
						if (this._input.LA(1) === Token.EOF) {
							this.matchedEOF = true;
						}

						this._errHandler.reportMatch(this);
						this.consume();
					}
					this.state = 600;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if (_la === TRQLParser.OUTER) {
						{
						this.state = 599;
						this.match(TRQLParser.OUTER);
						}
					}

					this.state = 603;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ASOF))) !== 0) || _la === TRQLParser.SEMI) {
						{
						this.state = 602;
						_la = this._input.LA(1);
						if (!((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ASOF))) !== 0) || _la === TRQLParser.SEMI)) {
						this._errHandler.recoverInline(this);
						} else {
							if (this._input.LA(1) === Token.EOF) {
								this.matchedEOF = true;
							}

							this._errHandler.reportMatch(this);
							this.consume();
						}
						}
					}

					}
					break;
				}
				}
				break;

			case 3:
				_localctx = new JoinOpFullContext(_localctx);
				this.enterOuterAlt(_localctx, 3);
				{
				this.state = 621;
				this._errHandler.sync(this);
				switch ( this.interpreter.adaptivePredict(this._input, 74, this._ctx) ) {
				case 1:
					{
					this.state = 608;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if (_la === TRQLParser.ALL || _la === TRQLParser.ANY) {
						{
						this.state = 607;
						_la = this._input.LA(1);
						if (!(_la === TRQLParser.ALL || _la === TRQLParser.ANY)) {
						this._errHandler.recoverInline(this);
						} else {
							if (this._input.LA(1) === Token.EOF) {
								this.matchedEOF = true;
							}

							this._errHandler.reportMatch(this);
							this.consume();
						}
						}
					}

					this.state = 610;
					this.match(TRQLParser.FULL);
					this.state = 612;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if (_la === TRQLParser.OUTER) {
						{
						this.state = 611;
						this.match(TRQLParser.OUTER);
						}
					}

					}
					break;

				case 2:
					{
					this.state = 614;
					this.match(TRQLParser.FULL);
					this.state = 616;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if (_la === TRQLParser.OUTER) {
						{
						this.state = 615;
						this.match(TRQLParser.OUTER);
						}
					}

					this.state = 619;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if (_la === TRQLParser.ALL || _la === TRQLParser.ANY) {
						{
						this.state = 618;
						_la = this._input.LA(1);
						if (!(_la === TRQLParser.ALL || _la === TRQLParser.ANY)) {
						this._errHandler.recoverInline(this);
						} else {
							if (this._input.LA(1) === Token.EOF) {
								this.matchedEOF = true;
							}

							this._errHandler.reportMatch(this);
							this.consume();
						}
						}
					}

					}
					break;
				}
				}
				break;
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public joinOpCross(): JoinOpCrossContext {
		let _localctx: JoinOpCrossContext = new JoinOpCrossContext(this._ctx, this.state);
		this.enterRule(_localctx, 86, TRQLParser.RULE_joinOpCross);
		try {
			this.state = 628;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.CROSS:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 625;
				this.match(TRQLParser.CROSS);
				this.state = 626;
				this.match(TRQLParser.JOIN);
				}
				break;
			case TRQLParser.COMMA:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 627;
				this.match(TRQLParser.COMMA);
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public joinConstraintClause(): JoinConstraintClauseContext {
		let _localctx: JoinConstraintClauseContext = new JoinConstraintClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 88, TRQLParser.RULE_joinConstraintClause);
		try {
			this.state = 639;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 77, this._ctx) ) {
			case 1:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 630;
				this.match(TRQLParser.ON);
				this.state = 631;
				this.columnExprList();
				}
				break;

			case 2:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 632;
				this.match(TRQLParser.USING);
				this.state = 633;
				this.match(TRQLParser.LPAREN);
				this.state = 634;
				this.columnExprList();
				this.state = 635;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 3:
				this.enterOuterAlt(_localctx, 3);
				{
				this.state = 637;
				this.match(TRQLParser.USING);
				this.state = 638;
				this.columnExprList();
				}
				break;
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public sampleClause(): SampleClauseContext {
		let _localctx: SampleClauseContext = new SampleClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 90, TRQLParser.RULE_sampleClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 641;
			this.match(TRQLParser.SAMPLE);
			this.state = 642;
			this.ratioExpr();
			this.state = 645;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 78, this._ctx) ) {
			case 1:
				{
				this.state = 643;
				this.match(TRQLParser.OFFSET);
				this.state = 644;
				this.ratioExpr();
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public limitExpr(): LimitExprContext {
		let _localctx: LimitExprContext = new LimitExprContext(this._ctx, this.state);
		this.enterRule(_localctx, 92, TRQLParser.RULE_limitExpr);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 647;
			this.columnExpr(0);
			this.state = 650;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.OFFSET || _la === TRQLParser.COMMA) {
				{
				this.state = 648;
				_la = this._input.LA(1);
				if (!(_la === TRQLParser.OFFSET || _la === TRQLParser.COMMA)) {
				this._errHandler.recoverInline(this);
				} else {
					if (this._input.LA(1) === Token.EOF) {
						this.matchedEOF = true;
					}

					this._errHandler.reportMatch(this);
					this.consume();
				}
				this.state = 649;
				this.columnExpr(0);
				}
			}

			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public orderExprList(): OrderExprListContext {
		let _localctx: OrderExprListContext = new OrderExprListContext(this._ctx, this.state);
		this.enterRule(_localctx, 94, TRQLParser.RULE_orderExprList);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 652;
			this.orderExpr();
			this.state = 657;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			while (_la === TRQLParser.COMMA) {
				{
				{
				this.state = 653;
				this.match(TRQLParser.COMMA);
				this.state = 654;
				this.orderExpr();
				}
				}
				this.state = 659;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public orderExpr(): OrderExprContext {
		let _localctx: OrderExprContext = new OrderExprContext(this._ctx, this.state);
		this.enterRule(_localctx, 96, TRQLParser.RULE_orderExpr);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 660;
			this.columnExpr(0);
			this.state = 662;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ASCENDING) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING))) !== 0)) {
				{
				this.state = 661;
				_la = this._input.LA(1);
				if (!((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ASCENDING) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING))) !== 0))) {
				this._errHandler.recoverInline(this);
				} else {
					if (this._input.LA(1) === Token.EOF) {
						this.matchedEOF = true;
					}

					this._errHandler.reportMatch(this);
					this.consume();
				}
				}
			}

			this.state = 666;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.NULLS) {
				{
				this.state = 664;
				this.match(TRQLParser.NULLS);
				this.state = 665;
				_la = this._input.LA(1);
				if (!(_la === TRQLParser.FIRST || _la === TRQLParser.LAST)) {
				this._errHandler.recoverInline(this);
				} else {
					if (this._input.LA(1) === Token.EOF) {
						this.matchedEOF = true;
					}

					this._errHandler.reportMatch(this);
					this.consume();
				}
				}
			}

			this.state = 670;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.COLLATE) {
				{
				this.state = 668;
				this.match(TRQLParser.COLLATE);
				this.state = 669;
				this.match(TRQLParser.STRING_LITERAL);
				}
			}

			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public ratioExpr(): RatioExprContext {
		let _localctx: RatioExprContext = new RatioExprContext(this._ctx, this.state);
		this.enterRule(_localctx, 98, TRQLParser.RULE_ratioExpr);
		try {
			this.state = 678;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.LBRACE:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 672;
				this.placeholder();
				}
				break;
			case TRQLParser.INF:
			case TRQLParser.NAN_SQL:
			case TRQLParser.FLOATING_LITERAL:
			case TRQLParser.OCTAL_LITERAL:
			case TRQLParser.DECIMAL_LITERAL:
			case TRQLParser.HEXADECIMAL_LITERAL:
			case TRQLParser.DASH:
			case TRQLParser.DOT:
			case TRQLParser.PLUS:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 673;
				this.numberLiteral();
				this.state = 676;
				this._errHandler.sync(this);
				switch ( this.interpreter.adaptivePredict(this._input, 84, this._ctx) ) {
				case 1:
					{
					this.state = 674;
					this.match(TRQLParser.SLASH);
					this.state = 675;
					this.numberLiteral();
					}
					break;
				}
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public settingExprList(): SettingExprListContext {
		let _localctx: SettingExprListContext = new SettingExprListContext(this._ctx, this.state);
		this.enterRule(_localctx, 100, TRQLParser.RULE_settingExprList);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 680;
			this.settingExpr();
			this.state = 685;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			while (_la === TRQLParser.COMMA) {
				{
				{
				this.state = 681;
				this.match(TRQLParser.COMMA);
				this.state = 682;
				this.settingExpr();
				}
				}
				this.state = 687;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public settingExpr(): SettingExprContext {
		let _localctx: SettingExprContext = new SettingExprContext(this._ctx, this.state);
		this.enterRule(_localctx, 102, TRQLParser.RULE_settingExpr);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 688;
			this.identifier();
			this.state = 689;
			this.match(TRQLParser.EQ_SINGLE);
			this.state = 690;
			this.literal();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public windowExpr(): WindowExprContext {
		let _localctx: WindowExprContext = new WindowExprContext(this._ctx, this.state);
		this.enterRule(_localctx, 104, TRQLParser.RULE_windowExpr);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 693;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.PARTITION) {
				{
				this.state = 692;
				this.winPartitionByClause();
				}
			}

			this.state = 696;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.ORDER) {
				{
				this.state = 695;
				this.winOrderByClause();
				}
			}

			this.state = 699;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.RANGE || _la === TRQLParser.ROWS) {
				{
				this.state = 698;
				this.winFrameClause();
				}
			}

			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public winPartitionByClause(): WinPartitionByClauseContext {
		let _localctx: WinPartitionByClauseContext = new WinPartitionByClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 106, TRQLParser.RULE_winPartitionByClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 701;
			this.match(TRQLParser.PARTITION);
			this.state = 702;
			this.match(TRQLParser.BY);
			this.state = 703;
			this.columnExprList();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public winOrderByClause(): WinOrderByClauseContext {
		let _localctx: WinOrderByClauseContext = new WinOrderByClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 108, TRQLParser.RULE_winOrderByClause);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 705;
			this.match(TRQLParser.ORDER);
			this.state = 706;
			this.match(TRQLParser.BY);
			this.state = 707;
			this.orderExprList();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public winFrameClause(): WinFrameClauseContext {
		let _localctx: WinFrameClauseContext = new WinFrameClauseContext(this._ctx, this.state);
		this.enterRule(_localctx, 110, TRQLParser.RULE_winFrameClause);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 709;
			_la = this._input.LA(1);
			if (!(_la === TRQLParser.RANGE || _la === TRQLParser.ROWS)) {
			this._errHandler.recoverInline(this);
			} else {
				if (this._input.LA(1) === Token.EOF) {
					this.matchedEOF = true;
				}

				this._errHandler.reportMatch(this);
				this.consume();
			}
			this.state = 710;
			this.winFrameExtend();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public winFrameExtend(): WinFrameExtendContext {
		let _localctx: WinFrameExtendContext = new WinFrameExtendContext(this._ctx, this.state);
		this.enterRule(_localctx, 112, TRQLParser.RULE_winFrameExtend);
		try {
			this.state = 718;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.CURRENT:
			case TRQLParser.INF:
			case TRQLParser.NAN_SQL:
			case TRQLParser.UNBOUNDED:
			case TRQLParser.FLOATING_LITERAL:
			case TRQLParser.OCTAL_LITERAL:
			case TRQLParser.DECIMAL_LITERAL:
			case TRQLParser.HEXADECIMAL_LITERAL:
			case TRQLParser.DASH:
			case TRQLParser.DOT:
			case TRQLParser.PLUS:
				_localctx = new FrameStartContext(_localctx);
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 712;
				this.winFrameBound();
				}
				break;
			case TRQLParser.BETWEEN:
				_localctx = new FrameBetweenContext(_localctx);
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 713;
				this.match(TRQLParser.BETWEEN);
				this.state = 714;
				this.winFrameBound();
				this.state = 715;
				this.match(TRQLParser.AND);
				this.state = 716;
				this.winFrameBound();
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public winFrameBound(): WinFrameBoundContext {
		let _localctx: WinFrameBoundContext = new WinFrameBoundContext(this._ctx, this.state);
		this.enterRule(_localctx, 114, TRQLParser.RULE_winFrameBound);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 732;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 91, this._ctx) ) {
			case 1:
				{
				this.state = 720;
				this.match(TRQLParser.CURRENT);
				this.state = 721;
				this.match(TRQLParser.ROW);
				}
				break;

			case 2:
				{
				this.state = 722;
				this.match(TRQLParser.UNBOUNDED);
				this.state = 723;
				this.match(TRQLParser.PRECEDING);
				}
				break;

			case 3:
				{
				this.state = 724;
				this.match(TRQLParser.UNBOUNDED);
				this.state = 725;
				this.match(TRQLParser.FOLLOWING);
				}
				break;

			case 4:
				{
				this.state = 726;
				this.numberLiteral();
				this.state = 727;
				this.match(TRQLParser.PRECEDING);
				}
				break;

			case 5:
				{
				this.state = 729;
				this.numberLiteral();
				this.state = 730;
				this.match(TRQLParser.FOLLOWING);
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public expr(): ExprContext {
		let _localctx: ExprContext = new ExprContext(this._ctx, this.state);
		this.enterRule(_localctx, 116, TRQLParser.RULE_expr);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 734;
			this.columnExpr(0);
			this.state = 735;
			this.match(TRQLParser.EOF);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public columnTypeExpr(): ColumnTypeExprContext {
		let _localctx: ColumnTypeExprContext = new ColumnTypeExprContext(this._ctx, this.state);
		this.enterRule(_localctx, 118, TRQLParser.RULE_columnTypeExpr);
		let _la: number;
		try {
			let _alt: number;
			this.state = 793;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 99, this._ctx) ) {
			case 1:
				_localctx = new ColumnTypeExprSimpleContext(_localctx);
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 737;
				this.identifier();
				}
				break;

			case 2:
				_localctx = new ColumnTypeExprNestedContext(_localctx);
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 738;
				this.identifier();
				this.state = 739;
				this.match(TRQLParser.LPAREN);
				this.state = 740;
				this.identifier();
				this.state = 741;
				this.columnTypeExpr();
				this.state = 748;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 92, this._ctx);
				while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
					if (_alt === 1) {
						{
						{
						this.state = 742;
						this.match(TRQLParser.COMMA);
						this.state = 743;
						this.identifier();
						this.state = 744;
						this.columnTypeExpr();
						}
						}
					}
					this.state = 750;
					this._errHandler.sync(this);
					_alt = this.interpreter.adaptivePredict(this._input, 92, this._ctx);
				}
				this.state = 752;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.COMMA) {
					{
					this.state = 751;
					this.match(TRQLParser.COMMA);
					}
				}

				this.state = 754;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 3:
				_localctx = new ColumnTypeExprEnumContext(_localctx);
				this.enterOuterAlt(_localctx, 3);
				{
				this.state = 756;
				this.identifier();
				this.state = 757;
				this.match(TRQLParser.LPAREN);
				this.state = 758;
				this.enumValue();
				this.state = 763;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 94, this._ctx);
				while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
					if (_alt === 1) {
						{
						{
						this.state = 759;
						this.match(TRQLParser.COMMA);
						this.state = 760;
						this.enumValue();
						}
						}
					}
					this.state = 765;
					this._errHandler.sync(this);
					_alt = this.interpreter.adaptivePredict(this._input, 94, this._ctx);
				}
				this.state = 767;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.COMMA) {
					{
					this.state = 766;
					this.match(TRQLParser.COMMA);
					}
				}

				this.state = 769;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 4:
				_localctx = new ColumnTypeExprComplexContext(_localctx);
				this.enterOuterAlt(_localctx, 4);
				{
				this.state = 771;
				this.identifier();
				this.state = 772;
				this.match(TRQLParser.LPAREN);
				this.state = 773;
				this.columnTypeExpr();
				this.state = 778;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 96, this._ctx);
				while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
					if (_alt === 1) {
						{
						{
						this.state = 774;
						this.match(TRQLParser.COMMA);
						this.state = 775;
						this.columnTypeExpr();
						}
						}
					}
					this.state = 780;
					this._errHandler.sync(this);
					_alt = this.interpreter.adaptivePredict(this._input, 96, this._ctx);
				}
				this.state = 782;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.COMMA) {
					{
					this.state = 781;
					this.match(TRQLParser.COMMA);
					}
				}

				this.state = 784;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 5:
				_localctx = new ColumnTypeExprParamContext(_localctx);
				this.enterOuterAlt(_localctx, 5);
				{
				this.state = 786;
				this.identifier();
				this.state = 787;
				this.match(TRQLParser.LPAREN);
				this.state = 789;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
					{
					this.state = 788;
					this.columnExprList();
					}
				}

				this.state = 791;
				this.match(TRQLParser.RPAREN);
				}
				break;
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public columnExprList(): ColumnExprListContext {
		let _localctx: ColumnExprListContext = new ColumnExprListContext(this._ctx, this.state);
		this.enterRule(_localctx, 120, TRQLParser.RULE_columnExprList);
		try {
			let _alt: number;
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 795;
			this.columnExpr(0);
			this.state = 800;
			this._errHandler.sync(this);
			_alt = this.interpreter.adaptivePredict(this._input, 100, this._ctx);
			while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
				if (_alt === 1) {
					{
					{
					this.state = 796;
					this.match(TRQLParser.COMMA);
					this.state = 797;
					this.columnExpr(0);
					}
					}
				}
				this.state = 802;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 100, this._ctx);
			}
			this.state = 804;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 101, this._ctx) ) {
			case 1:
				{
				this.state = 803;
				this.match(TRQLParser.COMMA);
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}

	public columnExpr(): ColumnExprContext;
	public columnExpr(_p: number): ColumnExprContext;
	// @RuleVersion(0)
	public columnExpr(_p?: number): ColumnExprContext {
		if (_p === undefined) {
			_p = 0;
		}

		let _parentctx: ParserRuleContext = this._ctx;
		let _parentState: number = this.state;
		let _localctx: ColumnExprContext = new ColumnExprContext(this._ctx, _parentState);
		let _prevctx: ColumnExprContext = _localctx;
		let _startState: number = 122;
		this.enterRecursionRule(_localctx, 122, TRQLParser.RULE_columnExpr, _p);
		let _la: number;
		try {
			let _alt: number;
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 958;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 121, this._ctx) ) {
			case 1:
				{
				_localctx = new ColumnExprCaseContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;

				this.state = 807;
				this.match(TRQLParser.CASE);
				this.state = 809;
				this._errHandler.sync(this);
				switch ( this.interpreter.adaptivePredict(this._input, 102, this._ctx) ) {
				case 1:
					{
					this.state = 808;
					(_localctx as ColumnExprCaseContext)._caseExpr = this.columnExpr(0);
					}
					break;
				}
				this.state = 816;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				do {
					{
					{
					this.state = 811;
					this.match(TRQLParser.WHEN);
					this.state = 812;
					(_localctx as ColumnExprCaseContext)._whenExpr = this.columnExpr(0);
					this.state = 813;
					this.match(TRQLParser.THEN);
					this.state = 814;
					(_localctx as ColumnExprCaseContext)._thenExpr = this.columnExpr(0);
					}
					}
					this.state = 818;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
				} while (_la === TRQLParser.WHEN);
				this.state = 822;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.ELSE) {
					{
					this.state = 820;
					this.match(TRQLParser.ELSE);
					this.state = 821;
					(_localctx as ColumnExprCaseContext)._elseExpr = this.columnExpr(0);
					}
				}

				this.state = 824;
				this.match(TRQLParser.END);
				}
				break;

			case 2:
				{
				_localctx = new ColumnExprCastContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 826;
				this.match(TRQLParser.CAST);
				this.state = 827;
				this.match(TRQLParser.LPAREN);
				this.state = 828;
				this.columnExpr(0);
				this.state = 829;
				this.match(TRQLParser.AS);
				this.state = 830;
				this.columnTypeExpr();
				this.state = 831;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 3:
				{
				_localctx = new ColumnExprDateContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 833;
				this.match(TRQLParser.DATE);
				this.state = 834;
				this.match(TRQLParser.STRING_LITERAL);
				}
				break;

			case 4:
				{
				_localctx = new ColumnExprIntervalStringContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 835;
				this.match(TRQLParser.INTERVAL);
				this.state = 836;
				this.match(TRQLParser.STRING_LITERAL);
				}
				break;

			case 5:
				{
				_localctx = new ColumnExprIntervalContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 837;
				this.match(TRQLParser.INTERVAL);
				this.state = 838;
				this.columnExpr(0);
				this.state = 839;
				this.interval();
				}
				break;

			case 6:
				{
				_localctx = new ColumnExprSubstringContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 841;
				this.match(TRQLParser.SUBSTRING);
				this.state = 842;
				this.match(TRQLParser.LPAREN);
				this.state = 843;
				this.columnExpr(0);
				this.state = 844;
				this.match(TRQLParser.FROM);
				this.state = 845;
				this.columnExpr(0);
				this.state = 848;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.FOR) {
					{
					this.state = 846;
					this.match(TRQLParser.FOR);
					this.state = 847;
					this.columnExpr(0);
					}
				}

				this.state = 850;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 7:
				{
				_localctx = new ColumnExprTimestampContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 852;
				this.match(TRQLParser.TIMESTAMP);
				this.state = 853;
				this.match(TRQLParser.STRING_LITERAL);
				}
				break;

			case 8:
				{
				_localctx = new ColumnExprTrimContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 854;
				this.match(TRQLParser.TRIM);
				this.state = 855;
				this.match(TRQLParser.LPAREN);
				this.state = 856;
				_la = this._input.LA(1);
				if (!(_la === TRQLParser.BOTH || _la === TRQLParser.LEADING || _la === TRQLParser.TRAILING)) {
				this._errHandler.recoverInline(this);
				} else {
					if (this._input.LA(1) === Token.EOF) {
						this.matchedEOF = true;
					}

					this._errHandler.reportMatch(this);
					this.consume();
				}
				this.state = 857;
				this.string();
				this.state = 858;
				this.match(TRQLParser.FROM);
				this.state = 859;
				this.columnExpr(0);
				this.state = 860;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 9:
				{
				_localctx = new ColumnExprWinFunctionContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 862;
				this.identifier();
				{
				this.state = 863;
				this.match(TRQLParser.LPAREN);
				this.state = 865;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
					{
					this.state = 864;
					(_localctx as ColumnExprWinFunctionContext)._columnExprs = this.columnExprList();
					}
				}

				this.state = 867;
				this.match(TRQLParser.RPAREN);
				}
				this.state = 877;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.LPAREN) {
					{
					this.state = 869;
					this.match(TRQLParser.LPAREN);
					this.state = 871;
					this._errHandler.sync(this);
					switch ( this.interpreter.adaptivePredict(this._input, 107, this._ctx) ) {
					case 1:
						{
						this.state = 870;
						this.match(TRQLParser.DISTINCT);
						}
						break;
					}
					this.state = 874;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
						{
						this.state = 873;
						(_localctx as ColumnExprWinFunctionContext)._columnArgList = this.columnExprList();
						}
					}

					this.state = 876;
					this.match(TRQLParser.RPAREN);
					}
				}

				this.state = 879;
				this.match(TRQLParser.OVER);
				this.state = 880;
				this.match(TRQLParser.LPAREN);
				this.state = 881;
				this.windowExpr();
				this.state = 882;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 10:
				{
				_localctx = new ColumnExprWinFunctionTargetContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 884;
				this.identifier();
				{
				this.state = 885;
				this.match(TRQLParser.LPAREN);
				this.state = 887;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
					{
					this.state = 886;
					(_localctx as ColumnExprWinFunctionTargetContext)._columnExprs = this.columnExprList();
					}
				}

				this.state = 889;
				this.match(TRQLParser.RPAREN);
				}
				this.state = 899;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.LPAREN) {
					{
					this.state = 891;
					this.match(TRQLParser.LPAREN);
					this.state = 893;
					this._errHandler.sync(this);
					switch ( this.interpreter.adaptivePredict(this._input, 111, this._ctx) ) {
					case 1:
						{
						this.state = 892;
						this.match(TRQLParser.DISTINCT);
						}
						break;
					}
					this.state = 896;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
						{
						this.state = 895;
						(_localctx as ColumnExprWinFunctionTargetContext)._columnArgList = this.columnExprList();
						}
					}

					this.state = 898;
					this.match(TRQLParser.RPAREN);
					}
				}

				this.state = 901;
				this.match(TRQLParser.OVER);
				this.state = 902;
				this.identifier();
				}
				break;

			case 11:
				{
				_localctx = new ColumnExprFunctionContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 904;
				this.identifier();
				this.state = 910;
				this._errHandler.sync(this);
				switch ( this.interpreter.adaptivePredict(this._input, 115, this._ctx) ) {
				case 1:
					{
					this.state = 905;
					this.match(TRQLParser.LPAREN);
					this.state = 907;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
					if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
						{
						this.state = 906;
						(_localctx as ColumnExprFunctionContext)._columnExprs = this.columnExprList();
						}
					}

					this.state = 909;
					this.match(TRQLParser.RPAREN);
					}
					break;
				}
				this.state = 912;
				this.match(TRQLParser.LPAREN);
				this.state = 914;
				this._errHandler.sync(this);
				switch ( this.interpreter.adaptivePredict(this._input, 116, this._ctx) ) {
				case 1:
					{
					this.state = 913;
					this.match(TRQLParser.DISTINCT);
					}
					break;
				}
				this.state = 917;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
					{
					this.state = 916;
					(_localctx as ColumnExprFunctionContext)._columnArgList = this.columnExprList();
					}
				}

				this.state = 919;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 12:
				{
				_localctx = new ColumnExprTagElementContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 921;
				this.tRQLxTagElement();
				}
				break;

			case 13:
				{
				_localctx = new ColumnExprTemplateStringContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 922;
				this.templateString();
				}
				break;

			case 14:
				{
				_localctx = new ColumnExprLiteralContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 923;
				this.literal();
				}
				break;

			case 15:
				{
				_localctx = new ColumnExprNegateContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 924;
				this.match(TRQLParser.DASH);
				this.state = 925;
				this.columnExpr(20);
				}
				break;

			case 16:
				{
				_localctx = new ColumnExprNotContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 926;
				this.match(TRQLParser.NOT);
				this.state = 927;
				this.columnExpr(14);
				}
				break;

			case 17:
				{
				_localctx = new ColumnExprAsteriskContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 931;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)))) !== 0)) {
					{
					this.state = 928;
					this.tableIdentifier();
					this.state = 929;
					this.match(TRQLParser.DOT);
					}
				}

				this.state = 933;
				this.match(TRQLParser.ASTERISK);
				}
				break;

			case 18:
				{
				_localctx = new ColumnExprSubqueryContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 934;
				this.match(TRQLParser.LPAREN);
				this.state = 935;
				this.selectSetStmt();
				this.state = 936;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 19:
				{
				_localctx = new ColumnExprParensContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 938;
				this.match(TRQLParser.LPAREN);
				this.state = 939;
				this.columnExpr(0);
				this.state = 940;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 20:
				{
				_localctx = new ColumnExprTupleContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 942;
				this.match(TRQLParser.LPAREN);
				this.state = 943;
				this.columnExprList();
				this.state = 944;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 21:
				{
				_localctx = new ColumnExprArrayContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 946;
				this.match(TRQLParser.LBRACKET);
				this.state = 948;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
					{
					this.state = 947;
					this.columnExprList();
					}
				}

				this.state = 950;
				this.match(TRQLParser.RBRACKET);
				}
				break;

			case 22:
				{
				_localctx = new ColumnExprDictContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 951;
				this.match(TRQLParser.LBRACE);
				this.state = 953;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
					{
					this.state = 952;
					this.kvPairList();
					}
				}

				this.state = 955;
				this.match(TRQLParser.RBRACE);
				}
				break;

			case 23:
				{
				_localctx = new ColumnExprLambdaContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 956;
				this.columnLambdaExpr();
				}
				break;

			case 24:
				{
				_localctx = new ColumnExprIdentifierContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 957;
				this.columnIdentifier();
				}
				break;
			}
			this._ctx._stop = this._input.tryLT(-1);
			this.state = 1075;
			this._errHandler.sync(this);
			_alt = this.interpreter.adaptivePredict(this._input, 133, this._ctx);
			while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
				if (_alt === 1) {
					if (this._parseListeners != null) {
						this.triggerExitRuleEvent();
					}
					_prevctx = _localctx;
					{
					this.state = 1073;
					this._errHandler.sync(this);
					switch ( this.interpreter.adaptivePredict(this._input, 132, this._ctx) ) {
					case 1:
						{
						_localctx = new ColumnExprPrecedence1Context(new ColumnExprContext(_parentctx, _parentState));
						(_localctx as ColumnExprPrecedence1Context)._left = _prevctx;
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 960;
						if (!(this.precpred(this._ctx, 19))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 19)");
						}
						this.state = 964;
						this._errHandler.sync(this);
						switch (this._input.LA(1)) {
						case TRQLParser.ASTERISK:
							{
							this.state = 961;
							(_localctx as ColumnExprPrecedence1Context)._operator = this.match(TRQLParser.ASTERISK);
							}
							break;
						case TRQLParser.SLASH:
							{
							this.state = 962;
							(_localctx as ColumnExprPrecedence1Context)._operator = this.match(TRQLParser.SLASH);
							}
							break;
						case TRQLParser.PERCENT:
							{
							this.state = 963;
							(_localctx as ColumnExprPrecedence1Context)._operator = this.match(TRQLParser.PERCENT);
							}
							break;
						default:
							throw new NoViableAltException(this);
						}
						this.state = 966;
						(_localctx as ColumnExprPrecedence1Context)._right = this.columnExpr(20);
						}
						break;

					case 2:
						{
						_localctx = new ColumnExprPrecedence2Context(new ColumnExprContext(_parentctx, _parentState));
						(_localctx as ColumnExprPrecedence2Context)._left = _prevctx;
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 967;
						if (!(this.precpred(this._ctx, 18))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 18)");
						}
						this.state = 971;
						this._errHandler.sync(this);
						switch (this._input.LA(1)) {
						case TRQLParser.PLUS:
							{
							this.state = 968;
							(_localctx as ColumnExprPrecedence2Context)._operator = this.match(TRQLParser.PLUS);
							}
							break;
						case TRQLParser.DASH:
							{
							this.state = 969;
							(_localctx as ColumnExprPrecedence2Context)._operator = this.match(TRQLParser.DASH);
							}
							break;
						case TRQLParser.CONCAT:
							{
							this.state = 970;
							(_localctx as ColumnExprPrecedence2Context)._operator = this.match(TRQLParser.CONCAT);
							}
							break;
						default:
							throw new NoViableAltException(this);
						}
						this.state = 973;
						(_localctx as ColumnExprPrecedence2Context)._right = this.columnExpr(19);
						}
						break;

					case 3:
						{
						_localctx = new ColumnExprPrecedence3Context(new ColumnExprContext(_parentctx, _parentState));
						(_localctx as ColumnExprPrecedence3Context)._left = _prevctx;
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 974;
						if (!(this.precpred(this._ctx, 17))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 17)");
						}
						this.state = 999;
						this._errHandler.sync(this);
						switch ( this.interpreter.adaptivePredict(this._input, 127, this._ctx) ) {
						case 1:
							{
							this.state = 975;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.EQ_DOUBLE);
							}
							break;

						case 2:
							{
							this.state = 976;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.EQ_SINGLE);
							}
							break;

						case 3:
							{
							this.state = 977;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.NOT_EQ);
							}
							break;

						case 4:
							{
							this.state = 978;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.LT_EQ);
							}
							break;

						case 5:
							{
							this.state = 979;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.LT);
							}
							break;

						case 6:
							{
							this.state = 980;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.GT_EQ);
							}
							break;

						case 7:
							{
							this.state = 981;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.GT);
							}
							break;

						case 8:
							{
							this.state = 983;
							this._errHandler.sync(this);
							_la = this._input.LA(1);
							if (_la === TRQLParser.NOT) {
								{
								this.state = 982;
								(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.NOT);
								}
							}

							this.state = 985;
							this.match(TRQLParser.IN);
							this.state = 987;
							this._errHandler.sync(this);
							switch ( this.interpreter.adaptivePredict(this._input, 125, this._ctx) ) {
							case 1:
								{
								this.state = 986;
								this.match(TRQLParser.COHORT);
								}
								break;
							}
							}
							break;

						case 9:
							{
							this.state = 990;
							this._errHandler.sync(this);
							_la = this._input.LA(1);
							if (_la === TRQLParser.NOT) {
								{
								this.state = 989;
								(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.NOT);
								}
							}

							this.state = 992;
							_la = this._input.LA(1);
							if (!(_la === TRQLParser.ILIKE || _la === TRQLParser.LIKE)) {
							this._errHandler.recoverInline(this);
							} else {
								if (this._input.LA(1) === Token.EOF) {
									this.matchedEOF = true;
								}

								this._errHandler.reportMatch(this);
								this.consume();
							}
							}
							break;

						case 10:
							{
							this.state = 993;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.REGEX_SINGLE);
							}
							break;

						case 11:
							{
							this.state = 994;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.REGEX_DOUBLE);
							}
							break;

						case 12:
							{
							this.state = 995;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.NOT_REGEX);
							}
							break;

						case 13:
							{
							this.state = 996;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.IREGEX_SINGLE);
							}
							break;

						case 14:
							{
							this.state = 997;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.IREGEX_DOUBLE);
							}
							break;

						case 15:
							{
							this.state = 998;
							(_localctx as ColumnExprPrecedence3Context)._operator = this.match(TRQLParser.NOT_IREGEX);
							}
							break;
						}
						this.state = 1001;
						(_localctx as ColumnExprPrecedence3Context)._right = this.columnExpr(18);
						}
						break;

					case 4:
						{
						_localctx = new ColumnExprNullishContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1002;
						if (!(this.precpred(this._ctx, 15))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 15)");
						}
						this.state = 1003;
						this.match(TRQLParser.NULLISH);
						this.state = 1004;
						this.columnExpr(16);
						}
						break;

					case 5:
						{
						_localctx = new ColumnExprAndContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1005;
						if (!(this.precpred(this._ctx, 13))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 13)");
						}
						this.state = 1006;
						this.match(TRQLParser.AND);
						this.state = 1007;
						this.columnExpr(14);
						}
						break;

					case 6:
						{
						_localctx = new ColumnExprOrContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1008;
						if (!(this.precpred(this._ctx, 12))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 12)");
						}
						this.state = 1009;
						this.match(TRQLParser.OR);
						this.state = 1010;
						this.columnExpr(13);
						}
						break;

					case 7:
						{
						_localctx = new ColumnExprBetweenContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1011;
						if (!(this.precpred(this._ctx, 11))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 11)");
						}
						this.state = 1013;
						this._errHandler.sync(this);
						_la = this._input.LA(1);
						if (_la === TRQLParser.NOT) {
							{
							this.state = 1012;
							this.match(TRQLParser.NOT);
							}
						}

						this.state = 1015;
						this.match(TRQLParser.BETWEEN);
						this.state = 1016;
						this.columnExpr(0);
						this.state = 1017;
						this.match(TRQLParser.AND);
						this.state = 1018;
						this.columnExpr(12);
						}
						break;

					case 8:
						{
						_localctx = new ColumnExprTernaryOpContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1020;
						if (!(this.precpred(this._ctx, 10))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 10)");
						}
						this.state = 1021;
						this.match(TRQLParser.QUERY);
						this.state = 1022;
						this.columnExpr(0);
						this.state = 1023;
						this.match(TRQLParser.COLON);
						this.state = 1024;
						this.columnExpr(10);
						}
						break;

					case 9:
						{
						_localctx = new ColumnExprCallSelectContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1026;
						if (!(this.precpred(this._ctx, 31))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 31)");
						}
						this.state = 1027;
						this.match(TRQLParser.LPAREN);
						this.state = 1028;
						this.selectSetStmt();
						this.state = 1029;
						this.match(TRQLParser.RPAREN);
						}
						break;

					case 10:
						{
						_localctx = new ColumnExprCallContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1031;
						if (!(this.precpred(this._ctx, 30))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 30)");
						}
						this.state = 1032;
						this.match(TRQLParser.LPAREN);
						this.state = 1034;
						this._errHandler.sync(this);
						_la = this._input.LA(1);
						if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
							{
							this.state = 1033;
							this.columnExprList();
							}
						}

						this.state = 1036;
						this.match(TRQLParser.RPAREN);
						}
						break;

					case 11:
						{
						_localctx = new ColumnExprArrayAccessContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1037;
						if (!(this.precpred(this._ctx, 26))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 26)");
						}
						this.state = 1038;
						this.match(TRQLParser.LBRACKET);
						this.state = 1039;
						this.columnExpr(0);
						this.state = 1040;
						this.match(TRQLParser.RBRACKET);
						}
						break;

					case 12:
						{
						_localctx = new ColumnExprTupleAccessContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1042;
						if (!(this.precpred(this._ctx, 25))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 25)");
						}
						this.state = 1043;
						this.match(TRQLParser.DOT);
						this.state = 1044;
						this.match(TRQLParser.DECIMAL_LITERAL);
						}
						break;

					case 13:
						{
						_localctx = new ColumnExprPropertyAccessContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1045;
						if (!(this.precpred(this._ctx, 24))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 24)");
						}
						this.state = 1046;
						this.match(TRQLParser.DOT);
						this.state = 1047;
						this.identifier();
						}
						break;

					case 14:
						{
						_localctx = new ColumnExprNullArrayAccessContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1048;
						if (!(this.precpred(this._ctx, 23))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 23)");
						}
						this.state = 1049;
						this.match(TRQLParser.NULL_PROPERTY);
						this.state = 1050;
						this.match(TRQLParser.LBRACKET);
						this.state = 1051;
						this.columnExpr(0);
						this.state = 1052;
						this.match(TRQLParser.RBRACKET);
						}
						break;

					case 15:
						{
						_localctx = new ColumnExprNullTupleAccessContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1054;
						if (!(this.precpred(this._ctx, 22))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 22)");
						}
						this.state = 1055;
						this.match(TRQLParser.NULL_PROPERTY);
						this.state = 1056;
						this.match(TRQLParser.DECIMAL_LITERAL);
						}
						break;

					case 16:
						{
						_localctx = new ColumnExprNullPropertyAccessContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1057;
						if (!(this.precpred(this._ctx, 21))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 21)");
						}
						this.state = 1058;
						this.match(TRQLParser.NULL_PROPERTY);
						this.state = 1059;
						this.identifier();
						}
						break;

					case 17:
						{
						_localctx = new ColumnExprIsNullContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1060;
						if (!(this.precpred(this._ctx, 16))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 16)");
						}
						this.state = 1061;
						this.match(TRQLParser.IS);
						this.state = 1063;
						this._errHandler.sync(this);
						_la = this._input.LA(1);
						if (_la === TRQLParser.NOT) {
							{
							this.state = 1062;
							this.match(TRQLParser.NOT);
							}
						}

						this.state = 1065;
						this.match(TRQLParser.NULL_SQL);
						}
						break;

					case 18:
						{
						_localctx = new ColumnExprAliasContext(new ColumnExprContext(_parentctx, _parentState));
						this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_columnExpr);
						this.state = 1066;
						if (!(this.precpred(this._ctx, 9))) {
							throw this.createFailedPredicateException("this.precpred(this._ctx, 9)");
						}
						this.state = 1071;
						this._errHandler.sync(this);
						switch ( this.interpreter.adaptivePredict(this._input, 131, this._ctx) ) {
						case 1:
							{
							this.state = 1067;
							this.match(TRQLParser.AS);
							this.state = 1068;
							this.identifier();
							}
							break;

						case 2:
							{
							this.state = 1069;
							this.match(TRQLParser.AS);
							this.state = 1070;
							this.match(TRQLParser.STRING_LITERAL);
							}
							break;
						}
						}
						break;
					}
					}
				}
				this.state = 1077;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 133, this._ctx);
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.unrollRecursionContexts(_parentctx);
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public columnLambdaExpr(): ColumnLambdaExprContext {
		let _localctx: ColumnLambdaExprContext = new ColumnLambdaExprContext(this._ctx, this.state);
		this.enterRule(_localctx, 124, TRQLParser.RULE_columnLambdaExpr);
		let _la: number;
		try {
			let _alt: number;
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1105;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 138, this._ctx) ) {
			case 1:
				{
				this.state = 1078;
				this.match(TRQLParser.LPAREN);
				this.state = 1079;
				this.identifier();
				this.state = 1084;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 134, this._ctx);
				while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
					if (_alt === 1) {
						{
						{
						this.state = 1080;
						this.match(TRQLParser.COMMA);
						this.state = 1081;
						this.identifier();
						}
						}
					}
					this.state = 1086;
					this._errHandler.sync(this);
					_alt = this.interpreter.adaptivePredict(this._input, 134, this._ctx);
				}
				this.state = 1088;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.COMMA) {
					{
					this.state = 1087;
					this.match(TRQLParser.COMMA);
					}
				}

				this.state = 1090;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 2:
				{
				this.state = 1092;
				this.identifier();
				this.state = 1097;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 136, this._ctx);
				while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
					if (_alt === 1) {
						{
						{
						this.state = 1093;
						this.match(TRQLParser.COMMA);
						this.state = 1094;
						this.identifier();
						}
						}
					}
					this.state = 1099;
					this._errHandler.sync(this);
					_alt = this.interpreter.adaptivePredict(this._input, 136, this._ctx);
				}
				this.state = 1101;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				if (_la === TRQLParser.COMMA) {
					{
					this.state = 1100;
					this.match(TRQLParser.COMMA);
					}
				}

				}
				break;

			case 3:
				{
				this.state = 1103;
				this.match(TRQLParser.LPAREN);
				this.state = 1104;
				this.match(TRQLParser.RPAREN);
				}
				break;
			}
			this.state = 1107;
			this.match(TRQLParser.ARROW);
			this.state = 1110;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 139, this._ctx) ) {
			case 1:
				{
				this.state = 1108;
				this.columnExpr(0);
				}
				break;

			case 2:
				{
				this.state = 1109;
				this.block();
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public tRQLxChildElement(): TRQLxChildElementContext {
		let _localctx: TRQLxChildElementContext = new TRQLxChildElementContext(this._ctx, this.state);
		this.enterRule(_localctx, 126, TRQLParser.RULE_tRQLxChildElement);
		try {
			this.state = 1118;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.LT:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1112;
				this.tRQLxTagElement();
				}
				break;
			case TRQLParser.TRQLX_TEXT_TEXT:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 1113;
				this.match(TRQLParser.TRQLX_TEXT_TEXT);
				}
				break;
			case TRQLParser.LBRACE:
				this.enterOuterAlt(_localctx, 3);
				{
				this.state = 1114;
				this.match(TRQLParser.LBRACE);
				this.state = 1115;
				this.columnExpr(0);
				this.state = 1116;
				this.match(TRQLParser.RBRACE);
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public tRQLxTagElement(): TRQLxTagElementContext {
		let _localctx: TRQLxTagElementContext = new TRQLxTagElementContext(this._ctx, this.state);
		this.enterRule(_localctx, 128, TRQLParser.RULE_tRQLxTagElement);
		let _la: number;
		try {
			this.state = 1149;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 144, this._ctx) ) {
			case 1:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1120;
				this.match(TRQLParser.LT);
				this.state = 1121;
				this.identifier();
				this.state = 1125;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				while ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)))) !== 0)) {
					{
					{
					this.state = 1122;
					this.tRQLxTagAttribute();
					}
					}
					this.state = 1127;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
				}
				this.state = 1128;
				this.match(TRQLParser.SLASH_GT);
				}
				break;

			case 2:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 1130;
				this.match(TRQLParser.LT);
				this.state = 1131;
				this.identifier();
				this.state = 1135;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				while ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)))) !== 0)) {
					{
					{
					this.state = 1132;
					this.tRQLxTagAttribute();
					}
					}
					this.state = 1137;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
				}
				this.state = 1138;
				this.match(TRQLParser.GT);
				this.state = 1142;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
				while (_la === TRQLParser.LBRACE || _la === TRQLParser.LT || _la === TRQLParser.TRQLX_TEXT_TEXT) {
					{
					{
					this.state = 1139;
					this.tRQLxChildElement();
					}
					}
					this.state = 1144;
					this._errHandler.sync(this);
					_la = this._input.LA(1);
				}
				this.state = 1145;
				this.match(TRQLParser.LT_SLASH);
				this.state = 1146;
				this.identifier();
				this.state = 1147;
				this.match(TRQLParser.GT);
				}
				break;
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public tRQLxTagAttribute(): TRQLxTagAttributeContext {
		let _localctx: TRQLxTagAttributeContext = new TRQLxTagAttributeContext(this._ctx, this.state);
		this.enterRule(_localctx, 130, TRQLParser.RULE_tRQLxTagAttribute);
		try {
			this.state = 1162;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 145, this._ctx) ) {
			case 1:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1151;
				this.identifier();
				this.state = 1152;
				this.match(TRQLParser.EQ_SINGLE);
				this.state = 1153;
				this.string();
				}
				break;

			case 2:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 1155;
				this.identifier();
				this.state = 1156;
				this.match(TRQLParser.EQ_SINGLE);
				this.state = 1157;
				this.match(TRQLParser.LBRACE);
				this.state = 1158;
				this.columnExpr(0);
				this.state = 1159;
				this.match(TRQLParser.RBRACE);
				}
				break;

			case 3:
				this.enterOuterAlt(_localctx, 3);
				{
				this.state = 1161;
				this.identifier();
				}
				break;
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public withExprList(): WithExprListContext {
		let _localctx: WithExprListContext = new WithExprListContext(this._ctx, this.state);
		this.enterRule(_localctx, 132, TRQLParser.RULE_withExprList);
		let _la: number;
		try {
			let _alt: number;
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1164;
			this.withExpr();
			this.state = 1169;
			this._errHandler.sync(this);
			_alt = this.interpreter.adaptivePredict(this._input, 146, this._ctx);
			while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
				if (_alt === 1) {
					{
					{
					this.state = 1165;
					this.match(TRQLParser.COMMA);
					this.state = 1166;
					this.withExpr();
					}
					}
				}
				this.state = 1171;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 146, this._ctx);
			}
			this.state = 1173;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.COMMA) {
				{
				this.state = 1172;
				this.match(TRQLParser.COMMA);
				}
			}

			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public withExpr(): WithExprContext {
		let _localctx: WithExprContext = new WithExprContext(this._ctx, this.state);
		this.enterRule(_localctx, 134, TRQLParser.RULE_withExpr);
		try {
			this.state = 1185;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 148, this._ctx) ) {
			case 1:
				_localctx = new WithExprSubqueryContext(_localctx);
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1175;
				this.identifier();
				this.state = 1176;
				this.match(TRQLParser.AS);
				this.state = 1177;
				this.match(TRQLParser.LPAREN);
				this.state = 1178;
				this.selectSetStmt();
				this.state = 1179;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 2:
				_localctx = new WithExprColumnContext(_localctx);
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 1181;
				this.columnExpr(0);
				this.state = 1182;
				this.match(TRQLParser.AS);
				this.state = 1183;
				this.identifier();
				}
				break;
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public columnIdentifier(): ColumnIdentifierContext {
		let _localctx: ColumnIdentifierContext = new ColumnIdentifierContext(this._ctx, this.state);
		this.enterRule(_localctx, 136, TRQLParser.RULE_columnIdentifier);
		try {
			this.state = 1194;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.LBRACE:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1187;
				this.placeholder();
				}
				break;
			case TRQLParser.ALL:
			case TRQLParser.AND:
			case TRQLParser.ANTI:
			case TRQLParser.ANY:
			case TRQLParser.ARRAY:
			case TRQLParser.AS:
			case TRQLParser.ASCENDING:
			case TRQLParser.ASOF:
			case TRQLParser.BETWEEN:
			case TRQLParser.BOTH:
			case TRQLParser.BY:
			case TRQLParser.CASE:
			case TRQLParser.CAST:
			case TRQLParser.COHORT:
			case TRQLParser.COLLATE:
			case TRQLParser.CROSS:
			case TRQLParser.CUBE:
			case TRQLParser.CURRENT:
			case TRQLParser.DATE:
			case TRQLParser.DAY:
			case TRQLParser.DESC:
			case TRQLParser.DESCENDING:
			case TRQLParser.DISTINCT:
			case TRQLParser.ELSE:
			case TRQLParser.END:
			case TRQLParser.EXTRACT:
			case TRQLParser.FINAL:
			case TRQLParser.FIRST:
			case TRQLParser.FOLLOWING:
			case TRQLParser.FOR:
			case TRQLParser.FROM:
			case TRQLParser.FULL:
			case TRQLParser.GROUP:
			case TRQLParser.HAVING:
			case TRQLParser.HOUR:
			case TRQLParser.ID:
			case TRQLParser.IF:
			case TRQLParser.ILIKE:
			case TRQLParser.IN:
			case TRQLParser.INNER:
			case TRQLParser.INTERVAL:
			case TRQLParser.IS:
			case TRQLParser.JOIN:
			case TRQLParser.KEY:
			case TRQLParser.LAST:
			case TRQLParser.LEADING:
			case TRQLParser.LEFT:
			case TRQLParser.LIKE:
			case TRQLParser.LIMIT:
			case TRQLParser.MINUTE:
			case TRQLParser.MONTH:
			case TRQLParser.NOT:
			case TRQLParser.NULLS:
			case TRQLParser.OFFSET:
			case TRQLParser.ON:
			case TRQLParser.OR:
			case TRQLParser.ORDER:
			case TRQLParser.OUTER:
			case TRQLParser.OVER:
			case TRQLParser.PARTITION:
			case TRQLParser.PRECEDING:
			case TRQLParser.PREWHERE:
			case TRQLParser.QUARTER:
			case TRQLParser.RANGE:
			case TRQLParser.RETURN:
			case TRQLParser.RIGHT:
			case TRQLParser.ROLLUP:
			case TRQLParser.ROW:
			case TRQLParser.ROWS:
			case TRQLParser.SAMPLE:
			case TRQLParser.SECOND:
			case TRQLParser.SELECT:
			case TRQLParser.SEMI:
			case TRQLParser.SETTINGS:
			case TRQLParser.SUBSTRING:
			case TRQLParser.THEN:
			case TRQLParser.TIES:
			case TRQLParser.TIMESTAMP:
			case TRQLParser.TO:
			case TRQLParser.TOP:
			case TRQLParser.TOTALS:
			case TRQLParser.TRAILING:
			case TRQLParser.TRIM:
			case TRQLParser.TRUNCATE:
			case TRQLParser.UNBOUNDED:
			case TRQLParser.UNION:
			case TRQLParser.USING:
			case TRQLParser.WEEK:
			case TRQLParser.WHEN:
			case TRQLParser.WHERE:
			case TRQLParser.WINDOW:
			case TRQLParser.WITH:
			case TRQLParser.YEAR:
			case TRQLParser.IDENTIFIER:
				this.enterOuterAlt(_localctx, 2);
				{
				{
				this.state = 1191;
				this._errHandler.sync(this);
				switch ( this.interpreter.adaptivePredict(this._input, 149, this._ctx) ) {
				case 1:
					{
					this.state = 1188;
					this.tableIdentifier();
					this.state = 1189;
					this.match(TRQLParser.DOT);
					}
					break;
				}
				this.state = 1193;
				this.nestedIdentifier();
				}
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public nestedIdentifier(): NestedIdentifierContext {
		let _localctx: NestedIdentifierContext = new NestedIdentifierContext(this._ctx, this.state);
		this.enterRule(_localctx, 138, TRQLParser.RULE_nestedIdentifier);
		try {
			let _alt: number;
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1196;
			this.identifier();
			this.state = 1201;
			this._errHandler.sync(this);
			_alt = this.interpreter.adaptivePredict(this._input, 151, this._ctx);
			while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
				if (_alt === 1) {
					{
					{
					this.state = 1197;
					this.match(TRQLParser.DOT);
					this.state = 1198;
					this.identifier();
					}
					}
				}
				this.state = 1203;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 151, this._ctx);
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}

	public tableExpr(): TableExprContext;
	public tableExpr(_p: number): TableExprContext;
	// @RuleVersion(0)
	public tableExpr(_p?: number): TableExprContext {
		if (_p === undefined) {
			_p = 0;
		}

		let _parentctx: ParserRuleContext = this._ctx;
		let _parentState: number = this.state;
		let _localctx: TableExprContext = new TableExprContext(this._ctx, _parentState);
		let _prevctx: TableExprContext = _localctx;
		let _startState: number = 140;
		this.enterRecursionRule(_localctx, 140, TRQLParser.RULE_tableExpr, _p);
		try {
			let _alt: number;
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1213;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 152, this._ctx) ) {
			case 1:
				{
				_localctx = new TableExprIdentifierContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;

				this.state = 1205;
				this.tableIdentifier();
				}
				break;

			case 2:
				{
				_localctx = new TableExprFunctionContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 1206;
				this.tableFunctionExpr();
				}
				break;

			case 3:
				{
				_localctx = new TableExprSubqueryContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 1207;
				this.match(TRQLParser.LPAREN);
				this.state = 1208;
				this.selectSetStmt();
				this.state = 1209;
				this.match(TRQLParser.RPAREN);
				}
				break;

			case 4:
				{
				_localctx = new TableExprTagContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 1211;
				this.tRQLxTagElement();
				}
				break;

			case 5:
				{
				_localctx = new TableExprPlaceholderContext(_localctx);
				this._ctx = _localctx;
				_prevctx = _localctx;
				this.state = 1212;
				this.placeholder();
				}
				break;
			}
			this._ctx._stop = this._input.tryLT(-1);
			this.state = 1223;
			this._errHandler.sync(this);
			_alt = this.interpreter.adaptivePredict(this._input, 154, this._ctx);
			while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
				if (_alt === 1) {
					if (this._parseListeners != null) {
						this.triggerExitRuleEvent();
					}
					_prevctx = _localctx;
					{
					{
					_localctx = new TableExprAliasContext(new TableExprContext(_parentctx, _parentState));
					this.pushNewRecursionContext(_localctx, _startState, TRQLParser.RULE_tableExpr);
					this.state = 1215;
					if (!(this.precpred(this._ctx, 3))) {
						throw this.createFailedPredicateException("this.precpred(this._ctx, 3)");
					}
					this.state = 1219;
					this._errHandler.sync(this);
					switch (this._input.LA(1)) {
					case TRQLParser.DATE:
					case TRQLParser.FIRST:
					case TRQLParser.ID:
					case TRQLParser.KEY:
					case TRQLParser.IDENTIFIER:
						{
						this.state = 1216;
						this.alias();
						}
						break;
					case TRQLParser.AS:
						{
						this.state = 1217;
						this.match(TRQLParser.AS);
						this.state = 1218;
						this.identifier();
						}
						break;
					default:
						throw new NoViableAltException(this);
					}
					}
					}
				}
				this.state = 1225;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 154, this._ctx);
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.unrollRecursionContexts(_parentctx);
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public tableFunctionExpr(): TableFunctionExprContext {
		let _localctx: TableFunctionExprContext = new TableFunctionExprContext(this._ctx, this.state);
		this.enterRule(_localctx, 142, TRQLParser.RULE_tableFunctionExpr);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1226;
			this.identifier();
			this.state = 1227;
			this.match(TRQLParser.LPAREN);
			this.state = 1229;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if ((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DAY) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.HOUR - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INF - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.MINUTE - 33)) | (1 << (TRQLParser.MONTH - 33)) | (1 << (TRQLParser.NAN_SQL - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULL_SQL - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.QUARTER - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SECOND - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WEEK - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)) | (1 << (TRQLParser.YEAR - 97)) | (1 << (TRQLParser.IDENTIFIER - 97)) | (1 << (TRQLParser.FLOATING_LITERAL - 97)) | (1 << (TRQLParser.OCTAL_LITERAL - 97)) | (1 << (TRQLParser.DECIMAL_LITERAL - 97)) | (1 << (TRQLParser.HEXADECIMAL_LITERAL - 97)) | (1 << (TRQLParser.STRING_LITERAL - 97)) | (1 << (TRQLParser.ASTERISK - 97)) | (1 << (TRQLParser.DASH - 97)) | (1 << (TRQLParser.DOT - 97)))) !== 0) || ((((_la - 131)) & ~0x1F) === 0 && ((1 << (_la - 131)) & ((1 << (TRQLParser.LBRACE - 131)) | (1 << (TRQLParser.LBRACKET - 131)) | (1 << (TRQLParser.LPAREN - 131)) | (1 << (TRQLParser.LT - 131)) | (1 << (TRQLParser.PLUS - 131)) | (1 << (TRQLParser.QUOTE_SINGLE_TEMPLATE - 131)))) !== 0)) {
				{
				this.state = 1228;
				this.tableArgList();
				}
			}

			this.state = 1231;
			this.match(TRQLParser.RPAREN);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public tableIdentifier(): TableIdentifierContext {
		let _localctx: TableIdentifierContext = new TableIdentifierContext(this._ctx, this.state);
		this.enterRule(_localctx, 144, TRQLParser.RULE_tableIdentifier);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1236;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 156, this._ctx) ) {
			case 1:
				{
				this.state = 1233;
				this.databaseIdentifier();
				this.state = 1234;
				this.match(TRQLParser.DOT);
				}
				break;
			}
			this.state = 1238;
			this.nestedIdentifier();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public tableArgList(): TableArgListContext {
		let _localctx: TableArgListContext = new TableArgListContext(this._ctx, this.state);
		this.enterRule(_localctx, 146, TRQLParser.RULE_tableArgList);
		let _la: number;
		try {
			let _alt: number;
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1240;
			this.columnExpr(0);
			this.state = 1245;
			this._errHandler.sync(this);
			_alt = this.interpreter.adaptivePredict(this._input, 157, this._ctx);
			while (_alt !== 2 && _alt !== ATN.INVALID_ALT_NUMBER) {
				if (_alt === 1) {
					{
					{
					this.state = 1241;
					this.match(TRQLParser.COMMA);
					this.state = 1242;
					this.columnExpr(0);
					}
					}
				}
				this.state = 1247;
				this._errHandler.sync(this);
				_alt = this.interpreter.adaptivePredict(this._input, 157, this._ctx);
			}
			this.state = 1249;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.COMMA) {
				{
				this.state = 1248;
				this.match(TRQLParser.COMMA);
				}
			}

			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public databaseIdentifier(): DatabaseIdentifierContext {
		let _localctx: DatabaseIdentifierContext = new DatabaseIdentifierContext(this._ctx, this.state);
		this.enterRule(_localctx, 148, TRQLParser.RULE_databaseIdentifier);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1251;
			this.identifier();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public floatingLiteral(): FloatingLiteralContext {
		let _localctx: FloatingLiteralContext = new FloatingLiteralContext(this._ctx, this.state);
		this.enterRule(_localctx, 150, TRQLParser.RULE_floatingLiteral);
		let _la: number;
		try {
			this.state = 1261;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.FLOATING_LITERAL:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1253;
				this.match(TRQLParser.FLOATING_LITERAL);
				}
				break;
			case TRQLParser.DOT:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 1254;
				this.match(TRQLParser.DOT);
				this.state = 1255;
				_la = this._input.LA(1);
				if (!(_la === TRQLParser.OCTAL_LITERAL || _la === TRQLParser.DECIMAL_LITERAL)) {
				this._errHandler.recoverInline(this);
				} else {
					if (this._input.LA(1) === Token.EOF) {
						this.matchedEOF = true;
					}

					this._errHandler.reportMatch(this);
					this.consume();
				}
				}
				break;
			case TRQLParser.DECIMAL_LITERAL:
				this.enterOuterAlt(_localctx, 3);
				{
				this.state = 1256;
				this.match(TRQLParser.DECIMAL_LITERAL);
				this.state = 1257;
				this.match(TRQLParser.DOT);
				this.state = 1259;
				this._errHandler.sync(this);
				switch ( this.interpreter.adaptivePredict(this._input, 159, this._ctx) ) {
				case 1:
					{
					this.state = 1258;
					_la = this._input.LA(1);
					if (!(_la === TRQLParser.OCTAL_LITERAL || _la === TRQLParser.DECIMAL_LITERAL)) {
					this._errHandler.recoverInline(this);
					} else {
						if (this._input.LA(1) === Token.EOF) {
							this.matchedEOF = true;
						}

						this._errHandler.reportMatch(this);
						this.consume();
					}
					}
					break;
				}
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public numberLiteral(): NumberLiteralContext {
		let _localctx: NumberLiteralContext = new NumberLiteralContext(this._ctx, this.state);
		this.enterRule(_localctx, 152, TRQLParser.RULE_numberLiteral);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1264;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			if (_la === TRQLParser.DASH || _la === TRQLParser.PLUS) {
				{
				this.state = 1263;
				_la = this._input.LA(1);
				if (!(_la === TRQLParser.DASH || _la === TRQLParser.PLUS)) {
				this._errHandler.recoverInline(this);
				} else {
					if (this._input.LA(1) === Token.EOF) {
						this.matchedEOF = true;
					}

					this._errHandler.reportMatch(this);
					this.consume();
				}
				}
			}

			this.state = 1272;
			this._errHandler.sync(this);
			switch ( this.interpreter.adaptivePredict(this._input, 162, this._ctx) ) {
			case 1:
				{
				this.state = 1266;
				this.floatingLiteral();
				}
				break;

			case 2:
				{
				this.state = 1267;
				this.match(TRQLParser.OCTAL_LITERAL);
				}
				break;

			case 3:
				{
				this.state = 1268;
				this.match(TRQLParser.DECIMAL_LITERAL);
				}
				break;

			case 4:
				{
				this.state = 1269;
				this.match(TRQLParser.HEXADECIMAL_LITERAL);
				}
				break;

			case 5:
				{
				this.state = 1270;
				this.match(TRQLParser.INF);
				}
				break;

			case 6:
				{
				this.state = 1271;
				this.match(TRQLParser.NAN_SQL);
				}
				break;
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public literal(): LiteralContext {
		let _localctx: LiteralContext = new LiteralContext(this._ctx, this.state);
		this.enterRule(_localctx, 154, TRQLParser.RULE_literal);
		try {
			this.state = 1277;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.INF:
			case TRQLParser.NAN_SQL:
			case TRQLParser.FLOATING_LITERAL:
			case TRQLParser.OCTAL_LITERAL:
			case TRQLParser.DECIMAL_LITERAL:
			case TRQLParser.HEXADECIMAL_LITERAL:
			case TRQLParser.DASH:
			case TRQLParser.DOT:
			case TRQLParser.PLUS:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1274;
				this.numberLiteral();
				}
				break;
			case TRQLParser.STRING_LITERAL:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 1275;
				this.match(TRQLParser.STRING_LITERAL);
				}
				break;
			case TRQLParser.NULL_SQL:
				this.enterOuterAlt(_localctx, 3);
				{
				this.state = 1276;
				this.match(TRQLParser.NULL_SQL);
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public interval(): IntervalContext {
		let _localctx: IntervalContext = new IntervalContext(this._ctx, this.state);
		this.enterRule(_localctx, 156, TRQLParser.RULE_interval);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1279;
			_la = this._input.LA(1);
			if (!(_la === TRQLParser.DAY || _la === TRQLParser.HOUR || ((((_la - 58)) & ~0x1F) === 0 && ((1 << (_la - 58)) & ((1 << (TRQLParser.MINUTE - 58)) | (1 << (TRQLParser.MONTH - 58)) | (1 << (TRQLParser.QUARTER - 58)) | (1 << (TRQLParser.SECOND - 58)))) !== 0) || _la === TRQLParser.WEEK || _la === TRQLParser.YEAR)) {
			this._errHandler.recoverInline(this);
			} else {
				if (this._input.LA(1) === Token.EOF) {
					this.matchedEOF = true;
				}

				this._errHandler.reportMatch(this);
				this.consume();
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public keyword(): KeywordContext {
		let _localctx: KeywordContext = new KeywordContext(this._ctx, this.state);
		this.enterRule(_localctx, 158, TRQLParser.RULE_keyword);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1281;
			_la = this._input.LA(1);
			if (!((((_la) & ~0x1F) === 0 && ((1 << _la) & ((1 << TRQLParser.ALL) | (1 << TRQLParser.AND) | (1 << TRQLParser.ANTI) | (1 << TRQLParser.ANY) | (1 << TRQLParser.ARRAY) | (1 << TRQLParser.AS) | (1 << TRQLParser.ASCENDING) | (1 << TRQLParser.ASOF) | (1 << TRQLParser.BETWEEN) | (1 << TRQLParser.BOTH) | (1 << TRQLParser.BY) | (1 << TRQLParser.CASE) | (1 << TRQLParser.CAST) | (1 << TRQLParser.COHORT) | (1 << TRQLParser.COLLATE) | (1 << TRQLParser.CROSS) | (1 << TRQLParser.CUBE) | (1 << TRQLParser.CURRENT) | (1 << TRQLParser.DATE) | (1 << TRQLParser.DESC) | (1 << TRQLParser.DESCENDING) | (1 << TRQLParser.DISTINCT) | (1 << TRQLParser.ELSE) | (1 << TRQLParser.END) | (1 << TRQLParser.EXTRACT) | (1 << TRQLParser.FINAL) | (1 << TRQLParser.FIRST))) !== 0) || ((((_la - 33)) & ~0x1F) === 0 && ((1 << (_la - 33)) & ((1 << (TRQLParser.FOLLOWING - 33)) | (1 << (TRQLParser.FOR - 33)) | (1 << (TRQLParser.FROM - 33)) | (1 << (TRQLParser.FULL - 33)) | (1 << (TRQLParser.GROUP - 33)) | (1 << (TRQLParser.HAVING - 33)) | (1 << (TRQLParser.ID - 33)) | (1 << (TRQLParser.IF - 33)) | (1 << (TRQLParser.ILIKE - 33)) | (1 << (TRQLParser.IN - 33)) | (1 << (TRQLParser.INNER - 33)) | (1 << (TRQLParser.INTERVAL - 33)) | (1 << (TRQLParser.IS - 33)) | (1 << (TRQLParser.JOIN - 33)) | (1 << (TRQLParser.KEY - 33)) | (1 << (TRQLParser.LAST - 33)) | (1 << (TRQLParser.LEADING - 33)) | (1 << (TRQLParser.LEFT - 33)) | (1 << (TRQLParser.LIKE - 33)) | (1 << (TRQLParser.LIMIT - 33)) | (1 << (TRQLParser.NOT - 33)) | (1 << (TRQLParser.NULLS - 33)) | (1 << (TRQLParser.OFFSET - 33)))) !== 0) || ((((_la - 65)) & ~0x1F) === 0 && ((1 << (_la - 65)) & ((1 << (TRQLParser.ON - 65)) | (1 << (TRQLParser.OR - 65)) | (1 << (TRQLParser.ORDER - 65)) | (1 << (TRQLParser.OUTER - 65)) | (1 << (TRQLParser.OVER - 65)) | (1 << (TRQLParser.PARTITION - 65)) | (1 << (TRQLParser.PRECEDING - 65)) | (1 << (TRQLParser.PREWHERE - 65)) | (1 << (TRQLParser.RANGE - 65)) | (1 << (TRQLParser.RETURN - 65)) | (1 << (TRQLParser.RIGHT - 65)) | (1 << (TRQLParser.ROLLUP - 65)) | (1 << (TRQLParser.ROW - 65)) | (1 << (TRQLParser.ROWS - 65)) | (1 << (TRQLParser.SAMPLE - 65)) | (1 << (TRQLParser.SELECT - 65)) | (1 << (TRQLParser.SEMI - 65)) | (1 << (TRQLParser.SETTINGS - 65)) | (1 << (TRQLParser.SUBSTRING - 65)) | (1 << (TRQLParser.THEN - 65)) | (1 << (TRQLParser.TIES - 65)) | (1 << (TRQLParser.TIMESTAMP - 65)) | (1 << (TRQLParser.TO - 65)) | (1 << (TRQLParser.TOP - 65)) | (1 << (TRQLParser.TOTALS - 65)) | (1 << (TRQLParser.TRAILING - 65)) | (1 << (TRQLParser.TRIM - 65)) | (1 << (TRQLParser.TRUNCATE - 65)))) !== 0) || ((((_la - 97)) & ~0x1F) === 0 && ((1 << (_la - 97)) & ((1 << (TRQLParser.UNBOUNDED - 97)) | (1 << (TRQLParser.UNION - 97)) | (1 << (TRQLParser.USING - 97)) | (1 << (TRQLParser.WHEN - 97)) | (1 << (TRQLParser.WHERE - 97)) | (1 << (TRQLParser.WINDOW - 97)) | (1 << (TRQLParser.WITH - 97)))) !== 0))) {
			this._errHandler.recoverInline(this);
			} else {
				if (this._input.LA(1) === Token.EOF) {
					this.matchedEOF = true;
				}

				this._errHandler.reportMatch(this);
				this.consume();
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public keywordForAlias(): KeywordForAliasContext {
		let _localctx: KeywordForAliasContext = new KeywordForAliasContext(this._ctx, this.state);
		this.enterRule(_localctx, 160, TRQLParser.RULE_keywordForAlias);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1283;
			_la = this._input.LA(1);
			if (!(((((_la - 20)) & ~0x1F) === 0 && ((1 << (_la - 20)) & ((1 << (TRQLParser.DATE - 20)) | (1 << (TRQLParser.FIRST - 20)) | (1 << (TRQLParser.ID - 20)) | (1 << (TRQLParser.KEY - 20)))) !== 0))) {
			this._errHandler.recoverInline(this);
			} else {
				if (this._input.LA(1) === Token.EOF) {
					this.matchedEOF = true;
				}

				this._errHandler.reportMatch(this);
				this.consume();
			}
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public alias(): AliasContext {
		let _localctx: AliasContext = new AliasContext(this._ctx, this.state);
		this.enterRule(_localctx, 162, TRQLParser.RULE_alias);
		try {
			this.state = 1287;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.IDENTIFIER:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1285;
				this.match(TRQLParser.IDENTIFIER);
				}
				break;
			case TRQLParser.DATE:
			case TRQLParser.FIRST:
			case TRQLParser.ID:
			case TRQLParser.KEY:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 1286;
				this.keywordForAlias();
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public identifier(): IdentifierContext {
		let _localctx: IdentifierContext = new IdentifierContext(this._ctx, this.state);
		this.enterRule(_localctx, 164, TRQLParser.RULE_identifier);
		try {
			this.state = 1292;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.IDENTIFIER:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1289;
				this.match(TRQLParser.IDENTIFIER);
				}
				break;
			case TRQLParser.DAY:
			case TRQLParser.HOUR:
			case TRQLParser.MINUTE:
			case TRQLParser.MONTH:
			case TRQLParser.QUARTER:
			case TRQLParser.SECOND:
			case TRQLParser.WEEK:
			case TRQLParser.YEAR:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 1290;
				this.interval();
				}
				break;
			case TRQLParser.ALL:
			case TRQLParser.AND:
			case TRQLParser.ANTI:
			case TRQLParser.ANY:
			case TRQLParser.ARRAY:
			case TRQLParser.AS:
			case TRQLParser.ASCENDING:
			case TRQLParser.ASOF:
			case TRQLParser.BETWEEN:
			case TRQLParser.BOTH:
			case TRQLParser.BY:
			case TRQLParser.CASE:
			case TRQLParser.CAST:
			case TRQLParser.COHORT:
			case TRQLParser.COLLATE:
			case TRQLParser.CROSS:
			case TRQLParser.CUBE:
			case TRQLParser.CURRENT:
			case TRQLParser.DATE:
			case TRQLParser.DESC:
			case TRQLParser.DESCENDING:
			case TRQLParser.DISTINCT:
			case TRQLParser.ELSE:
			case TRQLParser.END:
			case TRQLParser.EXTRACT:
			case TRQLParser.FINAL:
			case TRQLParser.FIRST:
			case TRQLParser.FOLLOWING:
			case TRQLParser.FOR:
			case TRQLParser.FROM:
			case TRQLParser.FULL:
			case TRQLParser.GROUP:
			case TRQLParser.HAVING:
			case TRQLParser.ID:
			case TRQLParser.IF:
			case TRQLParser.ILIKE:
			case TRQLParser.IN:
			case TRQLParser.INNER:
			case TRQLParser.INTERVAL:
			case TRQLParser.IS:
			case TRQLParser.JOIN:
			case TRQLParser.KEY:
			case TRQLParser.LAST:
			case TRQLParser.LEADING:
			case TRQLParser.LEFT:
			case TRQLParser.LIKE:
			case TRQLParser.LIMIT:
			case TRQLParser.NOT:
			case TRQLParser.NULLS:
			case TRQLParser.OFFSET:
			case TRQLParser.ON:
			case TRQLParser.OR:
			case TRQLParser.ORDER:
			case TRQLParser.OUTER:
			case TRQLParser.OVER:
			case TRQLParser.PARTITION:
			case TRQLParser.PRECEDING:
			case TRQLParser.PREWHERE:
			case TRQLParser.RANGE:
			case TRQLParser.RETURN:
			case TRQLParser.RIGHT:
			case TRQLParser.ROLLUP:
			case TRQLParser.ROW:
			case TRQLParser.ROWS:
			case TRQLParser.SAMPLE:
			case TRQLParser.SELECT:
			case TRQLParser.SEMI:
			case TRQLParser.SETTINGS:
			case TRQLParser.SUBSTRING:
			case TRQLParser.THEN:
			case TRQLParser.TIES:
			case TRQLParser.TIMESTAMP:
			case TRQLParser.TO:
			case TRQLParser.TOP:
			case TRQLParser.TOTALS:
			case TRQLParser.TRAILING:
			case TRQLParser.TRIM:
			case TRQLParser.TRUNCATE:
			case TRQLParser.UNBOUNDED:
			case TRQLParser.UNION:
			case TRQLParser.USING:
			case TRQLParser.WHEN:
			case TRQLParser.WHERE:
			case TRQLParser.WINDOW:
			case TRQLParser.WITH:
				this.enterOuterAlt(_localctx, 3);
				{
				this.state = 1291;
				this.keyword();
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public enumValue(): EnumValueContext {
		let _localctx: EnumValueContext = new EnumValueContext(this._ctx, this.state);
		this.enterRule(_localctx, 166, TRQLParser.RULE_enumValue);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1294;
			this.string();
			this.state = 1295;
			this.match(TRQLParser.EQ_SINGLE);
			this.state = 1296;
			this.numberLiteral();
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public placeholder(): PlaceholderContext {
		let _localctx: PlaceholderContext = new PlaceholderContext(this._ctx, this.state);
		this.enterRule(_localctx, 168, TRQLParser.RULE_placeholder);
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1298;
			this.match(TRQLParser.LBRACE);
			this.state = 1299;
			this.columnExpr(0);
			this.state = 1300;
			this.match(TRQLParser.RBRACE);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public string(): StringContext {
		let _localctx: StringContext = new StringContext(this._ctx, this.state);
		this.enterRule(_localctx, 170, TRQLParser.RULE_string);
		try {
			this.state = 1304;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.STRING_LITERAL:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1302;
				this.match(TRQLParser.STRING_LITERAL);
				}
				break;
			case TRQLParser.QUOTE_SINGLE_TEMPLATE:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 1303;
				this.templateString();
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public templateString(): TemplateStringContext {
		let _localctx: TemplateStringContext = new TemplateStringContext(this._ctx, this.state);
		this.enterRule(_localctx, 172, TRQLParser.RULE_templateString);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1306;
			this.match(TRQLParser.QUOTE_SINGLE_TEMPLATE);
			this.state = 1310;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			while (_la === TRQLParser.STRING_TEXT || _la === TRQLParser.STRING_ESCAPE_TRIGGER) {
				{
				{
				this.state = 1307;
				this.stringContents();
				}
				}
				this.state = 1312;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
			}
			this.state = 1313;
			this.match(TRQLParser.QUOTE_SINGLE);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public stringContents(): StringContentsContext {
		let _localctx: StringContentsContext = new StringContentsContext(this._ctx, this.state);
		this.enterRule(_localctx, 174, TRQLParser.RULE_stringContents);
		try {
			this.state = 1320;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.STRING_ESCAPE_TRIGGER:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1315;
				this.match(TRQLParser.STRING_ESCAPE_TRIGGER);
				this.state = 1316;
				this.columnExpr(0);
				this.state = 1317;
				this.match(TRQLParser.RBRACE);
				}
				break;
			case TRQLParser.STRING_TEXT:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 1319;
				this.match(TRQLParser.STRING_TEXT);
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public fullTemplateString(): FullTemplateStringContext {
		let _localctx: FullTemplateStringContext = new FullTemplateStringContext(this._ctx, this.state);
		this.enterRule(_localctx, 176, TRQLParser.RULE_fullTemplateString);
		let _la: number;
		try {
			this.enterOuterAlt(_localctx, 1);
			{
			this.state = 1322;
			this.match(TRQLParser.QUOTE_SINGLE_TEMPLATE_FULL);
			this.state = 1326;
			this._errHandler.sync(this);
			_la = this._input.LA(1);
			while (_la === TRQLParser.FULL_STRING_TEXT || _la === TRQLParser.FULL_STRING_ESCAPE_TRIGGER) {
				{
				{
				this.state = 1323;
				this.stringContentsFull();
				}
				}
				this.state = 1328;
				this._errHandler.sync(this);
				_la = this._input.LA(1);
			}
			this.state = 1329;
			this.match(TRQLParser.EOF);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}
	// @RuleVersion(0)
	public stringContentsFull(): StringContentsFullContext {
		let _localctx: StringContentsFullContext = new StringContentsFullContext(this._ctx, this.state);
		this.enterRule(_localctx, 178, TRQLParser.RULE_stringContentsFull);
		try {
			this.state = 1336;
			this._errHandler.sync(this);
			switch (this._input.LA(1)) {
			case TRQLParser.FULL_STRING_ESCAPE_TRIGGER:
				this.enterOuterAlt(_localctx, 1);
				{
				this.state = 1331;
				this.match(TRQLParser.FULL_STRING_ESCAPE_TRIGGER);
				this.state = 1332;
				this.columnExpr(0);
				this.state = 1333;
				this.match(TRQLParser.RBRACE);
				}
				break;
			case TRQLParser.FULL_STRING_TEXT:
				this.enterOuterAlt(_localctx, 2);
				{
				this.state = 1335;
				this.match(TRQLParser.FULL_STRING_TEXT);
				}
				break;
			default:
				throw new NoViableAltException(this);
			}
		}
		catch (re) {
			if (re instanceof RecognitionException) {
				_localctx.exception = re;
				this._errHandler.reportError(this, re);
				this._errHandler.recover(this, re);
			} else {
				throw re;
			}
		}
		finally {
			this.exitRule();
		}
		return _localctx;
	}

	public sempred(_localctx: RuleContext, ruleIndex: number, predIndex: number): boolean {
		switch (ruleIndex) {
		case 41:
			return this.joinExpr_sempred(_localctx as JoinExprContext, predIndex);

		case 61:
			return this.columnExpr_sempred(_localctx as ColumnExprContext, predIndex);

		case 70:
			return this.tableExpr_sempred(_localctx as TableExprContext, predIndex);
		}
		return true;
	}
	private joinExpr_sempred(_localctx: JoinExprContext, predIndex: number): boolean {
		switch (predIndex) {
		case 0:
			return this.precpred(this._ctx, 3);

		case 1:
			return this.precpred(this._ctx, 4);
		}
		return true;
	}
	private columnExpr_sempred(_localctx: ColumnExprContext, predIndex: number): boolean {
		switch (predIndex) {
		case 2:
			return this.precpred(this._ctx, 19);

		case 3:
			return this.precpred(this._ctx, 18);

		case 4:
			return this.precpred(this._ctx, 17);

		case 5:
			return this.precpred(this._ctx, 15);

		case 6:
			return this.precpred(this._ctx, 13);

		case 7:
			return this.precpred(this._ctx, 12);

		case 8:
			return this.precpred(this._ctx, 11);

		case 9:
			return this.precpred(this._ctx, 10);

		case 10:
			return this.precpred(this._ctx, 31);

		case 11:
			return this.precpred(this._ctx, 30);

		case 12:
			return this.precpred(this._ctx, 26);

		case 13:
			return this.precpred(this._ctx, 25);

		case 14:
			return this.precpred(this._ctx, 24);

		case 15:
			return this.precpred(this._ctx, 23);

		case 16:
			return this.precpred(this._ctx, 22);

		case 17:
			return this.precpred(this._ctx, 21);

		case 18:
			return this.precpred(this._ctx, 16);

		case 19:
			return this.precpred(this._ctx, 9);
		}
		return true;
	}
	private tableExpr_sempred(_localctx: TableExprContext, predIndex: number): boolean {
		switch (predIndex) {
		case 20:
			return this.precpred(this._ctx, 3);
		}
		return true;
	}

	private static readonly _serializedATNSegments: number = 3;
	private static readonly _serializedATNSegment0: string =
		"\x03\uC91D\uCABA\u058D\uAFBA\u4F53\u0607\uEA8B\uC241\x03\xAA\u053D\x04" +
		"\x02\t\x02\x04\x03\t\x03\x04\x04\t\x04\x04\x05\t\x05\x04\x06\t\x06\x04" +
		"\x07\t\x07\x04\b\t\b\x04\t\t\t\x04\n\t\n\x04\v\t\v\x04\f\t\f\x04\r\t\r" +
		"\x04\x0E\t\x0E\x04\x0F\t\x0F\x04\x10\t\x10\x04\x11\t\x11\x04\x12\t\x12" +
		"\x04\x13\t\x13\x04\x14\t\x14\x04\x15\t\x15\x04\x16\t\x16\x04\x17\t\x17" +
		"\x04\x18\t\x18\x04\x19\t\x19\x04\x1A\t\x1A\x04\x1B\t\x1B\x04\x1C\t\x1C" +
		"\x04\x1D\t\x1D\x04\x1E\t\x1E\x04\x1F\t\x1F\x04 \t \x04!\t!\x04\"\t\"\x04" +
		"#\t#\x04$\t$\x04%\t%\x04&\t&\x04\'\t\'\x04(\t(\x04)\t)\x04*\t*\x04+\t" +
		"+\x04,\t,\x04-\t-\x04.\t.\x04/\t/\x040\t0\x041\t1\x042\t2\x043\t3\x04" +
		"4\t4\x045\t5\x046\t6\x047\t7\x048\t8\x049\t9\x04:\t:\x04;\t;\x04<\t<\x04" +
		"=\t=\x04>\t>\x04?\t?\x04@\t@\x04A\tA\x04B\tB\x04C\tC\x04D\tD\x04E\tE\x04" +
		"F\tF\x04G\tG\x04H\tH\x04I\tI\x04J\tJ\x04K\tK\x04L\tL\x04M\tM\x04N\tN\x04" +
		"O\tO\x04P\tP\x04Q\tQ\x04R\tR\x04S\tS\x04T\tT\x04U\tU\x04V\tV\x04W\tW\x04" +
		"X\tX\x04Y\tY\x04Z\tZ\x04[\t[\x03\x02\x07\x02\xB8\n\x02\f\x02\x0E\x02\xBB" +
		"\v\x02\x03\x02\x03\x02\x03\x03\x03\x03\x05\x03\xC1\n\x03\x03\x04\x03\x04" +
		"\x03\x05\x03\x05\x03\x05\x03\x05\x03\x05\x05\x05\xCA\n\x05\x03\x06\x03" +
		"\x06\x03\x06\x07\x06\xCF\n\x06\f\x06\x0E\x06\xD2\v\x06\x03\x06\x05\x06" +
		"\xD5\n\x06\x03\x07\x03\x07\x03\x07\x03\x07\x03\x07\x03\x07\x03\x07\x03" +
		"\x07\x03\x07\x03\x07\x03\x07\x03\x07\x05\x07\xE3\n\x07\x03\b\x03\b\x05" +
		"\b\xE7\n\b\x03\b\x05\b\xEA\n\b\x03\t\x03\t\x05\t\xEE\n\t\x03\t\x05\t\xF1" +
		"\n\t\x03\n\x03\n\x03\n\x03\n\x03\n\x05\n\xF8\n\n\x03\n\x03\n\x05\n\xFC" +
		"\n\n\x03\n\x03\n\x03\v\x03\v\x03\v\x07\v\u0103\n\v\f\v\x0E\v\u0106\v\v" +
		"\x03\v\x03\v\x05\v\u010A\n\v\x03\f\x03\f\x03\f\x03\f\x03\f\x03\f\x03\f" +
		"\x05\f\u0113\n\f\x03\r\x03\r\x03\r\x03\r\x03\r\x03\r\x05\r\u011B\n\r\x03" +
		"\x0E\x03\x0E\x03\x0E\x03\x0E\x03\x0E\x05\x0E\u0122\n\x0E\x03\x0E\x03\x0E" +
		"\x05\x0E\u0126\n\x0E\x03\x0E\x03\x0E\x03\x0E\x03\x0E\x05\x0E\u012C\n\x0E" +
		"\x03\x0E\x03\x0E\x03\x0E\x05\x0E\u0131\n\x0E\x03\x0F\x03\x0F\x03\x0F\x03" +
		"\x0F\x03\x0F\x03\x0F\x05\x0F\u0139\n\x0F\x03\x0F\x03\x0F\x03\x0F\x03\x0F" +
		"\x03\x0F\x05\x0F\u0140\n\x0F\x03\x10\x03\x10\x03\x10\x03\x10\x05\x10\u0146" +
		"\n\x10\x03\x10\x03\x10\x03\x10\x03\x11\x03\x11\x03\x11\x03\x11\x03\x11" +
		"\x03\x12\x03\x12\x05\x12\u0152\n\x12\x03\x13\x03\x13\x03\x14\x03\x14\x07" +
		"\x14\u0158\n\x14\f\x14\x0E\x14\u015B\v\x14\x03\x14\x03\x14\x03\x15\x03" +
		"\x15\x03\x15\x03\x15\x03\x16\x03\x16\x03\x16\x07\x16\u0166\n\x16\f\x16" +
		"\x0E\x16\u0169\v\x16\x03\x16\x05\x16\u016C\n\x16\x03\x17\x03\x17\x03\x17" +
		"\x05\x17\u0171\n\x17\x03\x17\x05\x17\u0174\n\x17\x03\x17\x03\x17\x03\x18" +
		"\x03\x18\x03\x18\x03\x18\x03\x18\x03\x18\x05\x18\u017E\n\x18\x03\x19\x03" +
		"\x19\x03\x19\x03\x19\x03\x19\x03\x19\x03\x19\x03\x19\x05\x19\u0188\n\x19" +
		"\x03\x19\x03\x19\x03\x1A\x03\x1A\x07\x1A\u018E\n\x1A\f\x1A\x0E\x1A\u0191" +
		"\v\x1A\x03\x1B\x05\x1B\u0194\n\x1B\x03\x1B\x03\x1B\x05\x1B\u0198\n\x1B" +
		"\x03\x1B\x05\x1B\u019B\n\x1B\x03\x1B\x03\x1B\x05\x1B\u019F\n\x1B\x03\x1B" +
		"\x05\x1B\u01A2\n\x1B\x03\x1B\x05\x1B\u01A5\n\x1B\x03\x1B\x05\x1B\u01A8" +
		"\n\x1B\x03\x1B\x05\x1B\u01AB\n\x1B\x03\x1B\x03\x1B\x05\x1B\u01AF\n\x1B" +
		"\x03\x1B\x03\x1B\x05\x1B\u01B3\n\x1B\x03\x1B\x05\x1B\u01B6\n\x1B\x03\x1B" +
		"\x05\x1B\u01B9\n\x1B\x03\x1B\x05\x1B\u01BC\n\x1B\x03\x1B\x05\x1B\u01BF" +
		"\n\x1B\x03\x1B\x03\x1B\x05\x1B\u01C3\n\x1B\x03\x1B\x05\x1B\u01C6\n\x1B" +
		"\x03\x1C\x03\x1C\x03\x1C\x03\x1D\x03\x1D\x03\x1D\x03\x1D\x05\x1D\u01CF" +
		"\n\x1D\x03\x1E\x03\x1E\x03\x1E\x03\x1F\x05\x1F\u01D5\n\x1F\x03\x1F\x03" +
		"\x1F\x03\x1F\x03\x1F\x03 \x03 \x03 \x03 \x03 \x03 \x03 \x03 \x03 \x03" +
		" \x03 \x03 \x03 \x07 \u01E8\n \f \x0E \u01EB\v \x03!\x03!\x03!\x03\"\x03" +
		"\"\x03\"\x03#\x03#\x03#\x03#\x03#\x03#\x03#\x03#\x05#\u01FB\n#\x03$\x03" +
		"$\x03$\x03%\x03%\x03%\x03%\x03&\x03&\x03&\x03&\x03\'\x03\'\x03\'\x03\'" +
		"\x03\'\x03(\x03(\x03(\x03(\x05(\u0211\n(\x03(\x03(\x05(\u0215\n(\x03(" +
		"\x03(\x03(\x03(\x05(\u021B\n(\x03(\x03(\x03(\x05(\u0220\n(\x03)\x03)\x03" +
		")\x03*\x03*\x03*\x03+\x03+\x03+\x05+\u022B\n+\x03+\x05+\u022E\n+\x03+" +
		"\x03+\x03+\x03+\x05+\u0234\n+\x03+\x03+\x03+\x03+\x03+\x03+\x05+\u023C" +
		"\n+\x03+\x03+\x03+\x03+\x07+\u0242\n+\f+\x0E+\u0245\v+\x03,\x05,\u0248" +
		"\n,\x03,\x03,\x03,\x05,\u024D\n,\x03,\x05,\u0250\n,\x03,\x05,\u0253\n" +
		",\x03,\x03,\x05,\u0257\n,\x03,\x03,\x05,\u025B\n,\x03,\x05,\u025E\n,\x05" +
		",\u0260\n,\x03,\x05,\u0263\n,\x03,\x03,\x05,\u0267\n,\x03,\x03,\x05,\u026B" +
		"\n,\x03,\x05,\u026E\n,\x05,\u0270\n,\x05,\u0272\n,\x03-\x03-\x03-\x05" +
		"-\u0277\n-\x03.\x03.\x03.\x03.\x03.\x03.\x03.\x03.\x03.\x05.\u0282\n." +
		"\x03/\x03/\x03/\x03/\x05/\u0288\n/\x030\x030\x030\x050\u028D\n0\x031\x03" +
		"1\x031\x071\u0292\n1\f1\x0E1\u0295\v1\x032\x032\x052\u0299\n2\x032\x03" +
		"2\x052\u029D\n2\x032\x032\x052\u02A1\n2\x033\x033\x033\x033\x053\u02A7" +
		"\n3\x053\u02A9\n3\x034\x034\x034\x074\u02AE\n4\f4\x0E4\u02B1\v4\x035\x03" +
		"5\x035\x035\x036\x056\u02B8\n6\x036\x056\u02BB\n6\x036\x056\u02BE\n6\x03" +
		"7\x037\x037\x037\x038\x038\x038\x038\x039\x039\x039\x03:\x03:\x03:\x03" +
		":\x03:\x03:\x05:\u02D1\n:\x03;\x03;\x03;\x03;\x03;\x03;\x03;\x03;\x03" +
		";\x03;\x03;\x03;\x05;\u02DF\n;\x03<\x03<\x03<\x03=\x03=\x03=\x03=\x03" +
		"=\x03=\x03=\x03=\x03=\x07=\u02ED\n=\f=\x0E=\u02F0\v=\x03=\x05=\u02F3\n" +
		"=\x03=\x03=\x03=\x03=\x03=\x03=\x03=\x07=\u02FC\n=\f=\x0E=\u02FF\v=\x03" +
		"=\x05=\u0302\n=\x03=\x03=\x03=\x03=\x03=\x03=\x03=\x07=\u030B\n=\f=\x0E" +
		"=\u030E\v=\x03=\x05=\u0311\n=\x03=\x03=\x03=\x03=\x03=\x05=\u0318\n=\x03" +
		"=\x03=\x05=\u031C\n=\x03>\x03>\x03>\x07>\u0321\n>\f>\x0E>\u0324\v>\x03" +
		">\x05>\u0327\n>\x03?\x03?\x03?\x05?\u032C\n?\x03?\x03?\x03?\x03?\x03?" +
		"\x06?\u0333\n?\r?\x0E?\u0334\x03?\x03?\x05?\u0339\n?\x03?\x03?\x03?\x03" +
		"?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03" +
		"?\x03?\x03?\x03?\x03?\x03?\x03?\x05?\u0353\n?\x03?\x03?\x03?\x03?\x03" +
		"?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x05?\u0364\n?\x03" +
		"?\x03?\x03?\x03?\x05?\u036A\n?\x03?\x05?\u036D\n?\x03?\x05?\u0370\n?\x03" +
		"?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x05?\u037A\n?\x03?\x03?\x03?\x03" +
		"?\x05?\u0380\n?\x03?\x05?\u0383\n?\x03?\x05?\u0386\n?\x03?\x03?\x03?\x03" +
		"?\x03?\x03?\x05?\u038E\n?\x03?\x05?\u0391\n?\x03?\x03?\x05?\u0395\n?\x03" +
		"?\x05?\u0398\n?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03" +
		"?\x03?\x05?\u03A6\n?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03" +
		"?\x03?\x03?\x03?\x03?\x03?\x05?\u03B7\n?\x03?\x03?\x03?\x05?\u03BC\n?" +
		"\x03?\x03?\x03?\x05?\u03C1\n?\x03?\x03?\x03?\x03?\x05?\u03C7\n?\x03?\x03" +
		"?\x03?\x03?\x03?\x05?\u03CE\n?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03" +
		"?\x03?\x03?\x05?\u03DA\n?\x03?\x03?\x05?\u03DE\n?\x03?\x05?\u03E1\n?\x03" +
		"?\x03?\x03?\x03?\x03?\x03?\x03?\x05?\u03EA\n?\x03?\x03?\x03?\x03?\x03" +
		"?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x05?\u03F8\n?\x03?\x03?\x03?\x03" +
		"?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03" +
		"?\x03?\x05?\u040D\n?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03" +
		"?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03?\x03" +
		"?\x03?\x03?\x03?\x05?\u042A\n?\x03?\x03?\x03?\x03?\x03?\x03?\x05?\u0432" +
		"\n?\x07?\u0434\n?\f?\x0E?\u0437\v?\x03@\x03@\x03@\x03@\x07@\u043D\n@\f" +
		"@\x0E@\u0440\v@\x03@\x05@\u0443\n@\x03@\x03@\x03@\x03@\x03@\x07@\u044A" +
		"\n@\f@\x0E@\u044D\v@\x03@\x05@\u0450\n@\x03@\x03@\x05@\u0454\n@\x03@\x03" +
		"@\x03@\x05@\u0459\n@\x03A\x03A\x03A\x03A\x03A\x03A\x05A\u0461\nA\x03B" +
		"\x03B\x03B\x07B\u0466\nB\fB\x0EB\u0469\vB\x03B\x03B\x03B\x03B\x03B\x07" +
		"B\u0470\nB\fB\x0EB\u0473\vB\x03B\x03B\x07B\u0477\nB\fB\x0EB\u047A\vB\x03" +
		"B\x03B\x03B\x03B\x05B\u0480\nB\x03C\x03C\x03C\x03C\x03C\x03C\x03C\x03" +
		"C\x03C\x03C\x03C\x05C\u048D\nC\x03D\x03D\x03D\x07D\u0492\nD\fD\x0ED\u0495" +
		"\vD\x03D\x05D\u0498\nD\x03E\x03E\x03E\x03E\x03E\x03E\x03E\x03E\x03E\x03" +
		"E\x05E\u04A4\nE\x03F\x03F\x03F\x03F\x05F\u04AA\nF\x03F\x05F\u04AD\nF\x03" +
		"G\x03G\x03G\x07G\u04B2\nG\fG\x0EG\u04B5\vG\x03H\x03H\x03H\x03H\x03H\x03" +
		"H\x03H\x03H\x03H\x05H\u04C0\nH\x03H\x03H\x03H\x03H\x05H\u04C6\nH\x07H" +
		"\u04C8\nH\fH\x0EH\u04CB\vH\x03I\x03I\x03I\x05I\u04D0\nI\x03I\x03I\x03" +
		"J\x03J\x03J\x05J\u04D7\nJ\x03J\x03J\x03K\x03K\x03K\x07K\u04DE\nK\fK\x0E" +
		"K\u04E1\vK\x03K\x05K\u04E4\nK\x03L\x03L\x03M\x03M\x03M\x03M\x03M\x03M" +
		"\x05M\u04EE\nM\x05M\u04F0\nM\x03N\x05N\u04F3\nN\x03N\x03N\x03N\x03N\x03" +
		"N\x03N\x05N\u04FB\nN\x03O\x03O\x03O\x05O\u0500\nO\x03P\x03P\x03Q\x03Q" +
		"\x03R\x03R\x03S\x03S\x05S\u050A\nS\x03T\x03T\x03T\x05T\u050F\nT\x03U\x03" +
		"U\x03U\x03U\x03V\x03V\x03V\x03V\x03W\x03W\x05W\u051B\nW\x03X\x03X\x07" +
		"X\u051F\nX\fX\x0EX\u0522\vX\x03X\x03X\x03Y\x03Y\x03Y\x03Y\x03Y\x05Y\u052B" +
		"\nY\x03Z\x03Z\x07Z\u052F\nZ\fZ\x0EZ\u0532\vZ\x03Z\x03Z\x03[\x03[\x03[" +
		"\x03[\x03[\x05[\u053B\n[\x03[\x02\x02\x05T|\x8E\\\x02\x02\x04\x02\x06" +
		"\x02\b\x02\n\x02\f\x02\x0E\x02\x10\x02\x12\x02\x14\x02\x16\x02\x18\x02" +
		"\x1A\x02\x1C\x02\x1E\x02 \x02\"\x02$\x02&\x02(\x02*\x02,\x02.\x020\x02" +
		"2\x024\x026\x028\x02:\x02<\x02>\x02@\x02B\x02D\x02F\x02H\x02J\x02L\x02" +
		"N\x02P\x02R\x02T\x02V\x02X\x02Z\x02\\\x02^\x02`\x02b\x02d\x02f\x02h\x02" +
		"j\x02l\x02n\x02p\x02r\x02t\x02v\x02x\x02z\x02|\x02~\x02\x80\x02\x82\x02" +
		"\x84\x02\x86\x02\x88\x02\x8A\x02\x8C\x02\x8E\x02\x90\x02\x92\x02\x94\x02" +
		"\x96\x02\x98\x02\x9A\x02\x9C\x02\x9E\x02\xA0\x02\xA2\x02\xA4\x02\xA6\x02" +
		"\xA8\x02\xAA\x02\xAC\x02\xAE\x02\xB0\x02\xB2\x02\xB4\x02\x02\x14\x04\x02" +
		"\"\"\'\'\x04\x02\x14\x14OO\x04\x020088\x05\x02\x03\x03\x06\x06\n\n\x06" +
		"\x02\x03\x03\x05\x06\n\nUU\x04\x0288NN\x04\x02\x03\x03\x06\x06\x04\x02" +
		"BByy\x04\x02\t\t\x18\x19\x04\x02!!66\x04\x02LLQQ\x05\x02\f\f77__\x04\x02" +
		"--::\x03\x02pq\x04\x02{{\x91\x91\t\x02\x17\x17**<=KKSSffll\x15\x02\x03" +
		"\x0F\x11\x16\x18\x1C\x1E\x1F!!#&()+.0028:;??AJLRTXZaceghjk\x06\x02\x16" +
		"\x16!!++55\x02\u05EC\x02\xB9\x03\x02\x02\x02\x04\xC0\x03\x02\x02\x02\x06" +
		"\xC2\x03\x02\x02\x02\b\xC4\x03\x02\x02\x02\n\xCB\x03\x02\x02\x02\f\xE2" +
		"\x03\x02\x02\x02\x0E\xE4\x03\x02\x02\x02\x10\xEB\x03\x02\x02\x02\x12\xF2" +
		"\x03\x02\x02\x02\x14\xFF\x03\x02\x02\x02\x16\u010B\x03\x02\x02\x02\x18" +
		"\u0114\x03\x02\x02\x02\x1A\u011C\x03\x02\x02\x02\x1C\u0132\x03\x02\x02" +
		"\x02\x1E\u0141\x03\x02\x02\x02 \u014A\x03\x02\x02\x02\"\u014F\x03\x02" +
		"\x02\x02$\u0153\x03\x02\x02\x02&\u0155\x03\x02\x02\x02(\u015E\x03\x02" +
		"\x02\x02*\u0162\x03\x02\x02\x02,\u0170\x03\x02\x02\x02.\u017D\x03\x02" +
		"\x02\x020\u0187\x03\x02\x02\x022\u018B\x03\x02\x02\x024\u0193\x03\x02" +
		"\x02\x026\u01C7\x03\x02\x02\x028\u01CA\x03\x02\x02\x02:\u01D0\x03\x02" +
		"\x02\x02<\u01D4\x03\x02\x02\x02>\u01DA\x03\x02\x02\x02@\u01EC\x03\x02" +
		"\x02\x02B\u01EF\x03\x02\x02\x02D\u01F2\x03\x02\x02\x02F\u01FC\x03\x02" +
		"\x02\x02H\u01FF\x03\x02\x02\x02J\u0203\x03\x02\x02\x02L\u0207\x03\x02" +
		"\x02\x02N\u021F\x03\x02\x02\x02P\u0221\x03\x02\x02\x02R\u0224\x03\x02" +
		"\x02\x02T\u0233\x03\x02\x02\x02V\u0271\x03\x02\x02\x02X\u0276\x03\x02" +
		"\x02\x02Z\u0281\x03\x02\x02\x02\\\u0283\x03\x02\x02\x02^\u0289\x03\x02" +
		"\x02\x02`\u028E\x03\x02\x02\x02b\u0296\x03\x02\x02\x02d\u02A8\x03\x02" +
		"\x02\x02f\u02AA\x03\x02\x02\x02h\u02B2\x03\x02\x02\x02j\u02B7\x03\x02" +
		"\x02\x02l\u02BF\x03\x02\x02\x02n\u02C3\x03\x02\x02\x02p\u02C7\x03\x02" +
		"\x02\x02r\u02D0\x03\x02\x02\x02t\u02DE\x03\x02\x02\x02v\u02E0\x03\x02" +
		"\x02\x02x\u031B\x03\x02\x02\x02z\u031D\x03\x02\x02\x02|\u03C0\x03\x02" +
		"\x02\x02~\u0453\x03\x02\x02\x02\x80\u0460\x03\x02\x02\x02\x82\u047F\x03" +
		"\x02\x02\x02\x84\u048C\x03\x02\x02\x02\x86\u048E\x03\x02\x02\x02\x88\u04A3" +
		"\x03\x02\x02\x02\x8A\u04AC\x03\x02\x02\x02\x8C\u04AE\x03\x02\x02\x02\x8E" +
		"\u04BF\x03\x02\x02\x02\x90\u04CC\x03\x02\x02\x02\x92\u04D6\x03\x02\x02" +
		"\x02\x94\u04DA\x03\x02\x02\x02\x96\u04E5\x03\x02\x02\x02\x98\u04EF\x03" +
		"\x02\x02\x02\x9A\u04F2\x03\x02\x02\x02\x9C\u04FF\x03\x02\x02\x02\x9E\u0501" +
		"\x03\x02\x02\x02\xA0\u0503\x03\x02\x02\x02\xA2\u0505\x03\x02\x02\x02\xA4" +
		"\u0509\x03\x02\x02\x02\xA6\u050E\x03\x02\x02\x02\xA8\u0510\x03\x02\x02" +
		"\x02\xAA\u0514\x03\x02\x02\x02\xAC\u051A\x03\x02\x02\x02\xAE\u051C\x03" +
		"\x02\x02\x02\xB0\u052A\x03\x02\x02\x02\xB2\u052C\x03\x02\x02\x02\xB4\u053A" +
		"\x03\x02\x02\x02\xB6\xB8\x05\x04\x03\x02\xB7\xB6\x03\x02\x02\x02\xB8\xBB" +
		"\x03\x02\x02\x02\xB9\xB7\x03\x02\x02\x02\xB9\xBA\x03\x02\x02\x02\xBA\xBC" +
		"\x03\x02\x02\x02\xBB\xB9\x03\x02\x02\x02\xBC\xBD\x07\x02\x02\x03\xBD\x03" +
		"\x03\x02\x02\x02\xBE\xC1\x05\b\x05\x02\xBF\xC1\x05\f\x07\x02\xC0\xBE\x03" +
		"\x02\x02\x02\xC0\xBF\x03\x02\x02\x02\xC1\x05\x03\x02\x02\x02\xC2\xC3\x05" +
		"|?\x02\xC3\x07\x03\x02\x02\x02\xC4\xC5\x079\x02\x02\xC5\xC9\x05\xA6T\x02" +
		"\xC6\xC7\x07x\x02\x02\xC7\xC8\x07\x7F\x02\x02\xC8\xCA\x05\x06\x04\x02" +
		"\xC9\xC6\x03\x02\x02\x02\xC9\xCA\x03\x02\x02\x02\xCA\t\x03\x02\x02\x02" +
		"\xCB\xD0\x05\xA6T\x02\xCC\xCD\x07y\x02\x02\xCD\xCF\x05\xA6T\x02\xCE\xCC" +
		"\x03\x02\x02\x02\xCF\xD2\x03\x02\x02\x02\xD0\xCE\x03\x02\x02\x02\xD0\xD1" +
		"\x03\x02\x02\x02\xD1\xD4\x03\x02\x02\x02\xD2\xD0\x03\x02\x02\x02\xD3\xD5" +
		"\x07y\x02\x02\xD4\xD3\x03\x02\x02\x02\xD4\xD5\x03\x02\x02\x02\xD5\v\x03" +
		"\x02\x02\x02\xD6\xE3\x05\x0E\b\x02\xD7\xE3\x05\x10\t\x02\xD8\xE3\x05\x14" +
		"\v\x02\xD9\xE3\x05\x16\f\x02\xDA\xE3\x05\x18\r\x02\xDB\xE3\x05\x1C\x0F" +
		"\x02\xDC\xE3\x05\x1A\x0E\x02\xDD\xE3\x05\x1E\x10\x02\xDE\xE3\x05 \x11" +
		"\x02\xDF\xE3\x05&\x14\x02\xE0\xE3\x05\"\x12\x02\xE1\xE3\x05$\x13\x02\xE2" +
		"\xD6\x03\x02\x02\x02\xE2\xD7\x03\x02\x02\x02\xE2\xD8\x03\x02\x02\x02\xE2" +
		"\xD9\x03\x02\x02\x02\xE2\xDA\x03\x02\x02\x02\xE2\xDB\x03\x02\x02\x02\xE2" +
		"\xDC\x03\x02\x02\x02\xE2\xDD\x03\x02\x02\x02\xE2\xDE\x03\x02\x02\x02\xE2" +
		"\xDF\x03\x02\x02\x02\xE2\xE0\x03\x02\x02\x02\xE2\xE1\x03\x02\x02\x02\xE3" +
		"\r\x03\x02\x02\x02\xE4\xE6\x07M\x02\x02\xE5\xE7\x05\x06\x04\x02\xE6\xE5" +
		"\x03\x02\x02\x02\xE6\xE7\x03\x02\x02\x02\xE7\xE9\x03\x02\x02\x02\xE8\xEA" +
		"\x07\x9C\x02\x02\xE9\xE8\x03\x02\x02\x02\xE9\xEA\x03\x02\x02\x02\xEA\x0F" +
		"\x03\x02\x02\x02\xEB\xED\x07Y\x02\x02\xEC\xEE\x05\x06\x04\x02\xED\xEC" +
		"\x03\x02\x02\x02\xED\xEE\x03\x02\x02\x02\xEE\xF0\x03\x02\x02\x02\xEF\xF1" +
		"\x07\x9C\x02\x02\xF0\xEF\x03\x02\x02\x02\xF0\xF1\x03\x02\x02\x02\xF1\x11" +
		"\x03\x02\x02\x02\xF2\xFB\x07\x10\x02\x02\xF3\xF4\x07\x87\x02\x02\xF4\xF7" +
		"\x05\xA6T\x02\xF5\xF6\x07x\x02\x02\xF6\xF8\x05\xA6T\x02\xF7\xF5\x03\x02" +
		"\x02\x02\xF7\xF8\x03\x02\x02\x02\xF8\xF9\x03\x02\x02\x02\xF9\xFA\x07\x9B" +
		"\x02\x02\xFA\xFC\x03\x02\x02\x02\xFB\xF3\x03\x02\x02\x02\xFB\xFC\x03\x02" +
		"\x02\x02\xFC\xFD\x03\x02\x02\x02\xFD\xFE\x05&\x14\x02\xFE\x13\x03\x02" +
		"\x02\x02\xFF\u0100\x07b\x02\x02\u0100\u0104\x05&\x14\x02\u0101\u0103\x05" +
		"\x12\n\x02\u0102\u0101\x03\x02\x02\x02\u0103\u0106\x03\x02\x02\x02\u0104" +
		"\u0102\x03\x02\x02\x02\u0104\u0105\x03\x02\x02\x02\u0105\u0109\x03\x02" +
		"\x02\x02\u0106\u0104\x03\x02\x02\x02\u0107\u0108\x07 \x02\x02\u0108\u010A" +
		"\x05&\x14\x02\u0109\u0107\x03\x02\x02\x02\u0109\u010A\x03\x02\x02\x02" +
		"\u010A\x15\x03\x02\x02\x02\u010B\u010C\x07,\x02\x02\u010C\u010D\x07\x87" +
		"\x02\x02\u010D\u010E\x05\x06\x04\x02\u010E\u010F\x07\x9B\x02\x02\u010F" +
		"\u0112\x05\f\x07\x02\u0110\u0111\x07\x1B\x02\x02\u0111\u0113\x05\f\x07" +
		"\x02\u0112\u0110\x03\x02\x02\x02\u0112\u0113\x03\x02\x02\x02\u0113\x17" +
		"\x03\x02\x02\x02\u0114\u0115\x07i\x02\x02\u0115\u0116\x07\x87\x02\x02" +
		"\u0116\u0117\x05\x06\x04\x02\u0117\u0118\x07\x9B\x02\x02\u0118\u011A\x05" +
		"\f\x07\x02\u0119\u011B\x07\x9C\x02\x02\u011A\u0119\x03\x02\x02\x02\u011A" +
		"\u011B\x03\x02\x02\x02\u011B\x19\x03\x02\x02\x02\u011C\u011D\x07$\x02" +
		"\x02\u011D\u0121\x07\x87\x02\x02\u011E\u0122\x05\b\x05\x02\u011F\u0122" +
		"\x05 \x11\x02\u0120\u0122\x05\x06\x04\x02\u0121\u011E\x03\x02\x02\x02" +
		"\u0121\u011F\x03\x02\x02\x02\u0121\u0120\x03\x02\x02\x02\u0121\u0122\x03" +
		"\x02\x02\x02\u0122\u0123\x03\x02\x02\x02\u0123\u0125\x07\x9C\x02\x02\u0124" +
		"\u0126\x05\x06\x04\x02\u0125\u0124\x03\x02\x02\x02\u0125\u0126\x03\x02" +
		"\x02\x02\u0126\u0127\x03\x02\x02\x02\u0127\u012B\x07\x9C\x02\x02\u0128" +
		"\u012C\x05\b\x05\x02\u0129\u012C\x05 \x11\x02\u012A\u012C\x05\x06\x04" +
		"\x02\u012B\u0128\x03\x02\x02\x02\u012B\u0129\x03\x02\x02\x02\u012B\u012A" +
		"\x03\x02\x02\x02\u012B\u012C\x03\x02\x02\x02\u012C\u012D\x03\x02\x02\x02" +
		"\u012D\u012E\x07\x9B\x02\x02\u012E\u0130\x05\f\x07\x02\u012F\u0131\x07" +
		"\x9C\x02\x02\u0130\u012F\x03\x02\x02\x02\u0130\u0131\x03\x02\x02\x02\u0131" +
		"\x1B\x03\x02\x02\x02\u0132\u0133\x07$\x02\x02\u0133\u0134\x07\x87\x02" +
		"\x02\u0134\u0135\x079\x02\x02\u0135\u0138\x05\xA6T\x02\u0136\u0137\x07" +
		"y\x02\x02\u0137\u0139\x05\xA6T\x02\u0138\u0136\x03\x02\x02\x02\u0138\u0139" +
		"\x03\x02\x02\x02\u0139\u013A\x03\x02\x02\x02\u013A\u013B\x07.\x02\x02" +
		"\u013B\u013C\x05\x06\x04\x02\u013C\u013D\x07\x9B\x02\x02\u013D\u013F\x05" +
		"\f\x07\x02\u013E\u0140\x07\x9C\x02\x02\u013F\u013E\x03\x02\x02\x02\u013F" +
		"\u0140\x03\x02\x02\x02\u0140\x1D\x03\x02\x02\x02\u0141\u0142\t\x02\x02" +
		"\x02\u0142\u0143\x05\xA6T\x02\u0143\u0145\x07\x87\x02\x02\u0144\u0146" +
		"\x05\n\x06\x02\u0145\u0144\x03\x02\x02\x02\u0145\u0146\x03\x02\x02\x02" +
		"\u0146\u0147\x03\x02\x02\x02\u0147\u0148\x07\x9B\x02\x02\u0148\u0149\x05" +
		"&\x14\x02\u0149\x1F\x03\x02\x02\x02\u014A\u014B\x05\x06\x04\x02\u014B" +
		"\u014C\x07x\x02\x02\u014C\u014D\x07\x7F\x02\x02\u014D\u014E\x05\x06\x04" +
		"\x02\u014E!\x03\x02\x02\x02\u014F\u0151\x05\x06\x04\x02\u0150\u0152\x07" +
		"\x9C\x02\x02\u0151\u0150\x03\x02\x02\x02\u0151\u0152\x03\x02\x02\x02\u0152" +
		"#\x03\x02\x02\x02\u0153\u0154\x07\x9C\x02\x02\u0154%\x03\x02\x02\x02\u0155" +
		"\u0159\x07\x85\x02\x02\u0156\u0158\x05\x04\x03\x02\u0157\u0156\x03\x02" +
		"\x02\x02\u0158\u015B\x03\x02\x02\x02\u0159\u0157\x03\x02\x02\x02\u0159" +
		"\u015A\x03\x02\x02\x02\u015A\u015C\x03";
	private static readonly _serializedATNSegment1: string =
		"\x02\x02\x02\u015B\u0159\x03\x02\x02\x02\u015C\u015D\x07\x99\x02\x02\u015D" +
		"\'\x03\x02\x02\x02\u015E\u015F\x05\x06\x04\x02\u015F\u0160\x07x\x02\x02" +
		"\u0160\u0161\x05\x06\x04\x02\u0161)\x03\x02\x02\x02\u0162\u0167\x05(\x15" +
		"\x02\u0163\u0164\x07y\x02\x02\u0164\u0166\x05(\x15\x02\u0165\u0163\x03" +
		"\x02\x02\x02\u0166\u0169\x03\x02\x02\x02\u0167\u0165\x03\x02\x02\x02\u0167" +
		"\u0168\x03\x02\x02\x02\u0168\u016B\x03\x02\x02\x02\u0169\u0167\x03\x02" +
		"\x02\x02\u016A\u016C\x07y\x02\x02\u016B\u016A\x03\x02\x02\x02\u016B\u016C" +
		"\x03\x02\x02\x02\u016C+\x03\x02\x02\x02\u016D\u0171\x052\x1A\x02\u016E" +
		"\u0171\x054\x1B\x02\u016F\u0171\x05\x82B\x02\u0170\u016D\x03\x02\x02\x02" +
		"\u0170\u016E\x03\x02\x02\x02\u0170\u016F\x03\x02\x02\x02\u0171\u0173\x03" +
		"\x02\x02\x02\u0172\u0174\x07\x9C\x02\x02\u0173\u0172\x03\x02\x02\x02\u0173" +
		"\u0174\x03\x02\x02\x02\u0174\u0175\x03\x02\x02\x02\u0175\u0176\x07\x02" +
		"\x02\x03\u0176-\x03\x02\x02\x02\u0177\u017E\x054\x1B\x02\u0178\u0179\x07" +
		"\x87\x02\x02\u0179\u017A\x052\x1A\x02\u017A\u017B\x07\x9B\x02\x02\u017B" +
		"\u017E\x03\x02\x02\x02\u017C\u017E\x05\xAAV\x02\u017D\u0177\x03\x02\x02" +
		"\x02\u017D\u0178\x03\x02\x02\x02\u017D\u017C\x03\x02\x02\x02\u017E/\x03" +
		"\x02\x02\x02\u017F\u0188\x07\x1D\x02\x02\u0180\u0181\x07d\x02\x02\u0181" +
		"\u0188\x07\x03\x02\x02\u0182\u0183\x07d\x02\x02\u0183\u0188\x07\x1A\x02" +
		"\x02\u0184\u0188\x071\x02\x02\u0185\u0186\x071\x02\x02\u0186\u0188\x07" +
		"\x1A\x02\x02\u0187\u017F\x03\x02\x02\x02\u0187\u0180\x03\x02\x02\x02\u0187" +
		"\u0182\x03\x02\x02\x02\u0187\u0184\x03\x02\x02\x02\u0187\u0185\x03\x02" +
		"\x02\x02\u0188\u0189\x03\x02\x02\x02\u0189\u018A\x05.\x18\x02\u018A1\x03" +
		"\x02\x02\x02\u018B\u018F\x05.\x18\x02\u018C\u018E\x050\x19\x02\u018D\u018C" +
		"\x03\x02\x02\x02\u018E\u0191\x03\x02\x02\x02\u018F\u018D\x03\x02\x02\x02" +
		"\u018F\u0190\x03\x02\x02\x02\u01903\x03\x02\x02\x02\u0191\u018F\x03\x02" +
		"\x02\x02\u0192\u0194\x056\x1C\x02\u0193\u0192\x03\x02\x02\x02\u0193\u0194" +
		"\x03\x02\x02\x02\u0194\u0195\x03\x02\x02\x02\u0195\u0197\x07T\x02\x02" +
		"\u0196\u0198\x07\x1A\x02\x02\u0197\u0196\x03\x02\x02\x02\u0197\u0198\x03" +
		"\x02\x02\x02\u0198\u019A\x03\x02\x02\x02\u0199\u019B\x058\x1D\x02\u019A" +
		"\u0199\x03\x02\x02\x02\u019A\u019B\x03\x02\x02\x02\u019B\u019C\x03\x02" +
		"\x02\x02\u019C\u019E\x05z>\x02\u019D\u019F\x05:\x1E\x02\u019E\u019D\x03" +
		"\x02\x02\x02\u019E\u019F\x03\x02\x02\x02\u019F\u01A1\x03\x02\x02\x02\u01A0" +
		"\u01A2\x05<\x1F\x02\u01A1\u01A0\x03\x02\x02\x02\u01A1\u01A2\x03\x02\x02" +
		"\x02\u01A2\u01A4\x03\x02\x02\x02\u01A3\u01A5\x05@!\x02\u01A4\u01A3\x03" +
		"\x02\x02\x02\u01A4\u01A5\x03\x02\x02\x02\u01A5\u01A7\x03\x02\x02\x02\u01A6" +
		"\u01A8\x05B\"\x02\u01A7\u01A6\x03\x02\x02\x02\u01A7\u01A8\x03\x02\x02" +
		"\x02\u01A8\u01AA\x03\x02\x02\x02\u01A9\u01AB\x05D#\x02\u01AA\u01A9\x03" +
		"\x02\x02\x02\u01AA\u01AB\x03\x02\x02\x02\u01AB\u01AE\x03\x02\x02\x02\u01AC" +
		"\u01AD\x07k\x02\x02\u01AD\u01AF\t\x03\x02\x02\u01AE\u01AC\x03\x02\x02" +
		"\x02\u01AE\u01AF\x03\x02\x02\x02\u01AF\u01B2\x03\x02\x02\x02\u01B0\u01B1" +
		"\x07k\x02\x02\u01B1\u01B3\x07^\x02\x02\u01B2\u01B0\x03\x02\x02\x02\u01B2" +
		"\u01B3\x03\x02\x02\x02\u01B3\u01B5\x03\x02\x02\x02\u01B4\u01B6\x05F$\x02" +
		"\u01B5\u01B4\x03\x02\x02\x02\u01B5\u01B6\x03\x02\x02\x02\u01B6\u01B8\x03" +
		"\x02\x02\x02\u01B7\u01B9\x05> \x02\u01B8\u01B7\x03\x02\x02\x02\u01B8\u01B9" +
		"\x03\x02\x02\x02\u01B9\u01BB\x03\x02\x02\x02\u01BA\u01BC\x05H%\x02\u01BB" +
		"\u01BA\x03\x02\x02\x02\u01BB\u01BC\x03\x02\x02\x02\u01BC\u01BE\x03\x02" +
		"\x02\x02\u01BD\u01BF\x05L\'\x02\u01BE\u01BD\x03\x02\x02\x02\u01BE\u01BF" +
		"\x03\x02\x02\x02\u01BF\u01C2\x03\x02\x02\x02\u01C0\u01C3\x05N(\x02\u01C1" +
		"\u01C3\x05P)\x02\u01C2\u01C0\x03\x02\x02\x02\u01C2\u01C1\x03\x02\x02\x02" +
		"\u01C2\u01C3\x03\x02\x02\x02\u01C3\u01C5\x03\x02\x02\x02\u01C4\u01C6\x05" +
		"R*\x02\u01C5\u01C4\x03\x02\x02\x02\u01C5\u01C6\x03\x02\x02\x02\u01C65" +
		"\x03\x02\x02\x02\u01C7\u01C8\x07k\x02\x02\u01C8\u01C9\x05\x86D\x02\u01C9" +
		"7\x03\x02\x02\x02\u01CA\u01CB\x07]\x02\x02\u01CB\u01CE\x07q\x02\x02\u01CC" +
		"\u01CD\x07k\x02\x02\u01CD\u01CF\x07Z\x02\x02\u01CE\u01CC\x03\x02\x02\x02" +
		"\u01CE\u01CF\x03\x02\x02\x02\u01CF9\x03\x02\x02\x02\u01D0\u01D1\x07%\x02" +
		"\x02\u01D1\u01D2\x05T+\x02\u01D2;\x03\x02\x02\x02\u01D3\u01D5\t\x04\x02" +
		"\x02\u01D4\u01D3\x03\x02\x02\x02\u01D4\u01D5\x03\x02\x02\x02\u01D5\u01D6" +
		"\x03\x02\x02\x02\u01D6\u01D7\x07\x07\x02\x02\u01D7\u01D8\x074\x02\x02" +
		"\u01D8\u01D9\x05z>\x02\u01D9=\x03\x02\x02\x02\u01DA\u01DB\x07j\x02\x02" +
		"\u01DB\u01DC\x05\xA6T\x02\u01DC\u01DD\x07\b\x02\x02\u01DD\u01DE\x07\x87" +
		"\x02\x02\u01DE\u01DF\x05j6\x02\u01DF\u01E9\x07\x9B\x02\x02\u01E0\u01E1" +
		"\x07y\x02\x02\u01E1\u01E2\x05\xA6T\x02\u01E2\u01E3\x07\b\x02\x02\u01E3" +
		"\u01E4\x07\x87\x02\x02\u01E4\u01E5\x05j6\x02\u01E5\u01E6\x07\x9B\x02\x02" +
		"\u01E6\u01E8\x03\x02\x02\x02\u01E7\u01E0\x03\x02\x02\x02\u01E8\u01EB\x03" +
		"\x02\x02\x02\u01E9\u01E7\x03\x02\x02\x02\u01E9\u01EA\x03\x02\x02\x02\u01EA" +
		"?\x03\x02\x02\x02\u01EB\u01E9\x03\x02\x02\x02\u01EC\u01ED\x07J\x02\x02" +
		"\u01ED\u01EE\x05|?\x02\u01EEA\x03\x02\x02\x02\u01EF\u01F0\x07h\x02\x02" +
		"\u01F0\u01F1\x05|?\x02\u01F1C\x03\x02\x02\x02\u01F2\u01F3\x07(\x02\x02" +
		"\u01F3\u01FA\x07\r\x02\x02\u01F4\u01F5\t\x03\x02\x02\u01F5\u01F6\x07\x87" +
		"\x02\x02\u01F6\u01F7\x05z>\x02\u01F7\u01F8\x07\x9B\x02\x02\u01F8\u01FB" +
		"\x03\x02\x02\x02\u01F9\u01FB\x05z>\x02\u01FA\u01F4\x03\x02\x02\x02\u01FA" +
		"\u01F9\x03\x02\x02\x02\u01FBE\x03\x02\x02\x02\u01FC\u01FD\x07)\x02\x02" +
		"\u01FD\u01FE\x05|?\x02\u01FEG\x03\x02\x02\x02\u01FF\u0200\x07E\x02\x02" +
		"\u0200\u0201\x07\r\x02\x02\u0201\u0202\x05`1\x02\u0202I\x03\x02\x02\x02" +
		"\u0203\u0204\x07E\x02\x02\u0204\u0205\x07\r\x02\x02\u0205\u0206\x05z>" +
		"\x02\u0206K\x03\x02\x02\x02\u0207\u0208\x07;\x02\x02\u0208\u0209\x05^" +
		"0\x02\u0209\u020A\x07\r\x02\x02\u020A\u020B\x05z>\x02\u020BM\x03\x02\x02" +
		"\x02\u020C\u020D\x07;\x02\x02\u020D\u0210\x05|?\x02\u020E\u020F\x07y\x02" +
		"\x02\u020F\u0211\x05|?\x02\u0210\u020E\x03\x02\x02\x02\u0210\u0211\x03" +
		"\x02\x02\x02\u0211\u0214\x03\x02\x02\x02\u0212\u0213\x07k\x02\x02\u0213" +
		"\u0215\x07Z\x02\x02\u0214\u0212\x03\x02\x02\x02\u0214\u0215\x03\x02\x02" +
		"\x02\u0215\u0220\x03\x02\x02\x02\u0216\u0217\x07;\x02\x02\u0217\u021A" +
		"\x05|?\x02\u0218\u0219\x07k\x02\x02\u0219\u021B\x07Z\x02\x02\u021A\u0218" +
		"\x03\x02\x02\x02\u021A\u021B\x03\x02\x02\x02\u021B\u021C\x03\x02\x02\x02" +
		"\u021C\u021D\x07B\x02\x02\u021D\u021E\x05|?\x02\u021E\u0220\x03\x02\x02" +
		"\x02\u021F\u020C\x03\x02\x02\x02\u021F\u0216\x03\x02\x02\x02\u0220O\x03" +
		"\x02\x02\x02\u0221\u0222\x07B\x02\x02\u0222\u0223\x05|?\x02\u0223Q\x03" +
		"\x02\x02\x02\u0224\u0225\x07V\x02\x02\u0225\u0226\x05f4\x02\u0226S\x03" +
		"\x02\x02\x02\u0227\u0228\b+\x01\x02\u0228\u022A\x05\x8EH\x02\u0229\u022B" +
		"\x07\x1F\x02\x02\u022A\u0229\x03\x02\x02\x02\u022A\u022B\x03\x02\x02\x02" +
		"\u022B\u022D\x03\x02\x02\x02\u022C\u022E\x05\\/\x02\u022D\u022C\x03\x02" +
		"\x02\x02\u022D\u022E\x03\x02\x02\x02\u022E\u0234\x03\x02\x02\x02\u022F" +
		"\u0230\x07\x87\x02\x02\u0230\u0231\x05T+\x02\u0231\u0232\x07\x9B\x02\x02" +
		"\u0232\u0234\x03\x02\x02\x02\u0233\u0227\x03\x02\x02\x02\u0233\u022F\x03" +
		"\x02\x02\x02\u0234\u0243\x03\x02\x02\x02\u0235\u0236\f\x05\x02\x02\u0236" +
		"\u0237\x05X-\x02\u0237\u0238\x05T+\x06\u0238\u0242\x03\x02\x02\x02\u0239" +
		"\u023B\f\x06\x02\x02\u023A\u023C\x05V,\x02\u023B\u023A\x03\x02\x02\x02" +
		"\u023B\u023C\x03\x02\x02\x02\u023C\u023D\x03\x02\x02\x02\u023D\u023E\x07" +
		"4\x02\x02\u023E\u023F\x05T+\x02\u023F\u0240\x05Z.\x02\u0240\u0242\x03" +
		"\x02\x02\x02\u0241\u0235\x03\x02\x02\x02\u0241\u0239\x03\x02\x02\x02\u0242" +
		"\u0245\x03\x02\x02\x02\u0243\u0241\x03\x02\x02\x02\u0243\u0244\x03\x02" +
		"\x02\x02\u0244U\x03\x02\x02\x02\u0245\u0243\x03\x02\x02\x02\u0246\u0248" +
		"\t\x05\x02\x02\u0247\u0246\x03\x02\x02\x02\u0247\u0248\x03\x02\x02\x02" +
		"\u0248\u0249\x03\x02\x02\x02\u0249\u0250\x070\x02\x02\u024A\u024C\x07" +
		"0\x02\x02\u024B\u024D\t\x05\x02\x02\u024C\u024B\x03\x02\x02\x02\u024C" +
		"\u024D\x03\x02\x02\x02\u024D\u0250\x03\x02\x02\x02\u024E\u0250\t\x05\x02" +
		"\x02\u024F\u0247\x03\x02\x02\x02\u024F\u024A\x03\x02\x02\x02\u024F\u024E" +
		"\x03\x02\x02\x02\u0250\u0272\x03\x02\x02\x02\u0251\u0253\t\x06\x02\x02" +
		"\u0252\u0251\x03\x02\x02\x02\u0252\u0253\x03\x02\x02\x02\u0253\u0254\x03" +
		"\x02\x02\x02\u0254\u0256\t\x07\x02\x02\u0255\u0257\x07F\x02\x02\u0256" +
		"\u0255\x03\x02\x02\x02\u0256\u0257\x03\x02\x02\x02\u0257\u0260\x03\x02" +
		"\x02\x02\u0258\u025A\t\x07\x02\x02\u0259\u025B\x07F\x02\x02\u025A\u0259" +
		"\x03\x02\x02\x02\u025A\u025B\x03\x02\x02\x02\u025B\u025D\x03\x02\x02\x02" +
		"\u025C\u025E\t\x06\x02\x02\u025D\u025C\x03\x02\x02\x02\u025D\u025E\x03" +
		"\x02\x02\x02\u025E\u0260\x03\x02\x02\x02\u025F\u0252\x03\x02\x02\x02\u025F" +
		"\u0258\x03\x02\x02\x02\u0260\u0272\x03\x02\x02\x02\u0261\u0263\t\b\x02" +
		"\x02\u0262\u0261\x03\x02\x02\x02\u0262\u0263\x03\x02\x02\x02\u0263\u0264" +
		"\x03\x02\x02\x02\u0264\u0266\x07&\x02\x02\u0265\u0267\x07F\x02\x02\u0266" +
		"\u0265\x03\x02\x02\x02\u0266\u0267\x03\x02\x02\x02\u0267\u0270\x03\x02" +
		"\x02\x02\u0268\u026A\x07&\x02\x02\u0269\u026B\x07F\x02\x02\u026A\u0269" +
		"\x03\x02\x02\x02\u026A\u026B\x03\x02\x02\x02\u026B\u026D\x03\x02\x02\x02" +
		"\u026C\u026E\t\b\x02\x02\u026D\u026C\x03\x02\x02\x02\u026D\u026E\x03\x02" +
		"\x02\x02\u026E\u0270\x03\x02\x02\x02\u026F\u0262\x03\x02\x02\x02\u026F" +
		"\u0268\x03\x02\x02\x02\u0270\u0272\x03\x02\x02\x02\u0271\u024F\x03\x02" +
		"\x02\x02\u0271\u025F\x03\x02\x02\x02\u0271\u026F\x03\x02\x02\x02\u0272" +
		"W\x03\x02\x02\x02\u0273\u0274\x07\x13\x02\x02\u0274\u0277\x074\x02\x02" +
		"\u0275\u0277\x07y\x02\x02\u0276\u0273\x03\x02\x02\x02\u0276\u0275\x03" +
		"\x02\x02\x02\u0277Y\x03\x02\x02\x02\u0278\u0279\x07C\x02\x02\u0279\u0282" +
		"\x05z>\x02\u027A\u027B\x07e\x02\x02\u027B\u027C\x07\x87\x02\x02\u027C" +
		"\u027D\x05z>\x02\u027D\u027E\x07\x9B\x02\x02\u027E\u0282\x03\x02\x02\x02" +
		"\u027F\u0280\x07e\x02\x02\u0280\u0282\x05z>\x02\u0281\u0278\x03\x02\x02" +
		"\x02\u0281\u027A\x03\x02\x02\x02\u0281\u027F\x03\x02\x02\x02\u0282[\x03" +
		"\x02\x02\x02\u0283\u0284\x07R\x02\x02\u0284\u0287\x05d3\x02\u0285\u0286" +
		"\x07B\x02\x02\u0286\u0288\x05d3\x02\u0287\u0285\x03\x02\x02\x02\u0287" +
		"\u0288\x03\x02\x02\x02\u0288]\x03\x02\x02\x02\u0289\u028C\x05|?\x02\u028A" +
		"\u028B\t\t\x02\x02\u028B\u028D\x05|?\x02\u028C\u028A\x03\x02\x02\x02\u028C" +
		"\u028D\x03\x02\x02\x02\u028D_\x03\x02\x02\x02\u028E\u0293\x05b2\x02\u028F" +
		"\u0290\x07y\x02\x02\u0290\u0292\x05b2\x02\u0291\u028F\x03\x02\x02\x02" +
		"\u0292\u0295\x03\x02\x02\x02\u0293\u0291\x03\x02\x02\x02\u0293\u0294\x03" +
		"\x02\x02\x02\u0294a\x03\x02\x02\x02\u0295\u0293\x03\x02\x02\x02\u0296" +
		"\u0298\x05|?\x02\u0297\u0299\t\n\x02\x02\u0298\u0297\x03\x02\x02\x02\u0298" +
		"\u0299\x03\x02\x02\x02\u0299\u029C\x03\x02\x02\x02\u029A\u029B\x07A\x02" +
		"\x02\u029B\u029D\t\v\x02\x02\u029C\u029A\x03\x02\x02\x02\u029C\u029D\x03" +
		"\x02\x02\x02\u029D\u02A0\x03\x02\x02\x02\u029E\u029F\x07\x12\x02\x02\u029F" +
		"\u02A1\x07s\x02\x02\u02A0\u029E\x03\x02\x02\x02\u02A0\u02A1\x03\x02\x02" +
		"\x02\u02A1c\x03\x02\x02\x02\u02A2\u02A9\x05\xAAV\x02\u02A3\u02A6\x05\x9A" +
		"N\x02\u02A4\u02A5\x07\x9D\x02\x02\u02A5\u02A7\x05\x9AN\x02\u02A6\u02A4" +
		"\x03\x02\x02\x02\u02A6\u02A7\x03\x02\x02\x02\u02A7\u02A9\x03\x02\x02\x02" +
		"\u02A8\u02A2\x03\x02\x02\x02\u02A8\u02A3\x03\x02\x02\x02\u02A9e\x03\x02" +
		"\x02\x02\u02AA\u02AF\x05h5\x02\u02AB\u02AC\x07y\x02\x02\u02AC\u02AE\x05" +
		"h5\x02\u02AD\u02AB\x03\x02\x02\x02\u02AE\u02B1\x03\x02\x02\x02\u02AF\u02AD" +
		"\x03\x02\x02\x02\u02AF\u02B0\x03\x02\x02\x02\u02B0g\x03\x02\x02\x02\u02B1" +
		"\u02AF\x03\x02\x02\x02\u02B2\u02B3\x05\xA6T\x02\u02B3\u02B4\x07\x7F\x02" +
		"\x02\u02B4\u02B5\x05\x9CO\x02\u02B5i\x03\x02\x02\x02\u02B6\u02B8\x05l" +
		"7\x02\u02B7\u02B6\x03\x02\x02\x02\u02B7\u02B8\x03\x02\x02\x02\u02B8\u02BA" +
		"\x03\x02\x02\x02\u02B9\u02BB\x05n8\x02\u02BA\u02B9\x03\x02\x02\x02\u02BA" +
		"\u02BB\x03\x02\x02\x02\u02BB\u02BD\x03\x02\x02\x02\u02BC\u02BE\x05p9\x02" +
		"\u02BD\u02BC\x03\x02\x02\x02\u02BD\u02BE\x03\x02\x02\x02\u02BEk\x03\x02" +
		"\x02\x02\u02BF\u02C0\x07H\x02\x02\u02C0\u02C1\x07\r\x02\x02\u02C1\u02C2" +
		"\x05z>\x02\u02C2m\x03\x02\x02\x02\u02C3\u02C4\x07E\x02\x02\u02C4\u02C5" +
		"\x07\r\x02\x02\u02C5\u02C6\x05`1\x02\u02C6o\x03\x02\x02\x02\u02C7\u02C8" +
		"\t\f\x02\x02\u02C8\u02C9\x05r:\x02\u02C9q\x03\x02\x02\x02\u02CA\u02D1" +
		"\x05t;\x02\u02CB\u02CC\x07\v\x02\x02\u02CC\u02CD\x05t;\x02\u02CD\u02CE" +
		"\x07\x04\x02\x02\u02CE\u02CF\x05t;\x02\u02CF\u02D1\x03\x02\x02\x02\u02D0" +
		"\u02CA\x03\x02\x02\x02\u02D0\u02CB\x03\x02\x02\x02\u02D1s\x03\x02\x02" +
		"\x02\u02D2\u02D3\x07\x15\x02\x02\u02D3\u02DF\x07P\x02\x02\u02D4\u02D5" +
		"\x07c\x02\x02\u02D5\u02DF\x07I\x02\x02\u02D6\u02D7\x07c\x02\x02\u02D7" +
		"\u02DF\x07#\x02\x02\u02D8\u02D9\x05\x9AN\x02\u02D9\u02DA\x07I\x02\x02" +
		"\u02DA\u02DF\x03\x02\x02\x02\u02DB\u02DC\x05\x9AN\x02\u02DC\u02DD\x07" +
		"#\x02\x02\u02DD\u02DF\x03\x02\x02\x02\u02DE\u02D2\x03\x02\x02\x02\u02DE" +
		"\u02D4\x03\x02\x02\x02\u02DE\u02D6\x03\x02\x02\x02\u02DE\u02D8\x03\x02" +
		"\x02\x02\u02DE\u02DB\x03\x02\x02\x02\u02DFu\x03\x02\x02\x02\u02E0\u02E1" +
		"\x05|?\x02\u02E1\u02E2\x07\x02\x02\x03\u02E2w\x03\x02\x02\x02\u02E3\u031C" +
		"\x05\xA6T\x02\u02E4\u02E5\x05\xA6T\x02\u02E5\u02E6\x07\x87\x02\x02\u02E6" +
		"\u02E7\x05\xA6T\x02\u02E7\u02EE\x05x=\x02\u02E8\u02E9\x07y\x02\x02\u02E9" +
		"\u02EA\x05\xA6T\x02\u02EA\u02EB\x05x=\x02\u02EB\u02ED\x03\x02\x02\x02" +
		"\u02EC\u02E8\x03\x02\x02\x02\u02ED\u02F0\x03\x02\x02\x02\u02EE\u02EC\x03" +
		"\x02\x02\x02\u02EE\u02EF\x03\x02\x02\x02\u02EF\u02F2\x03\x02\x02\x02\u02F0" +
		"\u02EE\x03\x02\x02\x02\u02F1\u02F3\x07y\x02\x02\u02F2\u02F1\x03\x02\x02" +
		"\x02\u02F2\u02F3\x03\x02\x02\x02\u02F3\u02F4\x03\x02\x02\x02\u02F4\u02F5" +
		"\x07\x9B\x02\x02\u02F5\u031C\x03\x02\x02\x02\u02F6\u02F7\x05\xA6T\x02" +
		"\u02F7\u02F8\x07\x87\x02\x02\u02F8\u02FD\x05\xA8U\x02\u02F9\u02FA\x07" +
		"y\x02\x02\u02FA\u02FC\x05\xA8U\x02\u02FB\u02F9\x03\x02\x02\x02\u02FC\u02FF" +
		"\x03\x02\x02\x02\u02FD\u02FB\x03\x02\x02\x02\u02FD\u02FE\x03\x02\x02\x02" +
		"\u02FE\u0301\x03\x02\x02\x02\u02FF\u02FD\x03\x02\x02\x02\u0300\u0302\x07" +
		"y\x02\x02\u0301\u0300\x03\x02\x02\x02\u0301\u0302\x03\x02\x02\x02\u0302" +
		"\u0303\x03\x02\x02\x02\u0303\u0304\x07\x9B\x02\x02\u0304\u031C\x03\x02" +
		"\x02\x02\u0305\u0306\x05\xA6T\x02\u0306\u0307\x07\x87\x02\x02\u0307\u030C" +
		"\x05x=\x02\u0308\u0309\x07y\x02\x02\u0309\u030B\x05x=\x02\u030A\u0308" +
		"\x03\x02\x02\x02\u030B\u030E\x03\x02\x02\x02\u030C\u030A\x03\x02\x02\x02" +
		"\u030C\u030D\x03\x02\x02\x02\u030D\u0310\x03\x02\x02\x02\u030E\u030C\x03" +
		"\x02\x02\x02\u030F\u0311\x07y\x02\x02\u0310\u030F\x03\x02\x02\x02\u0310" +
		"\u0311\x03\x02\x02\x02\u0311\u0312\x03\x02\x02\x02\u0312\u0313\x07\x9B" +
		"\x02\x02\u0313\u031C\x03\x02\x02\x02\u0314\u0315\x05\xA6T\x02\u0315\u0317" +
		"\x07\x87\x02\x02\u0316\u0318\x05z>\x02\u0317\u0316\x03\x02\x02\x02\u0317" +
		"\u0318\x03\x02\x02\x02\u0318\u0319\x03\x02\x02\x02\u0319\u031A\x07\x9B" +
		"\x02\x02\u031A\u031C\x03\x02\x02\x02\u031B\u02E3\x03\x02\x02\x02\u031B" +
		"\u02E4\x03\x02\x02\x02\u031B\u02F6\x03\x02\x02\x02\u031B\u0305\x03\x02" +
		"\x02\x02\u031B\u0314\x03\x02\x02\x02\u031Cy\x03\x02\x02\x02\u031D\u0322" +
		"\x05|?\x02\u031E\u031F\x07y\x02\x02\u031F\u0321\x05|?\x02\u0320\u031E" +
		"\x03\x02\x02\x02\u0321\u0324\x03\x02\x02\x02\u0322\u0320\x03\x02\x02\x02" +
		"\u0322\u0323\x03\x02\x02\x02\u0323\u0326\x03\x02\x02\x02\u0324\u0322\x03" +
		"\x02\x02\x02\u0325\u0327\x07y\x02\x02\u0326\u0325\x03\x02\x02\x02\u0326" +
		"\u0327\x03\x02\x02\x02\u0327{\x03\x02\x02\x02\u0328\u0329\b?\x01\x02\u0329" +
		"\u032B\x07\x0E\x02\x02\u032A\u032C\x05|?\x02\u032B\u032A\x03\x02\x02\x02" +
		"\u032B\u032C\x03\x02\x02\x02\u032C\u0332\x03\x02\x02\x02\u032D\u032E\x07" +
		"g\x02\x02\u032E\u032F\x05|?\x02\u032F\u0330\x07X\x02\x02\u0330\u0331\x05" +
		"|?\x02\u0331\u0333\x03\x02\x02\x02\u0332\u032D\x03\x02\x02\x02\u0333\u0334" +
		"\x03\x02\x02\x02\u0334\u0332\x03\x02\x02\x02\u0334\u0335\x03\x02\x02\x02" +
		"\u0335\u0338\x03\x02\x02\x02\u0336\u0337\x07\x1B\x02\x02\u0337\u0339\x05" +
		"|?\x02\u0338\u0336\x03\x02\x02\x02\u0338\u0339\x03\x02\x02\x02\u0339\u033A" +
		"\x03\x02\x02\x02\u033A\u033B\x07\x1C\x02\x02\u033B\u03C1\x03\x02\x02\x02" +
		"\u033C\u033D\x07\x0F\x02\x02\u033D\u033E\x07\x87\x02\x02\u033E\u033F\x05" +
		"|?\x02\u033F\u0340\x07\b\x02\x02\u0340\u0341\x05x=\x02\u0341\u0342\x07" +
		"\x9B\x02\x02\u0342\u03C1\x03\x02\x02\x02\u0343\u0344\x07\x16\x02\x02\u0344" +
		"\u03C1\x07s\x02\x02\u0345\u0346\x072\x02\x02\u0346\u03C1\x07s\x02\x02" +
		"\u0347\u0348\x072\x02\x02\u0348\u0349\x05|?\x02\u0349\u034A\x05\x9EP\x02" +
		"\u034A\u03C1\x03\x02\x02\x02\u034B\u034C\x07W\x02\x02\u034C\u034D\x07" +
		"\x87\x02\x02\u034D\u034E\x05|?\x02\u034E\u034F\x07%\x02\x02\u034F\u0352" +
		"\x05|?\x02\u0350\u0351\x07$\x02\x02\u0351\u0353\x05|?\x02\u0352\u0350" +
		"\x03\x02\x02\x02\u0352\u0353\x03\x02\x02\x02\u0353\u0354\x03\x02\x02\x02" +
		"\u0354\u0355\x07\x9B\x02\x02\u0355\u03C1\x03\x02\x02\x02\u0356\u0357\x07" +
		"[\x02\x02\u0357\u03C1\x07s\x02\x02\u0358\u0359\x07`\x02\x02\u0359\u035A" +
		"\x07\x87\x02\x02\u035A\u035B\t\r\x02\x02\u035B\u035C\x05\xACW\x02\u035C" +
		"\u035D\x07%\x02\x02\u035D\u035E\x05|?\x02\u035E\u035F\x07\x9B\x02\x02" +
		"\u035F\u03C1\x03\x02\x02\x02\u0360\u0361\x05\xA6T\x02\u0361\u0363\x07" +
		"\x87\x02\x02\u0362\u0364\x05z>\x02\u0363\u0362\x03\x02\x02\x02\u0363\u0364" +
		"\x03\x02\x02\x02\u0364\u0365\x03\x02\x02\x02\u0365\u0366\x07\x9B\x02\x02" +
		"\u0366\u036F\x03\x02\x02\x02\u0367\u0369\x07\x87\x02\x02\u0368\u036A\x07" +
		"\x1A\x02\x02\u0369\u0368\x03\x02\x02\x02\u0369\u036A\x03\x02\x02\x02\u036A" +
		"\u036C\x03\x02\x02\x02\u036B\u036D\x05z>\x02\u036C\u036B\x03\x02\x02\x02" +
		"\u036C\u036D\x03\x02\x02\x02\u036D\u036E\x03\x02\x02\x02\u036E\u0370\x07" +
		"\x9B\x02\x02\u036F\u0367\x03\x02\x02\x02\u036F\u0370\x03\x02\x02\x02\u0370" +
		"\u0371\x03\x02\x02\x02\u0371\u0372\x07G\x02\x02\u0372\u0373\x07\x87\x02" +
		"\x02\u0373\u0374\x05j6\x02\u0374\u0375\x07\x9B\x02\x02\u0375\u03C1\x03" +
		"\x02\x02\x02\u0376\u0377\x05\xA6T\x02\u0377\u0379\x07\x87\x02\x02\u0378" +
		"\u037A\x05z>\x02\u0379\u0378\x03\x02\x02\x02\u0379\u037A\x03\x02\x02\x02" +
		"\u037A\u037B\x03\x02\x02\x02\u037B\u037C\x07\x9B\x02\x02\u037C\u0385\x03" +
		"\x02\x02\x02\u037D\u037F\x07\x87\x02\x02\u037E\u0380\x07\x1A\x02\x02\u037F" +
		"\u037E\x03\x02\x02\x02\u037F\u0380\x03\x02\x02\x02\u0380\u0382\x03\x02" +
		"\x02\x02\u0381\u0383\x05z>\x02\u0382\u0381\x03\x02\x02\x02\u0382\u0383" +
		"\x03\x02\x02\x02\u0383\u0384\x03\x02\x02\x02\u0384\u0386\x07\x9B\x02\x02" +
		"\u0385\u037D\x03\x02\x02\x02\u0385\u0386\x03\x02\x02\x02\u0386\u0387\x03" +
		"\x02\x02\x02\u0387\u0388\x07G\x02\x02\u0388\u0389\x05\xA6T\x02\u0389\u03C1" +
		"\x03\x02\x02\x02\u038A\u0390\x05\xA6T\x02\u038B\u038D\x07\x87\x02\x02" +
		"\u038C\u038E\x05z>\x02\u038D\u038C\x03\x02\x02\x02\u038D\u038E\x03\x02" +
		"\x02\x02\u038E\u038F\x03\x02\x02\x02\u038F\u0391\x07\x9B\x02\x02\u0390" +
		"\u038B\x03\x02\x02\x02\u0390\u0391\x03\x02\x02\x02\u0391\u0392\x03\x02" +
		"\x02\x02\u0392\u0394\x07\x87\x02\x02\u0393\u0395\x07\x1A\x02\x02\u0394" +
		"\u0393\x03\x02\x02\x02\u0394\u0395\x03\x02\x02\x02\u0395\u0397\x03\x02" +
		"\x02\x02\u0396\u0398\x05z>\x02\u0397\u0396\x03\x02\x02\x02\u0397\u0398" +
		"\x03\x02\x02\x02\u0398\u0399\x03\x02\x02\x02\u0399\u039A\x07\x9B\x02\x02" +
		"\u039A\u03C1\x03\x02\x02\x02\u039B\u03C1\x05\x82B\x02\u039C\u03C1\x05" +
		"\xAEX\x02\u039D\u03C1\x05\x9CO\x02\u039E\u039F\x07{\x02\x02\u039F\u03C1" +
		"\x05|?\x16\u03A0\u03A1\x07?\x02\x02\u03A1\u03C1\x05|?\x10\u03A2\u03A3" +
		"\x05\x92J\x02\u03A3\u03A4\x07}\x02\x02\u03A4\u03A6\x03\x02\x02\x02\u03A5" +
		"\u03A2\x03\x02\x02\x02\u03A5\u03A6\x03\x02\x02\x02\u03A6\u03A7\x03\x02" +
		"\x02\x02\u03A7\u03C1\x07u\x02\x02\u03A8\u03A9\x07\x87\x02\x02\u03A9\u03AA" +
		"\x052\x1A\x02\u03AA\u03AB\x07\x9B\x02\x02\u03AB\u03C1\x03\x02\x02\x02" +
		"\u03AC\u03AD\x07\x87\x02\x02\u03AD\u03AE\x05|?\x02\u03AE\u03AF\x07\x9B" +
		"\x02\x02\u03AF\u03C1\x03\x02\x02\x02\u03B0\u03B1\x07\x87\x02\x02\u03B1" +
		"\u03B2\x05z>\x02\u03B2\u03B3\x07\x9B\x02\x02\u03B3\u03C1\x03\x02\x02\x02" +
		"\u03B4\u03B6\x07\x86\x02\x02\u03B5\u03B7\x05z>\x02\u03B6\u03B5\x03\x02" +
		"\x02\x02\u03B6\u03B7\x03\x02\x02\x02\u03B7\u03B8\x03\x02\x02\x02\u03B8" +
		"\u03C1\x07\x9A\x02\x02\u03B9\u03BB\x07\x85\x02\x02\u03BA\u03BC\x05*\x16" +
		"\x02\u03BB\u03BA\x03\x02\x02\x02\u03BB\u03BC\x03\x02\x02\x02\u03BC\u03BD" +
		"\x03\x02\x02\x02\u03BD\u03C1\x07\x99\x02\x02\u03BE\u03C1\x05~@\x02\u03BF" +
		"\u03C1\x05\x8AF\x02\u03C0\u0328\x03\x02\x02\x02\u03C0\u033C\x03\x02\x02" +
		"\x02\u03C0\u0343\x03\x02\x02\x02\u03C0\u0345\x03\x02\x02\x02\u03C0\u0347" +
		"\x03\x02\x02\x02\u03C0\u034B\x03\x02\x02\x02\u03C0\u0356\x03\x02\x02\x02" +
		"\u03C0\u0358\x03\x02\x02\x02\u03C0\u0360\x03\x02\x02\x02\u03C0\u0376\x03" +
		"\x02\x02\x02\u03C0\u038A\x03\x02\x02\x02\u03C0\u039B\x03\x02\x02\x02\u03C0" +
		"\u039C\x03\x02\x02\x02\u03C0\u039D\x03\x02\x02\x02\u03C0\u039E\x03\x02" +
		"\x02\x02\u03C0\u03A0\x03\x02\x02\x02\u03C0\u03A5\x03\x02\x02\x02\u03C0" +
		"\u03A8\x03\x02\x02\x02\u03C0\u03AC\x03\x02\x02\x02\u03C0\u03B0\x03\x02" +
		"\x02\x02\u03C0\u03B4\x03\x02\x02\x02\u03C0\u03B9\x03\x02\x02\x02\u03C0" +
		"\u03BE\x03\x02\x02\x02\u03C0\u03BF\x03\x02\x02\x02\u03C1\u0435\x03\x02" +
		"\x02\x02\u03C2\u03C6\f\x15\x02\x02\u03C3\u03C7\x07u\x02\x02\u03C4\u03C7" +
		"\x07\x9D\x02\x02\u03C5\u03C7\x07\x90\x02\x02\u03C6\u03C3\x03\x02\x02\x02" +
		"\u03C6\u03C4\x03\x02\x02\x02\u03C6\u03C5\x03\x02\x02\x02\u03C7\u03C8\x03" +
		"\x02\x02\x02\u03C8\u0434\x05|?\x16\u03C9\u03CD\f\x14\x02\x02\u03CA\u03CE" +
		"\x07\x91\x02\x02\u03CB\u03CE\x07{\x02\x02\u03CC\u03CE\x07z\x02\x02\u03CD" +
		"\u03CA\x03\x02\x02\x02\u03CD\u03CB\x03\x02\x02\x02\u03CD\u03CC\x03\x02" +
		"\x02\x02\u03CE\u03CF\x03\x02\x02\x02\u03CF\u0434\x05|?\x15\u03D0\u03E9" +
		"\f\x13\x02\x02\u03D1\u03EA\x07~\x02\x02\u03D2\u03EA\x07\x7F\x02\x02\u03D3" +
		"\u03EA\x07\x8B\x02\x02\u03D4\u03EA\x07\x88\x02\x02\u03D5\u03EA\x07\x89" +
		"\x02\x02\u03D6\u03EA\x07\x80\x02\x02\u03D7\u03EA\x07\x81\x02\x02\u03D8" +
		"\u03DA\x07?\x02\x02\u03D9\u03D8\x03\x02\x02\x02\u03D9\u03DA\x03\x02\x02" +
		"\x02\u03DA\u03DB\x03\x02\x02\x02\u03DB\u03DD\x07.\x02\x02\u03DC\u03DE" +
		"\x07\x11\x02\x02\u03DD\u03DC\x03\x02\x02\x02\u03DD\u03DE\x03\x02\x02\x02" +
		"\u03DE\u03EA\x03\x02\x02\x02\u03DF\u03E1\x07?\x02\x02\u03E0\u03DF\x03" +
		"\x02\x02\x02\u03E0\u03E1\x03\x02\x02\x02\u03E1\u03E2\x03\x02\x02\x02\u03E2" +
		"\u03EA\t\x0E\x02\x02\u03E3\u03EA\x07\x97\x02\x02\u03E4\u03EA\x07\x98\x02" +
		"\x02\u03E5\u03EA\x07\x8D\x02\x02\u03E6\u03EA\x07\x83\x02\x02\u03E7\u03EA" +
		"\x07\x84\x02\x02\u03E8\u03EA\x07\x8C\x02\x02\u03E9\u03D1\x03\x02\x02\x02" +
		"\u03E9\u03D2\x03\x02\x02\x02\u03E9\u03D3\x03\x02\x02\x02\u03E9\u03D4\x03" +
		"\x02\x02\x02\u03E9\u03D5\x03\x02\x02\x02\u03E9\u03D6\x03\x02\x02\x02\u03E9" +
		"\u03D7\x03\x02\x02\x02\u03E9\u03D9\x03\x02\x02\x02\u03E9\u03E0\x03\x02" +
		"\x02\x02\u03E9\u03E3\x03\x02\x02\x02\u03E9\u03E4\x03\x02\x02\x02\u03E9" +
		"\u03E5\x03\x02\x02\x02\u03E9\u03E6\x03\x02\x02\x02\u03E9\u03E7\x03\x02" +
		"\x02\x02\u03E9\u03E8\x03\x02\x02\x02\u03EA\u03EB\x03\x02\x02\x02\u03EB" +
		"\u0434\x05|?\x14\u03EC\u03ED\f\x11\x02\x02\u03ED\u03EE\x07\x8F\x02\x02" +
		"\u03EE\u0434\x05|?\x12\u03EF\u03F0\f\x0F\x02\x02\u03F0\u03F1\x07\x04\x02" +
		"\x02\u03F1\u0434\x05|?\x10\u03F2\u03F3\f\x0E\x02\x02\u03F3\u03F4\x07D" +
		"\x02\x02\u03F4\u0434\x05|?\x0F\u03F5\u03F7\f\r\x02\x02\u03F6\u03F8\x07" +
		"?\x02\x02\u03F7\u03F6\x03\x02\x02\x02\u03F7\u03F8\x03\x02\x02\x02\u03F8" +
		"\u03F9\x03\x02\x02\x02\u03F9\u03FA\x07\v\x02\x02\u03FA\u03FB\x05|?\x02" +
		"\u03FB\u03FC\x07\x04\x02\x02\u03FC\u03FD\x05|?\x0E\u03FD\u0434\x03\x02" +
		"\x02\x02\u03FE\u03FF\f\f\x02\x02\u03FF\u0400\x07\x92\x02";
	private static readonly _serializedATNSegment2: string =
		"\x02\u0400\u0401\x05|?\x02\u0401\u0402\x07x\x02\x02\u0402\u0403\x05|?" +
		"\f\u0403\u0434\x03\x02\x02\x02\u0404\u0405\f!\x02\x02\u0405\u0406\x07" +
		"\x87\x02\x02\u0406\u0407\x052\x1A\x02\u0407\u0408\x07\x9B\x02\x02\u0408" +
		"\u0434\x03\x02\x02\x02\u0409\u040A\f \x02\x02\u040A\u040C\x07\x87\x02" +
		"\x02\u040B\u040D\x05z>\x02\u040C\u040B\x03\x02\x02\x02\u040C\u040D\x03" +
		"\x02\x02\x02\u040D\u040E\x03\x02\x02\x02\u040E\u0434\x07\x9B\x02\x02\u040F" +
		"\u0410\f\x1C\x02\x02\u0410\u0411\x07\x86\x02\x02\u0411\u0412\x05|?\x02" +
		"\u0412\u0413\x07\x9A\x02\x02\u0413\u0434\x03\x02\x02\x02\u0414\u0415\f" +
		"\x1B\x02\x02\u0415\u0416\x07}\x02\x02\u0416\u0434\x07q\x02\x02\u0417\u0418" +
		"\f\x1A\x02\x02\u0418\u0419\x07}\x02\x02\u0419\u0434\x05\xA6T\x02\u041A" +
		"\u041B\f\x19\x02\x02\u041B\u041C\x07\x8E\x02\x02\u041C\u041D\x07\x86\x02" +
		"\x02\u041D\u041E\x05|?\x02\u041E\u041F\x07\x9A\x02\x02\u041F\u0434\x03" +
		"\x02\x02\x02\u0420\u0421\f\x18\x02\x02\u0421\u0422\x07\x8E\x02\x02\u0422" +
		"\u0434\x07q\x02\x02\u0423\u0424\f\x17\x02\x02\u0424\u0425\x07\x8E\x02" +
		"\x02\u0425\u0434\x05\xA6T\x02\u0426\u0427\f\x12\x02\x02\u0427\u0429\x07" +
		"3\x02\x02\u0428\u042A\x07?\x02\x02\u0429\u0428\x03\x02\x02\x02\u0429\u042A" +
		"\x03\x02\x02\x02\u042A\u042B\x03\x02\x02\x02\u042B\u0434\x07@\x02\x02" +
		"\u042C\u0431\f\v\x02\x02\u042D\u042E\x07\b\x02\x02\u042E\u0432\x05\xA6" +
		"T\x02\u042F\u0430\x07\b\x02\x02\u0430\u0432\x07s\x02\x02\u0431\u042D\x03" +
		"\x02\x02\x02\u0431\u042F\x03\x02\x02\x02\u0432\u0434\x03\x02\x02\x02\u0433" +
		"\u03C2\x03\x02\x02\x02\u0433\u03C9\x03\x02\x02\x02\u0433\u03D0\x03\x02" +
		"\x02\x02\u0433\u03EC\x03\x02\x02\x02\u0433\u03EF\x03\x02\x02\x02\u0433" +
		"\u03F2\x03\x02\x02\x02\u0433\u03F5\x03\x02\x02\x02\u0433\u03FE\x03\x02" +
		"\x02\x02\u0433\u0404\x03\x02\x02\x02\u0433\u0409\x03\x02\x02\x02\u0433" +
		"\u040F\x03\x02\x02\x02\u0433\u0414\x03\x02\x02\x02\u0433\u0417\x03\x02" +
		"\x02\x02\u0433\u041A\x03\x02\x02\x02\u0433\u0420\x03\x02\x02\x02\u0433" +
		"\u0423\x03\x02\x02\x02\u0433\u0426\x03\x02\x02\x02\u0433\u042C\x03\x02" +
		"\x02\x02\u0434\u0437\x03\x02\x02\x02\u0435\u0433\x03\x02\x02\x02\u0435" +
		"\u0436\x03\x02\x02\x02\u0436}\x03\x02\x02\x02\u0437\u0435\x03\x02\x02" +
		"\x02\u0438\u0439\x07\x87\x02\x02\u0439\u043E\x05\xA6T\x02\u043A\u043B" +
		"\x07y\x02\x02\u043B\u043D\x05\xA6T\x02\u043C\u043A\x03\x02\x02\x02\u043D" +
		"\u0440\x03\x02\x02\x02\u043E\u043C\x03\x02\x02\x02\u043E\u043F\x03\x02" +
		"\x02\x02\u043F\u0442\x03\x02\x02\x02\u0440\u043E\x03\x02\x02\x02\u0441" +
		"\u0443\x07y\x02\x02\u0442\u0441\x03\x02\x02\x02\u0442\u0443\x03\x02\x02" +
		"\x02\u0443\u0444\x03\x02\x02\x02\u0444\u0445\x07\x9B\x02\x02\u0445\u0454" +
		"\x03\x02\x02\x02\u0446\u044B\x05\xA6T\x02\u0447\u0448\x07y\x02\x02\u0448" +
		"\u044A\x05\xA6T\x02\u0449\u0447\x03\x02\x02\x02\u044A\u044D\x03\x02\x02" +
		"\x02\u044B\u0449\x03\x02\x02\x02\u044B\u044C\x03\x02\x02\x02\u044C\u044F" +
		"\x03\x02\x02\x02\u044D\u044B\x03\x02\x02\x02\u044E\u0450\x07y\x02\x02" +
		"\u044F\u044E\x03\x02\x02\x02\u044F\u0450\x03\x02\x02\x02\u0450\u0454\x03" +
		"\x02\x02\x02\u0451\u0452\x07\x87\x02\x02\u0452\u0454\x07\x9B\x02\x02\u0453" +
		"\u0438\x03\x02\x02\x02\u0453\u0446\x03\x02\x02\x02\u0453\u0451\x03\x02" +
		"\x02\x02\u0454\u0455\x03\x02\x02\x02\u0455\u0458\x07t\x02\x02\u0456\u0459" +
		"\x05|?\x02\u0457\u0459\x05&\x14\x02\u0458\u0456\x03\x02\x02\x02\u0458" +
		"\u0457\x03\x02\x02\x02\u0459\x7F\x03\x02\x02\x02\u045A\u0461\x05\x82B" +
		"\x02\u045B\u0461\x07\xA9\x02\x02\u045C\u045D\x07\x85\x02\x02\u045D\u045E" +
		"\x05|?\x02\u045E\u045F\x07\x99\x02\x02\u045F\u0461\x03\x02\x02\x02\u0460" +
		"\u045A\x03\x02\x02\x02\u0460\u045B\x03\x02\x02\x02\u0460\u045C\x03\x02" +
		"\x02\x02\u0461\x81\x03\x02\x02\x02\u0462\u0463\x07\x89\x02\x02\u0463\u0467" +
		"\x05\xA6T\x02\u0464\u0466\x05\x84C\x02\u0465\u0464\x03\x02\x02\x02\u0466" +
		"\u0469\x03\x02\x02\x02\u0467\u0465\x03\x02\x02\x02\u0467\u0468\x03\x02" +
		"\x02\x02\u0468\u046A\x03\x02\x02\x02\u0469\u0467\x03\x02\x02\x02\u046A" +
		"\u046B\x07\x9E\x02\x02\u046B\u0480\x03\x02\x02\x02\u046C\u046D\x07\x89" +
		"\x02\x02\u046D\u0471\x05\xA6T\x02\u046E\u0470\x05\x84C\x02\u046F\u046E" +
		"\x03\x02\x02\x02\u0470\u0473\x03\x02\x02\x02\u0471\u046F\x03\x02\x02\x02" +
		"\u0471\u0472\x03\x02\x02\x02\u0472\u0474\x03\x02\x02\x02\u0473\u0471\x03" +
		"\x02\x02\x02\u0474\u0478\x07\x81\x02\x02\u0475\u0477\x05\x80A\x02\u0476" +
		"\u0475\x03\x02\x02\x02\u0477\u047A\x03\x02\x02\x02\u0478\u0476\x03\x02" +
		"\x02\x02\u0478\u0479\x03\x02\x02\x02\u0479\u047B\x03\x02\x02\x02\u047A" +
		"\u0478\x03\x02\x02\x02\u047B\u047C\x07\x8A\x02\x02\u047C\u047D\x05\xA6" +
		"T\x02\u047D\u047E\x07\x81\x02\x02\u047E\u0480\x03\x02\x02\x02\u047F\u0462" +
		"\x03\x02\x02\x02\u047F\u046C\x03\x02\x02\x02\u0480\x83\x03\x02\x02\x02" +
		"\u0481\u0482\x05\xA6T\x02\u0482\u0483\x07\x7F\x02\x02\u0483\u0484\x05" +
		"\xACW\x02\u0484\u048D\x03\x02\x02\x02\u0485\u0486\x05\xA6T\x02\u0486\u0487" +
		"\x07\x7F\x02\x02\u0487\u0488\x07\x85\x02\x02\u0488\u0489\x05|?\x02\u0489" +
		"\u048A\x07\x99\x02\x02\u048A\u048D\x03\x02\x02\x02\u048B\u048D\x05\xA6" +
		"T\x02\u048C\u0481\x03\x02\x02\x02\u048C\u0485\x03\x02\x02\x02\u048C\u048B" +
		"\x03\x02\x02\x02\u048D\x85\x03\x02\x02\x02\u048E\u0493\x05\x88E\x02\u048F" +
		"\u0490\x07y\x02\x02\u0490\u0492\x05\x88E\x02\u0491\u048F\x03\x02\x02\x02" +
		"\u0492\u0495\x03\x02\x02\x02\u0493\u0491\x03\x02\x02\x02\u0493\u0494\x03" +
		"\x02\x02\x02\u0494\u0497\x03\x02\x02\x02\u0495\u0493\x03\x02\x02\x02\u0496" +
		"\u0498\x07y\x02\x02\u0497\u0496\x03\x02\x02\x02\u0497\u0498\x03\x02\x02" +
		"\x02\u0498\x87\x03\x02\x02\x02\u0499\u049A\x05\xA6T\x02\u049A\u049B\x07" +
		"\b\x02\x02\u049B\u049C\x07\x87\x02\x02\u049C\u049D\x052\x1A\x02\u049D" +
		"\u049E\x07\x9B\x02\x02\u049E\u04A4\x03\x02\x02\x02\u049F\u04A0\x05|?\x02" +
		"\u04A0\u04A1\x07\b\x02\x02\u04A1\u04A2\x05\xA6T\x02\u04A2\u04A4\x03\x02" +
		"\x02\x02\u04A3\u0499\x03\x02\x02\x02\u04A3\u049F\x03\x02\x02\x02\u04A4" +
		"\x89\x03\x02\x02\x02\u04A5\u04AD\x05\xAAV\x02\u04A6\u04A7\x05\x92J\x02" +
		"\u04A7\u04A8\x07}\x02\x02\u04A8\u04AA\x03\x02\x02\x02\u04A9\u04A6\x03" +
		"\x02\x02\x02\u04A9\u04AA\x03\x02\x02\x02\u04AA\u04AB\x03\x02\x02\x02\u04AB" +
		"\u04AD\x05\x8CG\x02\u04AC\u04A5\x03\x02\x02\x02\u04AC\u04A9\x03\x02\x02" +
		"\x02\u04AD\x8B\x03\x02\x02\x02\u04AE\u04B3\x05\xA6T\x02\u04AF\u04B0\x07" +
		"}\x02\x02\u04B0\u04B2\x05\xA6T\x02\u04B1\u04AF\x03\x02\x02\x02\u04B2\u04B5" +
		"\x03\x02\x02\x02\u04B3\u04B1\x03\x02\x02\x02\u04B3\u04B4\x03\x02\x02\x02" +
		"\u04B4\x8D\x03\x02\x02\x02\u04B5\u04B3\x03\x02\x02\x02\u04B6\u04B7\bH" +
		"\x01\x02\u04B7\u04C0\x05\x92J\x02\u04B8\u04C0\x05\x90I\x02\u04B9\u04BA" +
		"\x07\x87\x02\x02\u04BA\u04BB\x052\x1A\x02\u04BB\u04BC\x07\x9B\x02\x02" +
		"\u04BC\u04C0\x03\x02\x02\x02\u04BD\u04C0\x05\x82B\x02\u04BE\u04C0\x05" +
		"\xAAV\x02\u04BF\u04B6\x03\x02\x02\x02\u04BF\u04B8\x03\x02\x02\x02\u04BF" +
		"\u04B9\x03\x02\x02\x02\u04BF\u04BD\x03\x02\x02\x02\u04BF\u04BE\x03\x02" +
		"\x02\x02\u04C0\u04C9\x03\x02\x02\x02\u04C1\u04C5\f\x05\x02\x02\u04C2\u04C6" +
		"\x05\xA4S\x02\u04C3\u04C4\x07\b\x02\x02\u04C4\u04C6\x05\xA6T\x02\u04C5" +
		"\u04C2\x03\x02\x02\x02\u04C5\u04C3\x03\x02\x02\x02\u04C6\u04C8\x03\x02" +
		"\x02\x02\u04C7\u04C1\x03\x02\x02\x02\u04C8\u04CB\x03\x02\x02\x02\u04C9" +
		"\u04C7\x03\x02\x02\x02\u04C9\u04CA\x03\x02\x02\x02\u04CA\x8F\x03\x02\x02" +
		"\x02\u04CB\u04C9\x03\x02\x02\x02\u04CC\u04CD\x05\xA6T\x02\u04CD\u04CF" +
		"\x07\x87\x02\x02\u04CE\u04D0\x05\x94K\x02\u04CF\u04CE\x03\x02\x02\x02" +
		"\u04CF\u04D0\x03\x02\x02\x02\u04D0\u04D1\x03\x02\x02\x02\u04D1\u04D2\x07" +
		"\x9B\x02\x02\u04D2\x91\x03\x02\x02\x02\u04D3\u04D4\x05\x96L\x02\u04D4" +
		"\u04D5\x07}\x02\x02\u04D5\u04D7\x03\x02\x02\x02\u04D6\u04D3\x03\x02\x02" +
		"\x02\u04D6\u04D7\x03\x02\x02\x02\u04D7\u04D8\x03\x02\x02\x02\u04D8\u04D9" +
		"\x05\x8CG\x02\u04D9\x93\x03\x02\x02\x02\u04DA\u04DF\x05|?\x02\u04DB\u04DC" +
		"\x07y\x02\x02\u04DC\u04DE\x05|?\x02\u04DD\u04DB\x03\x02\x02\x02\u04DE" +
		"\u04E1\x03\x02\x02\x02\u04DF\u04DD\x03\x02\x02\x02\u04DF\u04E0\x03\x02" +
		"\x02\x02\u04E0\u04E3\x03\x02\x02\x02\u04E1\u04DF\x03\x02\x02\x02\u04E2" +
		"\u04E4\x07y\x02\x02\u04E3\u04E2\x03\x02\x02\x02\u04E3\u04E4\x03\x02\x02" +
		"\x02\u04E4\x95\x03\x02\x02\x02\u04E5\u04E6\x05\xA6T\x02\u04E6\x97\x03" +
		"\x02\x02\x02\u04E7\u04F0\x07o\x02\x02\u04E8\u04E9\x07}\x02\x02\u04E9\u04F0" +
		"\t\x0F\x02\x02\u04EA\u04EB\x07q\x02\x02\u04EB\u04ED\x07}\x02\x02\u04EC" +
		"\u04EE\t\x0F\x02\x02\u04ED\u04EC\x03\x02\x02\x02\u04ED\u04EE\x03\x02\x02" +
		"\x02\u04EE\u04F0\x03\x02\x02\x02\u04EF\u04E7\x03\x02\x02\x02\u04EF\u04E8" +
		"\x03\x02\x02\x02\u04EF\u04EA\x03\x02\x02\x02\u04F0\x99\x03\x02\x02\x02" +
		"\u04F1\u04F3\t\x10\x02\x02\u04F2\u04F1\x03\x02\x02\x02\u04F2\u04F3\x03" +
		"\x02\x02\x02\u04F3\u04FA\x03\x02\x02\x02\u04F4\u04FB\x05\x98M\x02\u04F5" +
		"\u04FB\x07p\x02\x02\u04F6\u04FB\x07q\x02\x02\u04F7\u04FB\x07r\x02\x02" +
		"\u04F8\u04FB\x07/\x02\x02\u04F9\u04FB\x07>\x02\x02\u04FA\u04F4\x03\x02" +
		"\x02\x02\u04FA\u04F5\x03\x02\x02\x02\u04FA\u04F6\x03\x02\x02\x02\u04FA" +
		"\u04F7\x03\x02\x02\x02\u04FA\u04F8\x03\x02\x02\x02\u04FA\u04F9\x03\x02" +
		"\x02\x02\u04FB\x9B\x03\x02\x02\x02\u04FC\u0500\x05\x9AN\x02\u04FD\u0500" +
		"\x07s\x02\x02\u04FE\u0500\x07@\x02\x02\u04FF\u04FC\x03\x02\x02\x02\u04FF" +
		"\u04FD\x03\x02\x02\x02\u04FF\u04FE\x03\x02\x02\x02\u0500\x9D\x03\x02\x02" +
		"\x02\u0501\u0502\t\x11\x02\x02\u0502\x9F\x03\x02\x02\x02\u0503\u0504\t" +
		"\x12\x02\x02\u0504\xA1\x03\x02\x02\x02\u0505\u0506\t\x13\x02\x02\u0506" +
		"\xA3\x03\x02\x02\x02\u0507\u050A\x07n\x02\x02\u0508\u050A\x05\xA2R\x02" +
		"\u0509\u0507\x03\x02\x02\x02\u0509\u0508\x03\x02\x02\x02\u050A\xA5\x03" +
		"\x02\x02\x02\u050B\u050F\x07n\x02\x02\u050C\u050F\x05\x9EP\x02\u050D\u050F" +
		"\x05\xA0Q\x02\u050E\u050B\x03\x02\x02\x02\u050E\u050C\x03\x02\x02\x02" +
		"\u050E\u050D\x03\x02\x02\x02\u050F\xA7\x03\x02\x02\x02\u0510\u0511\x05" +
		"\xACW\x02\u0511\u0512\x07\x7F\x02\x02\u0512\u0513\x05\x9AN\x02\u0513\xA9" +
		"\x03\x02\x02\x02\u0514\u0515\x07\x85\x02\x02\u0515\u0516\x05|?\x02\u0516" +
		"\u0517\x07\x99\x02\x02\u0517\xAB\x03\x02\x02\x02\u0518\u051B\x07s\x02" +
		"\x02\u0519\u051B\x05\xAEX\x02\u051A\u0518\x03\x02\x02\x02\u051A\u0519" +
		"\x03\x02\x02\x02\u051B\xAD\x03\x02\x02\x02\u051C\u0520\x07\x94\x02\x02" +
		"\u051D\u051F\x05\xB0Y\x02\u051E\u051D\x03\x02\x02\x02\u051F\u0522\x03" +
		"\x02\x02\x02\u0520\u051E\x03\x02\x02\x02\u0520\u0521\x03\x02\x02\x02\u0521" +
		"\u0523\x03\x02\x02\x02\u0522\u0520\x03\x02\x02\x02\u0523\u0524\x07\x96" +
		"\x02\x02\u0524\xAF\x03\x02\x02\x02\u0525\u0526\x07\xA4\x02\x02\u0526\u0527" +
		"\x05|?\x02\u0527\u0528\x07\x99\x02\x02\u0528\u052B\x03\x02\x02\x02\u0529" +
		"\u052B\x07\xA3\x02\x02\u052A\u0525\x03\x02\x02\x02\u052A\u0529\x03\x02" +
		"\x02\x02\u052B\xB1\x03\x02\x02\x02\u052C\u0530\x07\x95\x02\x02\u052D\u052F" +
		"\x05\xB4[\x02\u052E\u052D\x03\x02\x02\x02\u052F\u0532\x03\x02\x02\x02" +
		"\u0530\u052E\x03\x02\x02\x02\u0530\u0531\x03\x02\x02\x02\u0531\u0533\x03" +
		"\x02\x02\x02\u0532\u0530\x03\x02\x02\x02\u0533\u0534\x07\x02\x02\x03\u0534" +
		"\xB3\x03\x02\x02\x02\u0535\u0536\x07\xA6\x02\x02\u0536\u0537\x05|?\x02" +
		"\u0537\u0538\x07\x99\x02\x02\u0538\u053B\x03\x02\x02\x02\u0539\u053B\x07" +
		"\xA5\x02\x02\u053A\u0535\x03\x02\x02\x02\u053A\u0539\x03\x02\x02\x02\u053B" +
		"\xB5\x03\x02\x02\x02\xAD\xB9\xC0\xC9\xD0\xD4\xE2\xE6\xE9\xED\xF0\xF7\xFB" +
		"\u0104\u0109\u0112\u011A\u0121\u0125\u012B\u0130\u0138\u013F\u0145\u0151" +
		"\u0159\u0167\u016B\u0170\u0173\u017D\u0187\u018F\u0193\u0197\u019A\u019E" +
		"\u01A1\u01A4\u01A7\u01AA\u01AE\u01B2\u01B5\u01B8\u01BB\u01BE\u01C2\u01C5" +
		"\u01CE\u01D4\u01E9\u01FA\u0210\u0214\u021A\u021F\u022A\u022D\u0233\u023B" +
		"\u0241\u0243\u0247\u024C\u024F\u0252\u0256\u025A\u025D\u025F\u0262\u0266" +
		"\u026A\u026D\u026F\u0271\u0276\u0281\u0287\u028C\u0293\u0298\u029C\u02A0" +
		"\u02A6\u02A8\u02AF\u02B7\u02BA\u02BD\u02D0\u02DE\u02EE\u02F2\u02FD\u0301" +
		"\u030C\u0310\u0317\u031B\u0322\u0326\u032B\u0334\u0338\u0352\u0363\u0369" +
		"\u036C\u036F\u0379\u037F\u0382\u0385\u038D\u0390\u0394\u0397\u03A5\u03B6" +
		"\u03BB\u03C0\u03C6\u03CD\u03D9\u03DD\u03E0\u03E9\u03F7\u040C\u0429\u0431" +
		"\u0433\u0435\u043E\u0442\u044B\u044F\u0453\u0458\u0460\u0467\u0471\u0478" +
		"\u047F\u048C\u0493\u0497\u04A3\u04A9\u04AC\u04B3\u04BF\u04C5\u04C9\u04CF" +
		"\u04D6\u04DF\u04E3\u04ED\u04EF\u04F2\u04FA\u04FF\u0509\u050E\u051A\u0520" +
		"\u052A\u0530\u053A";
	public static readonly _serializedATN: string = Utils.join(
		[
			TRQLParser._serializedATNSegment0,
			TRQLParser._serializedATNSegment1,
			TRQLParser._serializedATNSegment2,
		],
		"",
	);
	public static __ATN: ATN;
	public static get _ATN(): ATN {
		if (!TRQLParser.__ATN) {
			TRQLParser.__ATN = new ATNDeserializer().deserialize(Utils.toCharArray(TRQLParser._serializedATN));
		}

		return TRQLParser.__ATN;
	}

}

export class ProgramContext extends ParserRuleContext {
	public EOF(): TerminalNode { return this.getToken(TRQLParser.EOF, 0); }
	public declaration(): DeclarationContext[];
	public declaration(i: number): DeclarationContext;
	public declaration(i?: number): DeclarationContext | DeclarationContext[] {
		if (i === undefined) {
			return this.getRuleContexts(DeclarationContext);
		} else {
			return this.getRuleContext(i, DeclarationContext);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_program; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitProgram) {
			return visitor.visitProgram(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class DeclarationContext extends ParserRuleContext {
	public varDecl(): VarDeclContext | undefined {
		return this.tryGetRuleContext(0, VarDeclContext);
	}
	public statement(): StatementContext | undefined {
		return this.tryGetRuleContext(0, StatementContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_declaration; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitDeclaration) {
			return visitor.visitDeclaration(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ExpressionContext extends ParserRuleContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_expression; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitExpression) {
			return visitor.visitExpression(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class VarDeclContext extends ParserRuleContext {
	public LET(): TerminalNode { return this.getToken(TRQLParser.LET, 0); }
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	public COLON(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.COLON, 0); }
	public EQ_SINGLE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.EQ_SINGLE, 0); }
	public expression(): ExpressionContext | undefined {
		return this.tryGetRuleContext(0, ExpressionContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_varDecl; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitVarDecl) {
			return visitor.visitVarDecl(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class IdentifierListContext extends ParserRuleContext {
	public identifier(): IdentifierContext[];
	public identifier(i: number): IdentifierContext;
	public identifier(i?: number): IdentifierContext | IdentifierContext[] {
		if (i === undefined) {
			return this.getRuleContexts(IdentifierContext);
		} else {
			return this.getRuleContext(i, IdentifierContext);
		}
	}
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_identifierList; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitIdentifierList) {
			return visitor.visitIdentifierList(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class StatementContext extends ParserRuleContext {
	public returnStmt(): ReturnStmtContext | undefined {
		return this.tryGetRuleContext(0, ReturnStmtContext);
	}
	public throwStmt(): ThrowStmtContext | undefined {
		return this.tryGetRuleContext(0, ThrowStmtContext);
	}
	public tryCatchStmt(): TryCatchStmtContext | undefined {
		return this.tryGetRuleContext(0, TryCatchStmtContext);
	}
	public ifStmt(): IfStmtContext | undefined {
		return this.tryGetRuleContext(0, IfStmtContext);
	}
	public whileStmt(): WhileStmtContext | undefined {
		return this.tryGetRuleContext(0, WhileStmtContext);
	}
	public forInStmt(): ForInStmtContext | undefined {
		return this.tryGetRuleContext(0, ForInStmtContext);
	}
	public forStmt(): ForStmtContext | undefined {
		return this.tryGetRuleContext(0, ForStmtContext);
	}
	public funcStmt(): FuncStmtContext | undefined {
		return this.tryGetRuleContext(0, FuncStmtContext);
	}
	public varAssignment(): VarAssignmentContext | undefined {
		return this.tryGetRuleContext(0, VarAssignmentContext);
	}
	public block(): BlockContext | undefined {
		return this.tryGetRuleContext(0, BlockContext);
	}
	public exprStmt(): ExprStmtContext | undefined {
		return this.tryGetRuleContext(0, ExprStmtContext);
	}
	public emptyStmt(): EmptyStmtContext | undefined {
		return this.tryGetRuleContext(0, EmptyStmtContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_statement; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitStatement) {
			return visitor.visitStatement(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ReturnStmtContext extends ParserRuleContext {
	public RETURN(): TerminalNode { return this.getToken(TRQLParser.RETURN, 0); }
	public expression(): ExpressionContext | undefined {
		return this.tryGetRuleContext(0, ExpressionContext);
	}
	public SEMICOLON(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SEMICOLON, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_returnStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitReturnStmt) {
			return visitor.visitReturnStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ThrowStmtContext extends ParserRuleContext {
	public THROW(): TerminalNode { return this.getToken(TRQLParser.THROW, 0); }
	public expression(): ExpressionContext | undefined {
		return this.tryGetRuleContext(0, ExpressionContext);
	}
	public SEMICOLON(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SEMICOLON, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_throwStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitThrowStmt) {
			return visitor.visitThrowStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class CatchBlockContext extends ParserRuleContext {
	public _catchVar!: IdentifierContext;
	public _catchType!: IdentifierContext;
	public _catchStmt!: BlockContext;
	public CATCH(): TerminalNode { return this.getToken(TRQLParser.CATCH, 0); }
	public block(): BlockContext {
		return this.getRuleContext(0, BlockContext);
	}
	public LPAREN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LPAREN, 0); }
	public RPAREN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RPAREN, 0); }
	public identifier(): IdentifierContext[];
	public identifier(i: number): IdentifierContext;
	public identifier(i?: number): IdentifierContext | IdentifierContext[] {
		if (i === undefined) {
			return this.getRuleContexts(IdentifierContext);
		} else {
			return this.getRuleContext(i, IdentifierContext);
		}
	}
	public COLON(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.COLON, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_catchBlock; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitCatchBlock) {
			return visitor.visitCatchBlock(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TryCatchStmtContext extends ParserRuleContext {
	public _tryStmt!: BlockContext;
	public _finallyStmt!: BlockContext;
	public TRY(): TerminalNode { return this.getToken(TRQLParser.TRY, 0); }
	public block(): BlockContext[];
	public block(i: number): BlockContext;
	public block(i?: number): BlockContext | BlockContext[] {
		if (i === undefined) {
			return this.getRuleContexts(BlockContext);
		} else {
			return this.getRuleContext(i, BlockContext);
		}
	}
	public catchBlock(): CatchBlockContext[];
	public catchBlock(i: number): CatchBlockContext;
	public catchBlock(i?: number): CatchBlockContext | CatchBlockContext[] {
		if (i === undefined) {
			return this.getRuleContexts(CatchBlockContext);
		} else {
			return this.getRuleContext(i, CatchBlockContext);
		}
	}
	public FINALLY(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FINALLY, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_tryCatchStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTryCatchStmt) {
			return visitor.visitTryCatchStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class IfStmtContext extends ParserRuleContext {
	public IF(): TerminalNode { return this.getToken(TRQLParser.IF, 0); }
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public expression(): ExpressionContext {
		return this.getRuleContext(0, ExpressionContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public statement(): StatementContext[];
	public statement(i: number): StatementContext;
	public statement(i?: number): StatementContext | StatementContext[] {
		if (i === undefined) {
			return this.getRuleContexts(StatementContext);
		} else {
			return this.getRuleContext(i, StatementContext);
		}
	}
	public ELSE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ELSE, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_ifStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitIfStmt) {
			return visitor.visitIfStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WhileStmtContext extends ParserRuleContext {
	public WHILE(): TerminalNode { return this.getToken(TRQLParser.WHILE, 0); }
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public expression(): ExpressionContext {
		return this.getRuleContext(0, ExpressionContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public statement(): StatementContext {
		return this.getRuleContext(0, StatementContext);
	}
	public SEMICOLON(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SEMICOLON, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_whileStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWhileStmt) {
			return visitor.visitWhileStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ForStmtContext extends ParserRuleContext {
	public _initializerVarDeclr!: VarDeclContext;
	public _initializerVarAssignment!: VarAssignmentContext;
	public _initializerExpression!: ExpressionContext;
	public _condition!: ExpressionContext;
	public _incrementVarDeclr!: VarDeclContext;
	public _incrementVarAssignment!: VarAssignmentContext;
	public _incrementExpression!: ExpressionContext;
	public FOR(): TerminalNode { return this.getToken(TRQLParser.FOR, 0); }
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public SEMICOLON(): TerminalNode[];
	public SEMICOLON(i: number): TerminalNode;
	public SEMICOLON(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.SEMICOLON);
		} else {
			return this.getToken(TRQLParser.SEMICOLON, i);
		}
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public statement(): StatementContext {
		return this.getRuleContext(0, StatementContext);
	}
	public varDecl(): VarDeclContext[];
	public varDecl(i: number): VarDeclContext;
	public varDecl(i?: number): VarDeclContext | VarDeclContext[] {
		if (i === undefined) {
			return this.getRuleContexts(VarDeclContext);
		} else {
			return this.getRuleContext(i, VarDeclContext);
		}
	}
	public varAssignment(): VarAssignmentContext[];
	public varAssignment(i: number): VarAssignmentContext;
	public varAssignment(i?: number): VarAssignmentContext | VarAssignmentContext[] {
		if (i === undefined) {
			return this.getRuleContexts(VarAssignmentContext);
		} else {
			return this.getRuleContext(i, VarAssignmentContext);
		}
	}
	public expression(): ExpressionContext[];
	public expression(i: number): ExpressionContext;
	public expression(i?: number): ExpressionContext | ExpressionContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ExpressionContext);
		} else {
			return this.getRuleContext(i, ExpressionContext);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_forStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitForStmt) {
			return visitor.visitForStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ForInStmtContext extends ParserRuleContext {
	public FOR(): TerminalNode { return this.getToken(TRQLParser.FOR, 0); }
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public LET(): TerminalNode { return this.getToken(TRQLParser.LET, 0); }
	public identifier(): IdentifierContext[];
	public identifier(i: number): IdentifierContext;
	public identifier(i?: number): IdentifierContext | IdentifierContext[] {
		if (i === undefined) {
			return this.getRuleContexts(IdentifierContext);
		} else {
			return this.getRuleContext(i, IdentifierContext);
		}
	}
	public IN(): TerminalNode { return this.getToken(TRQLParser.IN, 0); }
	public expression(): ExpressionContext {
		return this.getRuleContext(0, ExpressionContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public statement(): StatementContext {
		return this.getRuleContext(0, StatementContext);
	}
	public COMMA(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.COMMA, 0); }
	public SEMICOLON(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SEMICOLON, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_forInStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitForInStmt) {
			return visitor.visitForInStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class FuncStmtContext extends ParserRuleContext {
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public block(): BlockContext {
		return this.getRuleContext(0, BlockContext);
	}
	public FN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FN, 0); }
	public FUN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FUN, 0); }
	public identifierList(): IdentifierListContext | undefined {
		return this.tryGetRuleContext(0, IdentifierListContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_funcStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitFuncStmt) {
			return visitor.visitFuncStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class VarAssignmentContext extends ParserRuleContext {
	public expression(): ExpressionContext[];
	public expression(i: number): ExpressionContext;
	public expression(i?: number): ExpressionContext | ExpressionContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ExpressionContext);
		} else {
			return this.getRuleContext(i, ExpressionContext);
		}
	}
	public COLON(): TerminalNode { return this.getToken(TRQLParser.COLON, 0); }
	public EQ_SINGLE(): TerminalNode { return this.getToken(TRQLParser.EQ_SINGLE, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_varAssignment; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitVarAssignment) {
			return visitor.visitVarAssignment(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ExprStmtContext extends ParserRuleContext {
	public expression(): ExpressionContext {
		return this.getRuleContext(0, ExpressionContext);
	}
	public SEMICOLON(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SEMICOLON, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_exprStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitExprStmt) {
			return visitor.visitExprStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class EmptyStmtContext extends ParserRuleContext {
	public SEMICOLON(): TerminalNode { return this.getToken(TRQLParser.SEMICOLON, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_emptyStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitEmptyStmt) {
			return visitor.visitEmptyStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class BlockContext extends ParserRuleContext {
	public LBRACE(): TerminalNode { return this.getToken(TRQLParser.LBRACE, 0); }
	public RBRACE(): TerminalNode { return this.getToken(TRQLParser.RBRACE, 0); }
	public declaration(): DeclarationContext[];
	public declaration(i: number): DeclarationContext;
	public declaration(i?: number): DeclarationContext | DeclarationContext[] {
		if (i === undefined) {
			return this.getRuleContexts(DeclarationContext);
		} else {
			return this.getRuleContext(i, DeclarationContext);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_block; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitBlock) {
			return visitor.visitBlock(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class KvPairContext extends ParserRuleContext {
	public expression(): ExpressionContext[];
	public expression(i: number): ExpressionContext;
	public expression(i?: number): ExpressionContext | ExpressionContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ExpressionContext);
		} else {
			return this.getRuleContext(i, ExpressionContext);
		}
	}
	public COLON(): TerminalNode { return this.getToken(TRQLParser.COLON, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_kvPair; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitKvPair) {
			return visitor.visitKvPair(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class KvPairListContext extends ParserRuleContext {
	public kvPair(): KvPairContext[];
	public kvPair(i: number): KvPairContext;
	public kvPair(i?: number): KvPairContext | KvPairContext[] {
		if (i === undefined) {
			return this.getRuleContexts(KvPairContext);
		} else {
			return this.getRuleContext(i, KvPairContext);
		}
	}
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_kvPairList; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitKvPairList) {
			return visitor.visitKvPairList(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class SelectContext extends ParserRuleContext {
	public EOF(): TerminalNode { return this.getToken(TRQLParser.EOF, 0); }
	public selectSetStmt(): SelectSetStmtContext | undefined {
		return this.tryGetRuleContext(0, SelectSetStmtContext);
	}
	public selectStmt(): SelectStmtContext | undefined {
		return this.tryGetRuleContext(0, SelectStmtContext);
	}
	public tRQLxTagElement(): TRQLxTagElementContext | undefined {
		return this.tryGetRuleContext(0, TRQLxTagElementContext);
	}
	public SEMICOLON(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SEMICOLON, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_select; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitSelect) {
			return visitor.visitSelect(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class SelectStmtWithParensContext extends ParserRuleContext {
	public selectStmt(): SelectStmtContext | undefined {
		return this.tryGetRuleContext(0, SelectStmtContext);
	}
	public LPAREN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LPAREN, 0); }
	public selectSetStmt(): SelectSetStmtContext | undefined {
		return this.tryGetRuleContext(0, SelectSetStmtContext);
	}
	public RPAREN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RPAREN, 0); }
	public placeholder(): PlaceholderContext | undefined {
		return this.tryGetRuleContext(0, PlaceholderContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_selectStmtWithParens; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitSelectStmtWithParens) {
			return visitor.visitSelectStmtWithParens(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class SubsequentSelectSetClauseContext extends ParserRuleContext {
	public selectStmtWithParens(): SelectStmtWithParensContext {
		return this.getRuleContext(0, SelectStmtWithParensContext);
	}
	public EXCEPT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.EXCEPT, 0); }
	public UNION(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.UNION, 0); }
	public ALL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ALL, 0); }
	public DISTINCT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DISTINCT, 0); }
	public INTERSECT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.INTERSECT, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_subsequentSelectSetClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitSubsequentSelectSetClause) {
			return visitor.visitSubsequentSelectSetClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class SelectSetStmtContext extends ParserRuleContext {
	public selectStmtWithParens(): SelectStmtWithParensContext {
		return this.getRuleContext(0, SelectStmtWithParensContext);
	}
	public subsequentSelectSetClause(): SubsequentSelectSetClauseContext[];
	public subsequentSelectSetClause(i: number): SubsequentSelectSetClauseContext;
	public subsequentSelectSetClause(i?: number): SubsequentSelectSetClauseContext | SubsequentSelectSetClauseContext[] {
		if (i === undefined) {
			return this.getRuleContexts(SubsequentSelectSetClauseContext);
		} else {
			return this.getRuleContext(i, SubsequentSelectSetClauseContext);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_selectSetStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitSelectSetStmt) {
			return visitor.visitSelectSetStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class SelectStmtContext extends ParserRuleContext {
	public _with!: WithClauseContext;
	public _columns!: ColumnExprListContext;
	public _from!: FromClauseContext;
	public _where!: WhereClauseContext;
	public SELECT(): TerminalNode { return this.getToken(TRQLParser.SELECT, 0); }
	public columnExprList(): ColumnExprListContext {
		return this.getRuleContext(0, ColumnExprListContext);
	}
	public DISTINCT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DISTINCT, 0); }
	public topClause(): TopClauseContext | undefined {
		return this.tryGetRuleContext(0, TopClauseContext);
	}
	public arrayJoinClause(): ArrayJoinClauseContext | undefined {
		return this.tryGetRuleContext(0, ArrayJoinClauseContext);
	}
	public prewhereClause(): PrewhereClauseContext | undefined {
		return this.tryGetRuleContext(0, PrewhereClauseContext);
	}
	public groupByClause(): GroupByClauseContext | undefined {
		return this.tryGetRuleContext(0, GroupByClauseContext);
	}
	public WITH(): TerminalNode[];
	public WITH(i: number): TerminalNode;
	public WITH(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.WITH);
		} else {
			return this.getToken(TRQLParser.WITH, i);
		}
	}
	public TOTALS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TOTALS, 0); }
	public havingClause(): HavingClauseContext | undefined {
		return this.tryGetRuleContext(0, HavingClauseContext);
	}
	public windowClause(): WindowClauseContext | undefined {
		return this.tryGetRuleContext(0, WindowClauseContext);
	}
	public orderByClause(): OrderByClauseContext | undefined {
		return this.tryGetRuleContext(0, OrderByClauseContext);
	}
	public limitByClause(): LimitByClauseContext | undefined {
		return this.tryGetRuleContext(0, LimitByClauseContext);
	}
	public limitAndOffsetClause(): LimitAndOffsetClauseContext | undefined {
		return this.tryGetRuleContext(0, LimitAndOffsetClauseContext);
	}
	public offsetOnlyClause(): OffsetOnlyClauseContext | undefined {
		return this.tryGetRuleContext(0, OffsetOnlyClauseContext);
	}
	public settingsClause(): SettingsClauseContext | undefined {
		return this.tryGetRuleContext(0, SettingsClauseContext);
	}
	public withClause(): WithClauseContext | undefined {
		return this.tryGetRuleContext(0, WithClauseContext);
	}
	public fromClause(): FromClauseContext | undefined {
		return this.tryGetRuleContext(0, FromClauseContext);
	}
	public whereClause(): WhereClauseContext | undefined {
		return this.tryGetRuleContext(0, WhereClauseContext);
	}
	public CUBE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.CUBE, 0); }
	public ROLLUP(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ROLLUP, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_selectStmt; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitSelectStmt) {
			return visitor.visitSelectStmt(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WithClauseContext extends ParserRuleContext {
	public WITH(): TerminalNode { return this.getToken(TRQLParser.WITH, 0); }
	public withExprList(): WithExprListContext {
		return this.getRuleContext(0, WithExprListContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_withClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWithClause) {
			return visitor.visitWithClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TopClauseContext extends ParserRuleContext {
	public TOP(): TerminalNode { return this.getToken(TRQLParser.TOP, 0); }
	public DECIMAL_LITERAL(): TerminalNode { return this.getToken(TRQLParser.DECIMAL_LITERAL, 0); }
	public WITH(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.WITH, 0); }
	public TIES(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TIES, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_topClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTopClause) {
			return visitor.visitTopClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class FromClauseContext extends ParserRuleContext {
	public FROM(): TerminalNode { return this.getToken(TRQLParser.FROM, 0); }
	public joinExpr(): JoinExprContext {
		return this.getRuleContext(0, JoinExprContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_fromClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitFromClause) {
			return visitor.visitFromClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ArrayJoinClauseContext extends ParserRuleContext {
	public ARRAY(): TerminalNode { return this.getToken(TRQLParser.ARRAY, 0); }
	public JOIN(): TerminalNode { return this.getToken(TRQLParser.JOIN, 0); }
	public columnExprList(): ColumnExprListContext {
		return this.getRuleContext(0, ColumnExprListContext);
	}
	public LEFT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LEFT, 0); }
	public INNER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.INNER, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_arrayJoinClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitArrayJoinClause) {
			return visitor.visitArrayJoinClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WindowClauseContext extends ParserRuleContext {
	public WINDOW(): TerminalNode { return this.getToken(TRQLParser.WINDOW, 0); }
	public identifier(): IdentifierContext[];
	public identifier(i: number): IdentifierContext;
	public identifier(i?: number): IdentifierContext | IdentifierContext[] {
		if (i === undefined) {
			return this.getRuleContexts(IdentifierContext);
		} else {
			return this.getRuleContext(i, IdentifierContext);
		}
	}
	public AS(): TerminalNode[];
	public AS(i: number): TerminalNode;
	public AS(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.AS);
		} else {
			return this.getToken(TRQLParser.AS, i);
		}
	}
	public LPAREN(): TerminalNode[];
	public LPAREN(i: number): TerminalNode;
	public LPAREN(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.LPAREN);
		} else {
			return this.getToken(TRQLParser.LPAREN, i);
		}
	}
	public windowExpr(): WindowExprContext[];
	public windowExpr(i: number): WindowExprContext;
	public windowExpr(i?: number): WindowExprContext | WindowExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(WindowExprContext);
		} else {
			return this.getRuleContext(i, WindowExprContext);
		}
	}
	public RPAREN(): TerminalNode[];
	public RPAREN(i: number): TerminalNode;
	public RPAREN(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.RPAREN);
		} else {
			return this.getToken(TRQLParser.RPAREN, i);
		}
	}
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_windowClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWindowClause) {
			return visitor.visitWindowClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class PrewhereClauseContext extends ParserRuleContext {
	public PREWHERE(): TerminalNode { return this.getToken(TRQLParser.PREWHERE, 0); }
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_prewhereClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitPrewhereClause) {
			return visitor.visitPrewhereClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WhereClauseContext extends ParserRuleContext {
	public WHERE(): TerminalNode { return this.getToken(TRQLParser.WHERE, 0); }
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_whereClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWhereClause) {
			return visitor.visitWhereClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class GroupByClauseContext extends ParserRuleContext {
	public GROUP(): TerminalNode { return this.getToken(TRQLParser.GROUP, 0); }
	public BY(): TerminalNode { return this.getToken(TRQLParser.BY, 0); }
	public LPAREN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LPAREN, 0); }
	public columnExprList(): ColumnExprListContext | undefined {
		return this.tryGetRuleContext(0, ColumnExprListContext);
	}
	public RPAREN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RPAREN, 0); }
	public CUBE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.CUBE, 0); }
	public ROLLUP(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ROLLUP, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_groupByClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitGroupByClause) {
			return visitor.visitGroupByClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class HavingClauseContext extends ParserRuleContext {
	public HAVING(): TerminalNode { return this.getToken(TRQLParser.HAVING, 0); }
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_havingClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitHavingClause) {
			return visitor.visitHavingClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class OrderByClauseContext extends ParserRuleContext {
	public ORDER(): TerminalNode { return this.getToken(TRQLParser.ORDER, 0); }
	public BY(): TerminalNode { return this.getToken(TRQLParser.BY, 0); }
	public orderExprList(): OrderExprListContext {
		return this.getRuleContext(0, OrderExprListContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_orderByClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitOrderByClause) {
			return visitor.visitOrderByClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ProjectionOrderByClauseContext extends ParserRuleContext {
	public ORDER(): TerminalNode { return this.getToken(TRQLParser.ORDER, 0); }
	public BY(): TerminalNode { return this.getToken(TRQLParser.BY, 0); }
	public columnExprList(): ColumnExprListContext {
		return this.getRuleContext(0, ColumnExprListContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_projectionOrderByClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitProjectionOrderByClause) {
			return visitor.visitProjectionOrderByClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class LimitByClauseContext extends ParserRuleContext {
	public LIMIT(): TerminalNode { return this.getToken(TRQLParser.LIMIT, 0); }
	public limitExpr(): LimitExprContext {
		return this.getRuleContext(0, LimitExprContext);
	}
	public BY(): TerminalNode { return this.getToken(TRQLParser.BY, 0); }
	public columnExprList(): ColumnExprListContext {
		return this.getRuleContext(0, ColumnExprListContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_limitByClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitLimitByClause) {
			return visitor.visitLimitByClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class LimitAndOffsetClauseContext extends ParserRuleContext {
	public LIMIT(): TerminalNode { return this.getToken(TRQLParser.LIMIT, 0); }
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public COMMA(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.COMMA, 0); }
	public WITH(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.WITH, 0); }
	public TIES(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TIES, 0); }
	public OFFSET(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.OFFSET, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_limitAndOffsetClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitLimitAndOffsetClause) {
			return visitor.visitLimitAndOffsetClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class OffsetOnlyClauseContext extends ParserRuleContext {
	public OFFSET(): TerminalNode { return this.getToken(TRQLParser.OFFSET, 0); }
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_offsetOnlyClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitOffsetOnlyClause) {
			return visitor.visitOffsetOnlyClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class SettingsClauseContext extends ParserRuleContext {
	public SETTINGS(): TerminalNode { return this.getToken(TRQLParser.SETTINGS, 0); }
	public settingExprList(): SettingExprListContext {
		return this.getRuleContext(0, SettingExprListContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_settingsClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitSettingsClause) {
			return visitor.visitSettingsClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class JoinExprContext extends ParserRuleContext {
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_joinExpr; }
	public copyFrom(ctx: JoinExprContext): void {
		super.copyFrom(ctx);
	}
}
export class JoinExprOpContext extends JoinExprContext {
	public joinExpr(): JoinExprContext[];
	public joinExpr(i: number): JoinExprContext;
	public joinExpr(i?: number): JoinExprContext | JoinExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(JoinExprContext);
		} else {
			return this.getRuleContext(i, JoinExprContext);
		}
	}
	public JOIN(): TerminalNode { return this.getToken(TRQLParser.JOIN, 0); }
	public joinConstraintClause(): JoinConstraintClauseContext {
		return this.getRuleContext(0, JoinConstraintClauseContext);
	}
	public joinOp(): JoinOpContext | undefined {
		return this.tryGetRuleContext(0, JoinOpContext);
	}
	constructor(ctx: JoinExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitJoinExprOp) {
			return visitor.visitJoinExprOp(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class JoinExprCrossOpContext extends JoinExprContext {
	public joinExpr(): JoinExprContext[];
	public joinExpr(i: number): JoinExprContext;
	public joinExpr(i?: number): JoinExprContext | JoinExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(JoinExprContext);
		} else {
			return this.getRuleContext(i, JoinExprContext);
		}
	}
	public joinOpCross(): JoinOpCrossContext {
		return this.getRuleContext(0, JoinOpCrossContext);
	}
	constructor(ctx: JoinExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitJoinExprCrossOp) {
			return visitor.visitJoinExprCrossOp(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class JoinExprTableContext extends JoinExprContext {
	public tableExpr(): TableExprContext {
		return this.getRuleContext(0, TableExprContext);
	}
	public FINAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FINAL, 0); }
	public sampleClause(): SampleClauseContext | undefined {
		return this.tryGetRuleContext(0, SampleClauseContext);
	}
	constructor(ctx: JoinExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitJoinExprTable) {
			return visitor.visitJoinExprTable(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class JoinExprParensContext extends JoinExprContext {
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public joinExpr(): JoinExprContext {
		return this.getRuleContext(0, JoinExprContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	constructor(ctx: JoinExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitJoinExprParens) {
			return visitor.visitJoinExprParens(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class JoinOpContext extends ParserRuleContext {
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_joinOp; }
	public copyFrom(ctx: JoinOpContext): void {
		super.copyFrom(ctx);
	}
}
export class JoinOpInnerContext extends JoinOpContext {
	public INNER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.INNER, 0); }
	public ALL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ALL, 0); }
	public ANY(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ANY, 0); }
	public ASOF(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ASOF, 0); }
	constructor(ctx: JoinOpContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitJoinOpInner) {
			return visitor.visitJoinOpInner(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class JoinOpLeftRightContext extends JoinOpContext {
	public LEFT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LEFT, 0); }
	public RIGHT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RIGHT, 0); }
	public OUTER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.OUTER, 0); }
	public SEMI(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SEMI, 0); }
	public ALL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ALL, 0); }
	public ANTI(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ANTI, 0); }
	public ANY(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ANY, 0); }
	public ASOF(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ASOF, 0); }
	constructor(ctx: JoinOpContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitJoinOpLeftRight) {
			return visitor.visitJoinOpLeftRight(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class JoinOpFullContext extends JoinOpContext {
	public FULL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FULL, 0); }
	public OUTER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.OUTER, 0); }
	public ALL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ALL, 0); }
	public ANY(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ANY, 0); }
	constructor(ctx: JoinOpContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitJoinOpFull) {
			return visitor.visitJoinOpFull(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class JoinOpCrossContext extends ParserRuleContext {
	public CROSS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.CROSS, 0); }
	public JOIN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.JOIN, 0); }
	public COMMA(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.COMMA, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_joinOpCross; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitJoinOpCross) {
			return visitor.visitJoinOpCross(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class JoinConstraintClauseContext extends ParserRuleContext {
	public ON(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ON, 0); }
	public columnExprList(): ColumnExprListContext {
		return this.getRuleContext(0, ColumnExprListContext);
	}
	public USING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.USING, 0); }
	public LPAREN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LPAREN, 0); }
	public RPAREN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RPAREN, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_joinConstraintClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitJoinConstraintClause) {
			return visitor.visitJoinConstraintClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class SampleClauseContext extends ParserRuleContext {
	public SAMPLE(): TerminalNode { return this.getToken(TRQLParser.SAMPLE, 0); }
	public ratioExpr(): RatioExprContext[];
	public ratioExpr(i: number): RatioExprContext;
	public ratioExpr(i?: number): RatioExprContext | RatioExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(RatioExprContext);
		} else {
			return this.getRuleContext(i, RatioExprContext);
		}
	}
	public OFFSET(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.OFFSET, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_sampleClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitSampleClause) {
			return visitor.visitSampleClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class LimitExprContext extends ParserRuleContext {
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public COMMA(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.COMMA, 0); }
	public OFFSET(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.OFFSET, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_limitExpr; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitLimitExpr) {
			return visitor.visitLimitExpr(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class OrderExprListContext extends ParserRuleContext {
	public orderExpr(): OrderExprContext[];
	public orderExpr(i: number): OrderExprContext;
	public orderExpr(i?: number): OrderExprContext | OrderExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(OrderExprContext);
		} else {
			return this.getRuleContext(i, OrderExprContext);
		}
	}
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_orderExprList; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitOrderExprList) {
			return visitor.visitOrderExprList(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class OrderExprContext extends ParserRuleContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public NULLS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.NULLS, 0); }
	public COLLATE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.COLLATE, 0); }
	public STRING_LITERAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.STRING_LITERAL, 0); }
	public ASCENDING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ASCENDING, 0); }
	public DESCENDING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DESCENDING, 0); }
	public DESC(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DESC, 0); }
	public FIRST(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FIRST, 0); }
	public LAST(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LAST, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_orderExpr; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitOrderExpr) {
			return visitor.visitOrderExpr(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class RatioExprContext extends ParserRuleContext {
	public placeholder(): PlaceholderContext | undefined {
		return this.tryGetRuleContext(0, PlaceholderContext);
	}
	public numberLiteral(): NumberLiteralContext[];
	public numberLiteral(i: number): NumberLiteralContext;
	public numberLiteral(i?: number): NumberLiteralContext | NumberLiteralContext[] {
		if (i === undefined) {
			return this.getRuleContexts(NumberLiteralContext);
		} else {
			return this.getRuleContext(i, NumberLiteralContext);
		}
	}
	public SLASH(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SLASH, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_ratioExpr; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitRatioExpr) {
			return visitor.visitRatioExpr(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class SettingExprListContext extends ParserRuleContext {
	public settingExpr(): SettingExprContext[];
	public settingExpr(i: number): SettingExprContext;
	public settingExpr(i?: number): SettingExprContext | SettingExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(SettingExprContext);
		} else {
			return this.getRuleContext(i, SettingExprContext);
		}
	}
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_settingExprList; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitSettingExprList) {
			return visitor.visitSettingExprList(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class SettingExprContext extends ParserRuleContext {
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	public EQ_SINGLE(): TerminalNode { return this.getToken(TRQLParser.EQ_SINGLE, 0); }
	public literal(): LiteralContext {
		return this.getRuleContext(0, LiteralContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_settingExpr; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitSettingExpr) {
			return visitor.visitSettingExpr(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WindowExprContext extends ParserRuleContext {
	public winPartitionByClause(): WinPartitionByClauseContext | undefined {
		return this.tryGetRuleContext(0, WinPartitionByClauseContext);
	}
	public winOrderByClause(): WinOrderByClauseContext | undefined {
		return this.tryGetRuleContext(0, WinOrderByClauseContext);
	}
	public winFrameClause(): WinFrameClauseContext | undefined {
		return this.tryGetRuleContext(0, WinFrameClauseContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_windowExpr; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWindowExpr) {
			return visitor.visitWindowExpr(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WinPartitionByClauseContext extends ParserRuleContext {
	public PARTITION(): TerminalNode { return this.getToken(TRQLParser.PARTITION, 0); }
	public BY(): TerminalNode { return this.getToken(TRQLParser.BY, 0); }
	public columnExprList(): ColumnExprListContext {
		return this.getRuleContext(0, ColumnExprListContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_winPartitionByClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWinPartitionByClause) {
			return visitor.visitWinPartitionByClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WinOrderByClauseContext extends ParserRuleContext {
	public ORDER(): TerminalNode { return this.getToken(TRQLParser.ORDER, 0); }
	public BY(): TerminalNode { return this.getToken(TRQLParser.BY, 0); }
	public orderExprList(): OrderExprListContext {
		return this.getRuleContext(0, OrderExprListContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_winOrderByClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWinOrderByClause) {
			return visitor.visitWinOrderByClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WinFrameClauseContext extends ParserRuleContext {
	public winFrameExtend(): WinFrameExtendContext {
		return this.getRuleContext(0, WinFrameExtendContext);
	}
	public ROWS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ROWS, 0); }
	public RANGE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RANGE, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_winFrameClause; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWinFrameClause) {
			return visitor.visitWinFrameClause(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WinFrameExtendContext extends ParserRuleContext {
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_winFrameExtend; }
	public copyFrom(ctx: WinFrameExtendContext): void {
		super.copyFrom(ctx);
	}
}
export class FrameStartContext extends WinFrameExtendContext {
	public winFrameBound(): WinFrameBoundContext {
		return this.getRuleContext(0, WinFrameBoundContext);
	}
	constructor(ctx: WinFrameExtendContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitFrameStart) {
			return visitor.visitFrameStart(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class FrameBetweenContext extends WinFrameExtendContext {
	public BETWEEN(): TerminalNode { return this.getToken(TRQLParser.BETWEEN, 0); }
	public winFrameBound(): WinFrameBoundContext[];
	public winFrameBound(i: number): WinFrameBoundContext;
	public winFrameBound(i?: number): WinFrameBoundContext | WinFrameBoundContext[] {
		if (i === undefined) {
			return this.getRuleContexts(WinFrameBoundContext);
		} else {
			return this.getRuleContext(i, WinFrameBoundContext);
		}
	}
	public AND(): TerminalNode { return this.getToken(TRQLParser.AND, 0); }
	constructor(ctx: WinFrameExtendContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitFrameBetween) {
			return visitor.visitFrameBetween(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WinFrameBoundContext extends ParserRuleContext {
	public CURRENT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.CURRENT, 0); }
	public ROW(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ROW, 0); }
	public UNBOUNDED(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.UNBOUNDED, 0); }
	public PRECEDING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.PRECEDING, 0); }
	public FOLLOWING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FOLLOWING, 0); }
	public numberLiteral(): NumberLiteralContext | undefined {
		return this.tryGetRuleContext(0, NumberLiteralContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_winFrameBound; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWinFrameBound) {
			return visitor.visitWinFrameBound(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ExprContext extends ParserRuleContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public EOF(): TerminalNode { return this.getToken(TRQLParser.EOF, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_expr; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitExpr) {
			return visitor.visitExpr(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ColumnTypeExprContext extends ParserRuleContext {
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_columnTypeExpr; }
	public copyFrom(ctx: ColumnTypeExprContext): void {
		super.copyFrom(ctx);
	}
}
export class ColumnTypeExprSimpleContext extends ColumnTypeExprContext {
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	constructor(ctx: ColumnTypeExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnTypeExprSimple) {
			return visitor.visitColumnTypeExprSimple(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnTypeExprNestedContext extends ColumnTypeExprContext {
	public identifier(): IdentifierContext[];
	public identifier(i: number): IdentifierContext;
	public identifier(i?: number): IdentifierContext | IdentifierContext[] {
		if (i === undefined) {
			return this.getRuleContexts(IdentifierContext);
		} else {
			return this.getRuleContext(i, IdentifierContext);
		}
	}
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public columnTypeExpr(): ColumnTypeExprContext[];
	public columnTypeExpr(i: number): ColumnTypeExprContext;
	public columnTypeExpr(i?: number): ColumnTypeExprContext | ColumnTypeExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnTypeExprContext);
		} else {
			return this.getRuleContext(i, ColumnTypeExprContext);
		}
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(ctx: ColumnTypeExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnTypeExprNested) {
			return visitor.visitColumnTypeExprNested(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnTypeExprEnumContext extends ColumnTypeExprContext {
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public enumValue(): EnumValueContext[];
	public enumValue(i: number): EnumValueContext;
	public enumValue(i?: number): EnumValueContext | EnumValueContext[] {
		if (i === undefined) {
			return this.getRuleContexts(EnumValueContext);
		} else {
			return this.getRuleContext(i, EnumValueContext);
		}
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(ctx: ColumnTypeExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnTypeExprEnum) {
			return visitor.visitColumnTypeExprEnum(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnTypeExprComplexContext extends ColumnTypeExprContext {
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public columnTypeExpr(): ColumnTypeExprContext[];
	public columnTypeExpr(i: number): ColumnTypeExprContext;
	public columnTypeExpr(i?: number): ColumnTypeExprContext | ColumnTypeExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnTypeExprContext);
		} else {
			return this.getRuleContext(i, ColumnTypeExprContext);
		}
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(ctx: ColumnTypeExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnTypeExprComplex) {
			return visitor.visitColumnTypeExprComplex(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnTypeExprParamContext extends ColumnTypeExprContext {
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public columnExprList(): ColumnExprListContext | undefined {
		return this.tryGetRuleContext(0, ColumnExprListContext);
	}
	constructor(ctx: ColumnTypeExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnTypeExprParam) {
			return visitor.visitColumnTypeExprParam(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ColumnExprListContext extends ParserRuleContext {
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_columnExprList; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprList) {
			return visitor.visitColumnExprList(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ColumnExprContext extends ParserRuleContext {
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_columnExpr; }
	public copyFrom(ctx: ColumnExprContext): void {
		super.copyFrom(ctx);
	}
}
export class ColumnExprCaseContext extends ColumnExprContext {
	public _caseExpr!: ColumnExprContext;
	public _whenExpr!: ColumnExprContext;
	public _thenExpr!: ColumnExprContext;
	public _elseExpr!: ColumnExprContext;
	public CASE(): TerminalNode { return this.getToken(TRQLParser.CASE, 0); }
	public END(): TerminalNode { return this.getToken(TRQLParser.END, 0); }
	public WHEN(): TerminalNode[];
	public WHEN(i: number): TerminalNode;
	public WHEN(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.WHEN);
		} else {
			return this.getToken(TRQLParser.WHEN, i);
		}
	}
	public THEN(): TerminalNode[];
	public THEN(i: number): TerminalNode;
	public THEN(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.THEN);
		} else {
			return this.getToken(TRQLParser.THEN, i);
		}
	}
	public ELSE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ELSE, 0); }
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprCase) {
			return visitor.visitColumnExprCase(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprCastContext extends ColumnExprContext {
	public CAST(): TerminalNode { return this.getToken(TRQLParser.CAST, 0); }
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public AS(): TerminalNode { return this.getToken(TRQLParser.AS, 0); }
	public columnTypeExpr(): ColumnTypeExprContext {
		return this.getRuleContext(0, ColumnTypeExprContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprCast) {
			return visitor.visitColumnExprCast(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprDateContext extends ColumnExprContext {
	public DATE(): TerminalNode { return this.getToken(TRQLParser.DATE, 0); }
	public STRING_LITERAL(): TerminalNode { return this.getToken(TRQLParser.STRING_LITERAL, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprDate) {
			return visitor.visitColumnExprDate(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprIntervalStringContext extends ColumnExprContext {
	public INTERVAL(): TerminalNode { return this.getToken(TRQLParser.INTERVAL, 0); }
	public STRING_LITERAL(): TerminalNode { return this.getToken(TRQLParser.STRING_LITERAL, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprIntervalString) {
			return visitor.visitColumnExprIntervalString(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprIntervalContext extends ColumnExprContext {
	public INTERVAL(): TerminalNode { return this.getToken(TRQLParser.INTERVAL, 0); }
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public interval(): IntervalContext {
		return this.getRuleContext(0, IntervalContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprInterval) {
			return visitor.visitColumnExprInterval(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprSubstringContext extends ColumnExprContext {
	public SUBSTRING(): TerminalNode { return this.getToken(TRQLParser.SUBSTRING, 0); }
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public FROM(): TerminalNode { return this.getToken(TRQLParser.FROM, 0); }
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public FOR(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FOR, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprSubstring) {
			return visitor.visitColumnExprSubstring(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprTimestampContext extends ColumnExprContext {
	public TIMESTAMP(): TerminalNode { return this.getToken(TRQLParser.TIMESTAMP, 0); }
	public STRING_LITERAL(): TerminalNode { return this.getToken(TRQLParser.STRING_LITERAL, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprTimestamp) {
			return visitor.visitColumnExprTimestamp(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprTrimContext extends ColumnExprContext {
	public TRIM(): TerminalNode { return this.getToken(TRQLParser.TRIM, 0); }
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public string(): StringContext {
		return this.getRuleContext(0, StringContext);
	}
	public FROM(): TerminalNode { return this.getToken(TRQLParser.FROM, 0); }
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public BOTH(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.BOTH, 0); }
	public LEADING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LEADING, 0); }
	public TRAILING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TRAILING, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprTrim) {
			return visitor.visitColumnExprTrim(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprWinFunctionContext extends ColumnExprContext {
	public _columnExprs!: ColumnExprListContext;
	public _columnArgList!: ColumnExprListContext;
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	public OVER(): TerminalNode { return this.getToken(TRQLParser.OVER, 0); }
	public LPAREN(): TerminalNode[];
	public LPAREN(i: number): TerminalNode;
	public LPAREN(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.LPAREN);
		} else {
			return this.getToken(TRQLParser.LPAREN, i);
		}
	}
	public windowExpr(): WindowExprContext {
		return this.getRuleContext(0, WindowExprContext);
	}
	public RPAREN(): TerminalNode[];
	public RPAREN(i: number): TerminalNode;
	public RPAREN(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.RPAREN);
		} else {
			return this.getToken(TRQLParser.RPAREN, i);
		}
	}
	public columnExprList(): ColumnExprListContext[];
	public columnExprList(i: number): ColumnExprListContext;
	public columnExprList(i?: number): ColumnExprListContext | ColumnExprListContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprListContext);
		} else {
			return this.getRuleContext(i, ColumnExprListContext);
		}
	}
	public DISTINCT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DISTINCT, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprWinFunction) {
			return visitor.visitColumnExprWinFunction(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprWinFunctionTargetContext extends ColumnExprContext {
	public _columnExprs!: ColumnExprListContext;
	public _columnArgList!: ColumnExprListContext;
	public identifier(): IdentifierContext[];
	public identifier(i: number): IdentifierContext;
	public identifier(i?: number): IdentifierContext | IdentifierContext[] {
		if (i === undefined) {
			return this.getRuleContexts(IdentifierContext);
		} else {
			return this.getRuleContext(i, IdentifierContext);
		}
	}
	public OVER(): TerminalNode { return this.getToken(TRQLParser.OVER, 0); }
	public LPAREN(): TerminalNode[];
	public LPAREN(i: number): TerminalNode;
	public LPAREN(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.LPAREN);
		} else {
			return this.getToken(TRQLParser.LPAREN, i);
		}
	}
	public RPAREN(): TerminalNode[];
	public RPAREN(i: number): TerminalNode;
	public RPAREN(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.RPAREN);
		} else {
			return this.getToken(TRQLParser.RPAREN, i);
		}
	}
	public columnExprList(): ColumnExprListContext[];
	public columnExprList(i: number): ColumnExprListContext;
	public columnExprList(i?: number): ColumnExprListContext | ColumnExprListContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprListContext);
		} else {
			return this.getRuleContext(i, ColumnExprListContext);
		}
	}
	public DISTINCT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DISTINCT, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprWinFunctionTarget) {
			return visitor.visitColumnExprWinFunctionTarget(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprFunctionContext extends ColumnExprContext {
	public _columnExprs!: ColumnExprListContext;
	public _columnArgList!: ColumnExprListContext;
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	public LPAREN(): TerminalNode[];
	public LPAREN(i: number): TerminalNode;
	public LPAREN(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.LPAREN);
		} else {
			return this.getToken(TRQLParser.LPAREN, i);
		}
	}
	public RPAREN(): TerminalNode[];
	public RPAREN(i: number): TerminalNode;
	public RPAREN(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.RPAREN);
		} else {
			return this.getToken(TRQLParser.RPAREN, i);
		}
	}
	public DISTINCT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DISTINCT, 0); }
	public columnExprList(): ColumnExprListContext[];
	public columnExprList(i: number): ColumnExprListContext;
	public columnExprList(i?: number): ColumnExprListContext | ColumnExprListContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprListContext);
		} else {
			return this.getRuleContext(i, ColumnExprListContext);
		}
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprFunction) {
			return visitor.visitColumnExprFunction(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprCallSelectContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public selectSetStmt(): SelectSetStmtContext {
		return this.getRuleContext(0, SelectSetStmtContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprCallSelect) {
			return visitor.visitColumnExprCallSelect(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprCallContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public columnExprList(): ColumnExprListContext | undefined {
		return this.tryGetRuleContext(0, ColumnExprListContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprCall) {
			return visitor.visitColumnExprCall(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprTagElementContext extends ColumnExprContext {
	public tRQLxTagElement(): TRQLxTagElementContext {
		return this.getRuleContext(0, TRQLxTagElementContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprTagElement) {
			return visitor.visitColumnExprTagElement(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprTemplateStringContext extends ColumnExprContext {
	public templateString(): TemplateStringContext {
		return this.getRuleContext(0, TemplateStringContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprTemplateString) {
			return visitor.visitColumnExprTemplateString(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprLiteralContext extends ColumnExprContext {
	public literal(): LiteralContext {
		return this.getRuleContext(0, LiteralContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprLiteral) {
			return visitor.visitColumnExprLiteral(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprArrayAccessContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public LBRACKET(): TerminalNode { return this.getToken(TRQLParser.LBRACKET, 0); }
	public RBRACKET(): TerminalNode { return this.getToken(TRQLParser.RBRACKET, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprArrayAccess) {
			return visitor.visitColumnExprArrayAccess(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprTupleAccessContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public DOT(): TerminalNode { return this.getToken(TRQLParser.DOT, 0); }
	public DECIMAL_LITERAL(): TerminalNode { return this.getToken(TRQLParser.DECIMAL_LITERAL, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprTupleAccess) {
			return visitor.visitColumnExprTupleAccess(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprPropertyAccessContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public DOT(): TerminalNode { return this.getToken(TRQLParser.DOT, 0); }
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprPropertyAccess) {
			return visitor.visitColumnExprPropertyAccess(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprNullArrayAccessContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public NULL_PROPERTY(): TerminalNode { return this.getToken(TRQLParser.NULL_PROPERTY, 0); }
	public LBRACKET(): TerminalNode { return this.getToken(TRQLParser.LBRACKET, 0); }
	public RBRACKET(): TerminalNode { return this.getToken(TRQLParser.RBRACKET, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprNullArrayAccess) {
			return visitor.visitColumnExprNullArrayAccess(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprNullTupleAccessContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public NULL_PROPERTY(): TerminalNode { return this.getToken(TRQLParser.NULL_PROPERTY, 0); }
	public DECIMAL_LITERAL(): TerminalNode { return this.getToken(TRQLParser.DECIMAL_LITERAL, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprNullTupleAccess) {
			return visitor.visitColumnExprNullTupleAccess(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprNullPropertyAccessContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public NULL_PROPERTY(): TerminalNode { return this.getToken(TRQLParser.NULL_PROPERTY, 0); }
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprNullPropertyAccess) {
			return visitor.visitColumnExprNullPropertyAccess(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprNegateContext extends ColumnExprContext {
	public DASH(): TerminalNode { return this.getToken(TRQLParser.DASH, 0); }
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprNegate) {
			return visitor.visitColumnExprNegate(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprPrecedence1Context extends ColumnExprContext {
	public _left!: ColumnExprContext;
	public _operator!: Token;
	public _right!: ColumnExprContext;
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public ASTERISK(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ASTERISK, 0); }
	public SLASH(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SLASH, 0); }
	public PERCENT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.PERCENT, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprPrecedence1) {
			return visitor.visitColumnExprPrecedence1(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprPrecedence2Context extends ColumnExprContext {
	public _left!: ColumnExprContext;
	public _operator!: Token;
	public _right!: ColumnExprContext;
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public PLUS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.PLUS, 0); }
	public DASH(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DASH, 0); }
	public CONCAT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.CONCAT, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprPrecedence2) {
			return visitor.visitColumnExprPrecedence2(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprPrecedence3Context extends ColumnExprContext {
	public _left!: ColumnExprContext;
	public _operator!: Token;
	public _right!: ColumnExprContext;
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public IN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.IN, 0); }
	public EQ_DOUBLE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.EQ_DOUBLE, 0); }
	public EQ_SINGLE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.EQ_SINGLE, 0); }
	public NOT_EQ(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.NOT_EQ, 0); }
	public LT_EQ(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LT_EQ, 0); }
	public LT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LT, 0); }
	public GT_EQ(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.GT_EQ, 0); }
	public GT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.GT, 0); }
	public LIKE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LIKE, 0); }
	public ILIKE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ILIKE, 0); }
	public REGEX_SINGLE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.REGEX_SINGLE, 0); }
	public REGEX_DOUBLE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.REGEX_DOUBLE, 0); }
	public NOT_REGEX(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.NOT_REGEX, 0); }
	public IREGEX_SINGLE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.IREGEX_SINGLE, 0); }
	public IREGEX_DOUBLE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.IREGEX_DOUBLE, 0); }
	public NOT_IREGEX(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.NOT_IREGEX, 0); }
	public COHORT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.COHORT, 0); }
	public NOT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.NOT, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprPrecedence3) {
			return visitor.visitColumnExprPrecedence3(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprIsNullContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public IS(): TerminalNode { return this.getToken(TRQLParser.IS, 0); }
	public NULL_SQL(): TerminalNode { return this.getToken(TRQLParser.NULL_SQL, 0); }
	public NOT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.NOT, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprIsNull) {
			return visitor.visitColumnExprIsNull(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprNullishContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public NULLISH(): TerminalNode { return this.getToken(TRQLParser.NULLISH, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprNullish) {
			return visitor.visitColumnExprNullish(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprNotContext extends ColumnExprContext {
	public NOT(): TerminalNode { return this.getToken(TRQLParser.NOT, 0); }
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprNot) {
			return visitor.visitColumnExprNot(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprAndContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public AND(): TerminalNode { return this.getToken(TRQLParser.AND, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprAnd) {
			return visitor.visitColumnExprAnd(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprOrContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public OR(): TerminalNode { return this.getToken(TRQLParser.OR, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprOr) {
			return visitor.visitColumnExprOr(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprBetweenContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public BETWEEN(): TerminalNode { return this.getToken(TRQLParser.BETWEEN, 0); }
	public AND(): TerminalNode { return this.getToken(TRQLParser.AND, 0); }
	public NOT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.NOT, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprBetween) {
			return visitor.visitColumnExprBetween(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprTernaryOpContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public QUERY(): TerminalNode { return this.getToken(TRQLParser.QUERY, 0); }
	public COLON(): TerminalNode { return this.getToken(TRQLParser.COLON, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprTernaryOp) {
			return visitor.visitColumnExprTernaryOp(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprAliasContext extends ColumnExprContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public AS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.AS, 0); }
	public identifier(): IdentifierContext | undefined {
		return this.tryGetRuleContext(0, IdentifierContext);
	}
	public STRING_LITERAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.STRING_LITERAL, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprAlias) {
			return visitor.visitColumnExprAlias(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprAsteriskContext extends ColumnExprContext {
	public ASTERISK(): TerminalNode { return this.getToken(TRQLParser.ASTERISK, 0); }
	public tableIdentifier(): TableIdentifierContext | undefined {
		return this.tryGetRuleContext(0, TableIdentifierContext);
	}
	public DOT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DOT, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprAsterisk) {
			return visitor.visitColumnExprAsterisk(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprSubqueryContext extends ColumnExprContext {
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public selectSetStmt(): SelectSetStmtContext {
		return this.getRuleContext(0, SelectSetStmtContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprSubquery) {
			return visitor.visitColumnExprSubquery(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprParensContext extends ColumnExprContext {
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprParens) {
			return visitor.visitColumnExprParens(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprTupleContext extends ColumnExprContext {
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public columnExprList(): ColumnExprListContext {
		return this.getRuleContext(0, ColumnExprListContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprTuple) {
			return visitor.visitColumnExprTuple(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprArrayContext extends ColumnExprContext {
	public LBRACKET(): TerminalNode { return this.getToken(TRQLParser.LBRACKET, 0); }
	public RBRACKET(): TerminalNode { return this.getToken(TRQLParser.RBRACKET, 0); }
	public columnExprList(): ColumnExprListContext | undefined {
		return this.tryGetRuleContext(0, ColumnExprListContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprArray) {
			return visitor.visitColumnExprArray(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprDictContext extends ColumnExprContext {
	public LBRACE(): TerminalNode { return this.getToken(TRQLParser.LBRACE, 0); }
	public RBRACE(): TerminalNode { return this.getToken(TRQLParser.RBRACE, 0); }
	public kvPairList(): KvPairListContext | undefined {
		return this.tryGetRuleContext(0, KvPairListContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprDict) {
			return visitor.visitColumnExprDict(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprLambdaContext extends ColumnExprContext {
	public columnLambdaExpr(): ColumnLambdaExprContext {
		return this.getRuleContext(0, ColumnLambdaExprContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprLambda) {
			return visitor.visitColumnExprLambda(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class ColumnExprIdentifierContext extends ColumnExprContext {
	public columnIdentifier(): ColumnIdentifierContext {
		return this.getRuleContext(0, ColumnIdentifierContext);
	}
	constructor(ctx: ColumnExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnExprIdentifier) {
			return visitor.visitColumnExprIdentifier(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ColumnLambdaExprContext extends ParserRuleContext {
	public ARROW(): TerminalNode { return this.getToken(TRQLParser.ARROW, 0); }
	public LPAREN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LPAREN, 0); }
	public identifier(): IdentifierContext[];
	public identifier(i: number): IdentifierContext;
	public identifier(i?: number): IdentifierContext | IdentifierContext[] {
		if (i === undefined) {
			return this.getRuleContexts(IdentifierContext);
		} else {
			return this.getRuleContext(i, IdentifierContext);
		}
	}
	public RPAREN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RPAREN, 0); }
	public columnExpr(): ColumnExprContext | undefined {
		return this.tryGetRuleContext(0, ColumnExprContext);
	}
	public block(): BlockContext | undefined {
		return this.tryGetRuleContext(0, BlockContext);
	}
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_columnLambdaExpr; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnLambdaExpr) {
			return visitor.visitColumnLambdaExpr(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TRQLxChildElementContext extends ParserRuleContext {
	public tRQLxTagElement(): TRQLxTagElementContext | undefined {
		return this.tryGetRuleContext(0, TRQLxTagElementContext);
	}
	public TRQLX_TEXT_TEXT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TRQLX_TEXT_TEXT, 0); }
	public LBRACE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LBRACE, 0); }
	public columnExpr(): ColumnExprContext | undefined {
		return this.tryGetRuleContext(0, ColumnExprContext);
	}
	public RBRACE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RBRACE, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_tRQLxChildElement; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTRQLxChildElement) {
			return visitor.visitTRQLxChildElement(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TRQLxTagElementContext extends ParserRuleContext {
	public LT(): TerminalNode { return this.getToken(TRQLParser.LT, 0); }
	public identifier(): IdentifierContext[];
	public identifier(i: number): IdentifierContext;
	public identifier(i?: number): IdentifierContext | IdentifierContext[] {
		if (i === undefined) {
			return this.getRuleContexts(IdentifierContext);
		} else {
			return this.getRuleContext(i, IdentifierContext);
		}
	}
	public SLASH_GT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SLASH_GT, 0); }
	public tRQLxTagAttribute(): TRQLxTagAttributeContext[];
	public tRQLxTagAttribute(i: number): TRQLxTagAttributeContext;
	public tRQLxTagAttribute(i?: number): TRQLxTagAttributeContext | TRQLxTagAttributeContext[] {
		if (i === undefined) {
			return this.getRuleContexts(TRQLxTagAttributeContext);
		} else {
			return this.getRuleContext(i, TRQLxTagAttributeContext);
		}
	}
	public GT(): TerminalNode[];
	public GT(i: number): TerminalNode;
	public GT(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.GT);
		} else {
			return this.getToken(TRQLParser.GT, i);
		}
	}
	public LT_SLASH(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LT_SLASH, 0); }
	public tRQLxChildElement(): TRQLxChildElementContext[];
	public tRQLxChildElement(i: number): TRQLxChildElementContext;
	public tRQLxChildElement(i?: number): TRQLxChildElementContext | TRQLxChildElementContext[] {
		if (i === undefined) {
			return this.getRuleContexts(TRQLxChildElementContext);
		} else {
			return this.getRuleContext(i, TRQLxChildElementContext);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_tRQLxTagElement; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTRQLxTagElement) {
			return visitor.visitTRQLxTagElement(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TRQLxTagAttributeContext extends ParserRuleContext {
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	public EQ_SINGLE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.EQ_SINGLE, 0); }
	public string(): StringContext | undefined {
		return this.tryGetRuleContext(0, StringContext);
	}
	public LBRACE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LBRACE, 0); }
	public columnExpr(): ColumnExprContext | undefined {
		return this.tryGetRuleContext(0, ColumnExprContext);
	}
	public RBRACE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RBRACE, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_tRQLxTagAttribute; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTRQLxTagAttribute) {
			return visitor.visitTRQLxTagAttribute(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WithExprListContext extends ParserRuleContext {
	public withExpr(): WithExprContext[];
	public withExpr(i: number): WithExprContext;
	public withExpr(i?: number): WithExprContext | WithExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(WithExprContext);
		} else {
			return this.getRuleContext(i, WithExprContext);
		}
	}
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_withExprList; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWithExprList) {
			return visitor.visitWithExprList(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class WithExprContext extends ParserRuleContext {
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_withExpr; }
	public copyFrom(ctx: WithExprContext): void {
		super.copyFrom(ctx);
	}
}
export class WithExprSubqueryContext extends WithExprContext {
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	public AS(): TerminalNode { return this.getToken(TRQLParser.AS, 0); }
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public selectSetStmt(): SelectSetStmtContext {
		return this.getRuleContext(0, SelectSetStmtContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	constructor(ctx: WithExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWithExprSubquery) {
			return visitor.visitWithExprSubquery(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class WithExprColumnContext extends WithExprContext {
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public AS(): TerminalNode { return this.getToken(TRQLParser.AS, 0); }
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	constructor(ctx: WithExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitWithExprColumn) {
			return visitor.visitWithExprColumn(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class ColumnIdentifierContext extends ParserRuleContext {
	public placeholder(): PlaceholderContext | undefined {
		return this.tryGetRuleContext(0, PlaceholderContext);
	}
	public nestedIdentifier(): NestedIdentifierContext | undefined {
		return this.tryGetRuleContext(0, NestedIdentifierContext);
	}
	public tableIdentifier(): TableIdentifierContext | undefined {
		return this.tryGetRuleContext(0, TableIdentifierContext);
	}
	public DOT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DOT, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_columnIdentifier; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitColumnIdentifier) {
			return visitor.visitColumnIdentifier(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class NestedIdentifierContext extends ParserRuleContext {
	public identifier(): IdentifierContext[];
	public identifier(i: number): IdentifierContext;
	public identifier(i?: number): IdentifierContext | IdentifierContext[] {
		if (i === undefined) {
			return this.getRuleContexts(IdentifierContext);
		} else {
			return this.getRuleContext(i, IdentifierContext);
		}
	}
	public DOT(): TerminalNode[];
	public DOT(i: number): TerminalNode;
	public DOT(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.DOT);
		} else {
			return this.getToken(TRQLParser.DOT, i);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_nestedIdentifier; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitNestedIdentifier) {
			return visitor.visitNestedIdentifier(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TableExprContext extends ParserRuleContext {
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_tableExpr; }
	public copyFrom(ctx: TableExprContext): void {
		super.copyFrom(ctx);
	}
}
export class TableExprIdentifierContext extends TableExprContext {
	public tableIdentifier(): TableIdentifierContext {
		return this.getRuleContext(0, TableIdentifierContext);
	}
	constructor(ctx: TableExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTableExprIdentifier) {
			return visitor.visitTableExprIdentifier(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class TableExprFunctionContext extends TableExprContext {
	public tableFunctionExpr(): TableFunctionExprContext {
		return this.getRuleContext(0, TableFunctionExprContext);
	}
	constructor(ctx: TableExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTableExprFunction) {
			return visitor.visitTableExprFunction(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class TableExprSubqueryContext extends TableExprContext {
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public selectSetStmt(): SelectSetStmtContext {
		return this.getRuleContext(0, SelectSetStmtContext);
	}
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	constructor(ctx: TableExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTableExprSubquery) {
			return visitor.visitTableExprSubquery(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class TableExprAliasContext extends TableExprContext {
	public tableExpr(): TableExprContext {
		return this.getRuleContext(0, TableExprContext);
	}
	public alias(): AliasContext | undefined {
		return this.tryGetRuleContext(0, AliasContext);
	}
	public AS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.AS, 0); }
	public identifier(): IdentifierContext | undefined {
		return this.tryGetRuleContext(0, IdentifierContext);
	}
	constructor(ctx: TableExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTableExprAlias) {
			return visitor.visitTableExprAlias(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class TableExprTagContext extends TableExprContext {
	public tRQLxTagElement(): TRQLxTagElementContext {
		return this.getRuleContext(0, TRQLxTagElementContext);
	}
	constructor(ctx: TableExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTableExprTag) {
			return visitor.visitTableExprTag(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}
export class TableExprPlaceholderContext extends TableExprContext {
	public placeholder(): PlaceholderContext {
		return this.getRuleContext(0, PlaceholderContext);
	}
	constructor(ctx: TableExprContext) {
		super(ctx.parent, ctx.invokingState);
		this.copyFrom(ctx);
	}
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTableExprPlaceholder) {
			return visitor.visitTableExprPlaceholder(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TableFunctionExprContext extends ParserRuleContext {
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	public LPAREN(): TerminalNode { return this.getToken(TRQLParser.LPAREN, 0); }
	public RPAREN(): TerminalNode { return this.getToken(TRQLParser.RPAREN, 0); }
	public tableArgList(): TableArgListContext | undefined {
		return this.tryGetRuleContext(0, TableArgListContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_tableFunctionExpr; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTableFunctionExpr) {
			return visitor.visitTableFunctionExpr(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TableIdentifierContext extends ParserRuleContext {
	public nestedIdentifier(): NestedIdentifierContext {
		return this.getRuleContext(0, NestedIdentifierContext);
	}
	public databaseIdentifier(): DatabaseIdentifierContext | undefined {
		return this.tryGetRuleContext(0, DatabaseIdentifierContext);
	}
	public DOT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DOT, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_tableIdentifier; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTableIdentifier) {
			return visitor.visitTableIdentifier(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TableArgListContext extends ParserRuleContext {
	public columnExpr(): ColumnExprContext[];
	public columnExpr(i: number): ColumnExprContext;
	public columnExpr(i?: number): ColumnExprContext | ColumnExprContext[] {
		if (i === undefined) {
			return this.getRuleContexts(ColumnExprContext);
		} else {
			return this.getRuleContext(i, ColumnExprContext);
		}
	}
	public COMMA(): TerminalNode[];
	public COMMA(i: number): TerminalNode;
	public COMMA(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.COMMA);
		} else {
			return this.getToken(TRQLParser.COMMA, i);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_tableArgList; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTableArgList) {
			return visitor.visitTableArgList(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class DatabaseIdentifierContext extends ParserRuleContext {
	public identifier(): IdentifierContext {
		return this.getRuleContext(0, IdentifierContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_databaseIdentifier; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitDatabaseIdentifier) {
			return visitor.visitDatabaseIdentifier(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class FloatingLiteralContext extends ParserRuleContext {
	public FLOATING_LITERAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FLOATING_LITERAL, 0); }
	public DOT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DOT, 0); }
	public DECIMAL_LITERAL(): TerminalNode[];
	public DECIMAL_LITERAL(i: number): TerminalNode;
	public DECIMAL_LITERAL(i?: number): TerminalNode | TerminalNode[] {
		if (i === undefined) {
			return this.getTokens(TRQLParser.DECIMAL_LITERAL);
		} else {
			return this.getToken(TRQLParser.DECIMAL_LITERAL, i);
		}
	}
	public OCTAL_LITERAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.OCTAL_LITERAL, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_floatingLiteral; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitFloatingLiteral) {
			return visitor.visitFloatingLiteral(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class NumberLiteralContext extends ParserRuleContext {
	public floatingLiteral(): FloatingLiteralContext | undefined {
		return this.tryGetRuleContext(0, FloatingLiteralContext);
	}
	public OCTAL_LITERAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.OCTAL_LITERAL, 0); }
	public DECIMAL_LITERAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DECIMAL_LITERAL, 0); }
	public HEXADECIMAL_LITERAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.HEXADECIMAL_LITERAL, 0); }
	public INF(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.INF, 0); }
	public NAN_SQL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.NAN_SQL, 0); }
	public PLUS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.PLUS, 0); }
	public DASH(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DASH, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_numberLiteral; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitNumberLiteral) {
			return visitor.visitNumberLiteral(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class LiteralContext extends ParserRuleContext {
	public numberLiteral(): NumberLiteralContext | undefined {
		return this.tryGetRuleContext(0, NumberLiteralContext);
	}
	public STRING_LITERAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.STRING_LITERAL, 0); }
	public NULL_SQL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.NULL_SQL, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_literal; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitLiteral) {
			return visitor.visitLiteral(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class IntervalContext extends ParserRuleContext {
	public SECOND(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SECOND, 0); }
	public MINUTE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.MINUTE, 0); }
	public HOUR(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.HOUR, 0); }
	public DAY(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DAY, 0); }
	public WEEK(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.WEEK, 0); }
	public MONTH(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.MONTH, 0); }
	public QUARTER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.QUARTER, 0); }
	public YEAR(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.YEAR, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_interval; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitInterval) {
			return visitor.visitInterval(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class KeywordContext extends ParserRuleContext {
	public ALL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ALL, 0); }
	public AND(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.AND, 0); }
	public ANTI(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ANTI, 0); }
	public ANY(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ANY, 0); }
	public ARRAY(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ARRAY, 0); }
	public AS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.AS, 0); }
	public ASCENDING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ASCENDING, 0); }
	public ASOF(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ASOF, 0); }
	public BETWEEN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.BETWEEN, 0); }
	public BOTH(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.BOTH, 0); }
	public BY(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.BY, 0); }
	public CASE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.CASE, 0); }
	public CAST(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.CAST, 0); }
	public COHORT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.COHORT, 0); }
	public COLLATE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.COLLATE, 0); }
	public CROSS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.CROSS, 0); }
	public CUBE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.CUBE, 0); }
	public CURRENT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.CURRENT, 0); }
	public DATE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DATE, 0); }
	public DESC(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DESC, 0); }
	public DESCENDING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DESCENDING, 0); }
	public DISTINCT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DISTINCT, 0); }
	public ELSE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ELSE, 0); }
	public END(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.END, 0); }
	public EXTRACT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.EXTRACT, 0); }
	public FINAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FINAL, 0); }
	public FIRST(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FIRST, 0); }
	public FOR(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FOR, 0); }
	public FOLLOWING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FOLLOWING, 0); }
	public FROM(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FROM, 0); }
	public FULL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FULL, 0); }
	public GROUP(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.GROUP, 0); }
	public HAVING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.HAVING, 0); }
	public ID(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ID, 0); }
	public IS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.IS, 0); }
	public IF(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.IF, 0); }
	public ILIKE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ILIKE, 0); }
	public IN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.IN, 0); }
	public INNER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.INNER, 0); }
	public INTERVAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.INTERVAL, 0); }
	public JOIN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.JOIN, 0); }
	public KEY(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.KEY, 0); }
	public LAST(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LAST, 0); }
	public LEADING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LEADING, 0); }
	public LEFT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LEFT, 0); }
	public LIKE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LIKE, 0); }
	public LIMIT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.LIMIT, 0); }
	public NOT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.NOT, 0); }
	public NULLS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.NULLS, 0); }
	public OFFSET(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.OFFSET, 0); }
	public ON(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ON, 0); }
	public OR(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.OR, 0); }
	public ORDER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ORDER, 0); }
	public OUTER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.OUTER, 0); }
	public OVER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.OVER, 0); }
	public PARTITION(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.PARTITION, 0); }
	public PRECEDING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.PRECEDING, 0); }
	public PREWHERE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.PREWHERE, 0); }
	public RANGE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RANGE, 0); }
	public RETURN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RETURN, 0); }
	public RIGHT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RIGHT, 0); }
	public ROLLUP(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ROLLUP, 0); }
	public ROW(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ROW, 0); }
	public ROWS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ROWS, 0); }
	public SAMPLE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SAMPLE, 0); }
	public SELECT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SELECT, 0); }
	public SEMI(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SEMI, 0); }
	public SETTINGS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SETTINGS, 0); }
	public SUBSTRING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.SUBSTRING, 0); }
	public THEN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.THEN, 0); }
	public TIES(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TIES, 0); }
	public TIMESTAMP(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TIMESTAMP, 0); }
	public TOTALS(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TOTALS, 0); }
	public TRAILING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TRAILING, 0); }
	public TRIM(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TRIM, 0); }
	public TRUNCATE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TRUNCATE, 0); }
	public TO(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TO, 0); }
	public TOP(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.TOP, 0); }
	public UNBOUNDED(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.UNBOUNDED, 0); }
	public UNION(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.UNION, 0); }
	public USING(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.USING, 0); }
	public WHEN(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.WHEN, 0); }
	public WHERE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.WHERE, 0); }
	public WINDOW(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.WINDOW, 0); }
	public WITH(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.WITH, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_keyword; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitKeyword) {
			return visitor.visitKeyword(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class KeywordForAliasContext extends ParserRuleContext {
	public DATE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.DATE, 0); }
	public FIRST(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FIRST, 0); }
	public ID(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.ID, 0); }
	public KEY(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.KEY, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_keywordForAlias; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitKeywordForAlias) {
			return visitor.visitKeywordForAlias(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class AliasContext extends ParserRuleContext {
	public IDENTIFIER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.IDENTIFIER, 0); }
	public keywordForAlias(): KeywordForAliasContext | undefined {
		return this.tryGetRuleContext(0, KeywordForAliasContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_alias; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitAlias) {
			return visitor.visitAlias(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class IdentifierContext extends ParserRuleContext {
	public IDENTIFIER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.IDENTIFIER, 0); }
	public interval(): IntervalContext | undefined {
		return this.tryGetRuleContext(0, IntervalContext);
	}
	public keyword(): KeywordContext | undefined {
		return this.tryGetRuleContext(0, KeywordContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_identifier; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitIdentifier) {
			return visitor.visitIdentifier(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class EnumValueContext extends ParserRuleContext {
	public string(): StringContext {
		return this.getRuleContext(0, StringContext);
	}
	public EQ_SINGLE(): TerminalNode { return this.getToken(TRQLParser.EQ_SINGLE, 0); }
	public numberLiteral(): NumberLiteralContext {
		return this.getRuleContext(0, NumberLiteralContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_enumValue; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitEnumValue) {
			return visitor.visitEnumValue(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class PlaceholderContext extends ParserRuleContext {
	public LBRACE(): TerminalNode { return this.getToken(TRQLParser.LBRACE, 0); }
	public columnExpr(): ColumnExprContext {
		return this.getRuleContext(0, ColumnExprContext);
	}
	public RBRACE(): TerminalNode { return this.getToken(TRQLParser.RBRACE, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_placeholder; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitPlaceholder) {
			return visitor.visitPlaceholder(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class StringContext extends ParserRuleContext {
	public STRING_LITERAL(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.STRING_LITERAL, 0); }
	public templateString(): TemplateStringContext | undefined {
		return this.tryGetRuleContext(0, TemplateStringContext);
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_string; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitString) {
			return visitor.visitString(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class TemplateStringContext extends ParserRuleContext {
	public QUOTE_SINGLE_TEMPLATE(): TerminalNode { return this.getToken(TRQLParser.QUOTE_SINGLE_TEMPLATE, 0); }
	public QUOTE_SINGLE(): TerminalNode { return this.getToken(TRQLParser.QUOTE_SINGLE, 0); }
	public stringContents(): StringContentsContext[];
	public stringContents(i: number): StringContentsContext;
	public stringContents(i?: number): StringContentsContext | StringContentsContext[] {
		if (i === undefined) {
			return this.getRuleContexts(StringContentsContext);
		} else {
			return this.getRuleContext(i, StringContentsContext);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_templateString; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitTemplateString) {
			return visitor.visitTemplateString(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class StringContentsContext extends ParserRuleContext {
	public STRING_ESCAPE_TRIGGER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.STRING_ESCAPE_TRIGGER, 0); }
	public columnExpr(): ColumnExprContext | undefined {
		return this.tryGetRuleContext(0, ColumnExprContext);
	}
	public RBRACE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RBRACE, 0); }
	public STRING_TEXT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.STRING_TEXT, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_stringContents; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitStringContents) {
			return visitor.visitStringContents(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class FullTemplateStringContext extends ParserRuleContext {
	public QUOTE_SINGLE_TEMPLATE_FULL(): TerminalNode { return this.getToken(TRQLParser.QUOTE_SINGLE_TEMPLATE_FULL, 0); }
	public EOF(): TerminalNode { return this.getToken(TRQLParser.EOF, 0); }
	public stringContentsFull(): StringContentsFullContext[];
	public stringContentsFull(i: number): StringContentsFullContext;
	public stringContentsFull(i?: number): StringContentsFullContext | StringContentsFullContext[] {
		if (i === undefined) {
			return this.getRuleContexts(StringContentsFullContext);
		} else {
			return this.getRuleContext(i, StringContentsFullContext);
		}
	}
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_fullTemplateString; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitFullTemplateString) {
			return visitor.visitFullTemplateString(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


export class StringContentsFullContext extends ParserRuleContext {
	public FULL_STRING_ESCAPE_TRIGGER(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FULL_STRING_ESCAPE_TRIGGER, 0); }
	public columnExpr(): ColumnExprContext | undefined {
		return this.tryGetRuleContext(0, ColumnExprContext);
	}
	public RBRACE(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.RBRACE, 0); }
	public FULL_STRING_TEXT(): TerminalNode | undefined { return this.tryGetToken(TRQLParser.FULL_STRING_TEXT, 0); }
	constructor(parent: ParserRuleContext | undefined, invokingState: number) {
		super(parent, invokingState);
	}
	// @Override
	public get ruleIndex(): number { return TRQLParser.RULE_stringContentsFull; }
	// @Override
	public accept<Result>(visitor: TRQLParserVisitor<Result>): Result {
		if (visitor.visitStringContentsFull) {
			return visitor.visitStringContentsFull(this);
		} else {
			return visitor.visitChildren(this);
		}
	}
}


