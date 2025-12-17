import { CharStreams, CommonTokenStream } from "antlr4ts";
import { TSQLLexer } from "./TSQLLexer.js";
import { TSQLParser } from "./TSQLParser.js";

describe("TSQLParser", () => {
  function parse(input: string) {
    const inputStream = CharStreams.fromString(input);
    const lexer = new TSQLLexer(inputStream);
    const tokenStream = new CommonTokenStream(lexer);
    const parser = new TSQLParser(tokenStream);
    return parser;
  }

  describe("select statements", () => {
    it("should parse a simple SELECT statement", () => {
      const parser = parse("SELECT * FROM users;");
      const tree = parser.select();

      expect(tree).toBeDefined();
      // The select rule can return selectStmt, selectSetStmt, or tSQLxTagElement
      // Most SELECT statements are wrapped in selectSetStmt
      const selectSetStmt = tree.selectSetStmt();
      expect(selectSetStmt).toBeDefined();

      // Get the underlying selectStmt from selectSetStmt -> selectStmtWithParens
      const selectStmtWithParens = selectSetStmt!.selectStmtWithParens();
      const selectStmt = selectStmtWithParens.selectStmt();

      expect(selectStmt).toBeDefined();
      expect(selectStmt!.SELECT()).toBeDefined();
      expect(selectStmt!.columnExprList()).toBeDefined();
      expect(selectStmt!.fromClause()).toBeDefined();
    });

    it("should parse SELECT with WHERE clause", () => {
      const parser = parse("SELECT id, name FROM users WHERE id = 1;");
      const tree = parser.select();

      expect(tree).toBeDefined();
      const selectSetStmt = tree.selectSetStmt();
      const selectStmt = selectSetStmt!.selectStmtWithParens().selectStmt()!;

      expect(selectStmt.whereClause()).toBeDefined();
      expect(selectStmt.whereClause()!.WHERE()).toBeDefined();
      expect(selectStmt.whereClause()!.columnExpr()).toBeDefined();
    });

    it("should parse SELECT with multiple columns", () => {
      const parser = parse("SELECT id, name, email FROM users;");
      const tree = parser.select();

      expect(tree).toBeDefined();
      const selectSetStmt = tree.selectSetStmt();
      const selectStmt = selectSetStmt!.selectStmtWithParens().selectStmt()!;

      const columnList = selectStmt.columnExprList();
      expect(columnList).toBeDefined();
      // columnExprList contains comma-separated expressions
      expect(columnList.columnExpr().length).toBeGreaterThanOrEqual(1);
    });

    it("should parse SELECT with DISTINCT", () => {
      const parser = parse("SELECT DISTINCT id FROM users;");
      const tree = parser.select();

      expect(tree).toBeDefined();
      const selectSetStmt = tree.selectSetStmt();
      const selectStmt = selectSetStmt!.selectStmtWithParens().selectStmt()!;

      expect(selectStmt.DISTINCT()).toBeDefined();
    });
  });

  describe("expressions", () => {
    it("should parse a simple addition expression", () => {
      const parser = parse("1 + 2");
      const tree = parser.expr();

      expect(tree).toBeDefined();
      const columnExpr = tree.columnExpr();
      expect(columnExpr).toBeDefined();
      // Check that the expression has children (the operands and operator)
      expect(columnExpr.text).toBeDefined();
      const text = columnExpr.text;
      expect(text).toContain("1");
      expect(text).toContain("2");
      expect(text).toContain("+");
    });

    it("should parse arithmetic expressions with parentheses", () => {
      const parser = parse("(1 + 2) * 3");
      const tree = parser.expr();

      expect(tree).toBeDefined();
      const columnExpr = tree.columnExpr();
      expect(columnExpr).toBeDefined();
      // The expression should contain the operators
      const text = columnExpr.text;
      expect(text).toContain("+");
      expect(text).toContain("*");
      expect(text).toContain("1");
      expect(text).toContain("2");
      expect(text).toContain("3");
    });

    it("should parse string literals", () => {
      const parser = parse("'hello world'");
      const tree = parser.expr();

      expect(tree).toBeDefined();
      const columnExpr = tree.columnExpr();
      expect(columnExpr).toBeDefined();
      const text = columnExpr.text;
      expect(text).toContain("hello");
      expect(text).toContain("world");
    });

    it("should parse numeric literals", () => {
      const parser = parse("42");
      const tree = parser.expr();

      expect(tree).toBeDefined();
      const columnExpr = tree.columnExpr();
      expect(columnExpr).toBeDefined();
      expect(columnExpr.text).toContain("42");
    });
  });

  describe("program", () => {
    it("should parse an empty program", () => {
      const parser = parse("");
      const tree = parser.program();

      expect(tree).toBeDefined();
      expect(tree.EOF()).toBeDefined();
      expect(tree.declaration().length).toBe(0);
    });

    it("should parse variable declarations", () => {
      const parser = parse("let x := 1");
      const tree = parser.program();

      expect(tree).toBeDefined();
      expect(tree.declaration().length).toBe(1);
      const declaration = tree.declaration(0);

      // Check if it's a varDecl
      const varDecl = declaration.varDecl();
      expect(varDecl).toBeDefined();
      expect(varDecl!.LET()).toBeDefined();
      expect(varDecl!.identifier()).toBeDefined();
      expect(varDecl!.expression()).toBeDefined();
    });

    it("should parse multiple declarations", () => {
      const parser = parse("let x := 1; let y := 2");
      const tree = parser.program();

      expect(tree).toBeDefined();
      // Count only non-empty declarations (varDecl or non-empty statements)
      const varDecls = tree.declaration().filter((d) => d.varDecl() !== undefined);
      expect(varDecls.length).toBe(2);
    });
  });
});
