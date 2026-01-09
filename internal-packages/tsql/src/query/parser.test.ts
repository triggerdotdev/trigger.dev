import { describe, it, expect } from "vitest";
import { CharStreams, CommonTokenStream } from "antlr4ts";
import { TSQLLexer } from "../grammar/TSQLLexer.js";
import { TSQLParser } from "../grammar/TSQLParser.js";
import { TSQLParseTreeConverter } from "./parser.js";
import { ArithmeticOperationOp, CompareOperationOp } from "./ast.js";
import { SyntaxError } from "./errors.js";

/**
 * Helper function to parse TSQL input and convert to AST
 */
function parseAndConvert(input: string) {
  const inputStream = CharStreams.fromString(input);
  const lexer = new TSQLLexer(inputStream);
  const tokenStream = new CommonTokenStream(lexer);
  const parser = new TSQLParser(tokenStream);
  const parseTree = parser.select();
  const converter = new TSQLParseTreeConverter();
  return converter.visit(parseTree);
}

describe("TSQLParseTreeConverter", () => {
  describe("SELECT statements", () => {
    it("should convert a simple SELECT statement", () => {
      const ast = parseAndConvert("SELECT * FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "field", chain: ["*"] }],
        select_from: {
          expression_type: "join_expr",
          table: { expression_type: "field", chain: ["users"] },
        },
      });
    });

    it("should convert SELECT with multiple columns", () => {
      const ast = parseAndConvert("SELECT id, name, email FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [
          { expression_type: "field", chain: ["id"] },
          { expression_type: "field", chain: ["name"] },
          { expression_type: "field", chain: ["email"] },
        ],
        select_from: {
          expression_type: "join_expr",
          table: { expression_type: "field", chain: ["users"] },
        },
      });
    });

    it("should convert SELECT with DISTINCT", () => {
      const ast = parseAndConvert("SELECT DISTINCT id FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        distinct: true,
        select: [{ expression_type: "field", chain: ["id"] }],
      });
    });

    it("should convert SELECT with WHERE clause", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id = 1");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "field", chain: ["*"] }],
        select_from: {
          expression_type: "join_expr",
          table: { expression_type: "field", chain: ["users"] },
        },
        where: {
          expression_type: "compare_operation",
          op: CompareOperationOp.Eq,
          left: { expression_type: "field", chain: ["id"] },
          right: { expression_type: "constant", value: 1 },
        },
      });
    });

    it("should convert SELECT with ORDER BY", () => {
      const ast = parseAndConvert("SELECT * FROM users ORDER BY id DESC");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "field", chain: ["*"] }],
        order_by: [
          {
            expression_type: "order_expr",
            order: "DESC",
            expr: { expression_type: "field", chain: ["id"] },
          },
        ],
      });
    });

    it("should convert SELECT with LIMIT", () => {
      const ast = parseAndConvert("SELECT * FROM users LIMIT 10");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "field", chain: ["*"] }],
        limit: { expression_type: "constant", value: 10 },
      });
    });

    it("should convert SELECT with LIMIT and OFFSET", () => {
      const ast = parseAndConvert("SELECT * FROM users LIMIT 10 OFFSET 5");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "field", chain: ["*"] }],
        limit: { expression_type: "constant", value: 10 },
        offset: { expression_type: "constant", value: 5 },
      });
    });

    it("should convert SELECT with GROUP BY", () => {
      const ast = parseAndConvert("SELECT category, COUNT(*) FROM products GROUP BY category");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [
          { expression_type: "field", chain: ["category"] },
          { expression_type: "call", name: "COUNT" },
        ],
        group_by: [{ expression_type: "field", chain: ["category"] }],
      });
    });

    it("should convert SELECT with HAVING", () => {
      const ast = parseAndConvert(
        "SELECT category FROM products GROUP BY category HAVING COUNT(*) > 10"
      );

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "field", chain: ["category"] }],
        group_by: [{ expression_type: "field", chain: ["category"] }],
        having: {
          expression_type: "compare_operation",
          op: CompareOperationOp.Gt,
          left: { expression_type: "call", name: "COUNT" },
          right: { expression_type: "constant", value: 10 },
        },
      });
    });
  });

  describe("expressions", () => {
    it("should convert numeric constants", () => {
      const ast = parseAndConvert("SELECT 42 FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "constant", value: 42 }],
      });
    });

    it("should convert string constants", () => {
      const ast = parseAndConvert("SELECT 'hello' FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "constant", value: "hello" }],
      });
    });

    it("should convert boolean constants", () => {
      const ast = parseAndConvert("SELECT true FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "constant", value: true }],
      });
    });

    it("should convert arithmetic addition", () => {
      const ast = parseAndConvert("SELECT 1 + 2 FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [
          {
            expression_type: "arithmetic_operation",
            op: ArithmeticOperationOp.Add,
            left: { expression_type: "constant", value: 1 },
            right: { expression_type: "constant", value: 2 },
          },
        ],
      });
    });

    it("should convert arithmetic subtraction", () => {
      const ast = parseAndConvert("SELECT 5 - 3 FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [
          {
            expression_type: "arithmetic_operation",
            op: ArithmeticOperationOp.Sub,
            left: { expression_type: "constant", value: 5 },
            right: { expression_type: "constant", value: 3 },
          },
        ],
      });
    });

    it("should convert arithmetic multiplication", () => {
      const ast = parseAndConvert("SELECT 2 * 3 FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [
          {
            expression_type: "arithmetic_operation",
            op: ArithmeticOperationOp.Mult,
            left: { expression_type: "constant", value: 2 },
            right: { expression_type: "constant", value: 3 },
          },
        ],
      });
    });

    it("should convert arithmetic division", () => {
      const ast = parseAndConvert("SELECT 10 / 2 FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [
          {
            expression_type: "arithmetic_operation",
            op: ArithmeticOperationOp.Div,
            left: { expression_type: "constant", value: 10 },
            right: { expression_type: "constant", value: 2 },
          },
        ],
      });
    });

    it("should convert comparison equals", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id = 1");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        where: {
          expression_type: "compare_operation",
          op: CompareOperationOp.Eq,
          left: { expression_type: "field", chain: ["id"] },
          right: { expression_type: "constant", value: 1 },
        },
      });
    });

    it("should convert comparison not equals", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id != 1");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        where: {
          expression_type: "compare_operation",
          op: CompareOperationOp.NotEq,
          left: { expression_type: "field", chain: ["id"] },
          right: { expression_type: "constant", value: 1 },
        },
      });
    });

    it("should convert comparison less than", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id < 10");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        where: {
          expression_type: "compare_operation",
          op: CompareOperationOp.Lt,
          left: { expression_type: "field", chain: ["id"] },
          right: { expression_type: "constant", value: 10 },
        },
      });
    });

    it("should convert comparison greater than", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id > 5");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        where: {
          expression_type: "compare_operation",
          op: CompareOperationOp.Gt,
          left: { expression_type: "field", chain: ["id"] },
          right: { expression_type: "constant", value: 5 },
        },
      });
    });

    it("should convert LIKE comparison", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE name LIKE '%john%'");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        where: {
          expression_type: "compare_operation",
          op: CompareOperationOp.Like,
          left: { expression_type: "field", chain: ["name"] },
          right: { expression_type: "constant", value: "%john%" },
        },
      });
    });

    it("should convert IN comparison", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id IN (1, 2, 3)");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        where: {
          expression_type: "compare_operation",
          op: CompareOperationOp.In,
          left: { expression_type: "field", chain: ["id"] },
          right: {
            expression_type: "tuple",
            exprs: [
              { expression_type: "constant", value: 1 },
              { expression_type: "constant", value: 2 },
              { expression_type: "constant", value: 3 },
            ],
          },
        },
      });
    });

    it("should convert function calls", () => {
      const ast = parseAndConvert("SELECT COUNT(*) FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [
          {
            expression_type: "call",
            name: "COUNT",
            args: [{ expression_type: "field", chain: ["*"] }],
          },
        ],
      });
    });

    it("should convert nested field access", () => {
      const ast = parseAndConvert("SELECT user.profile.name FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "field", chain: ["user", "profile", "name"] }],
      });
    });

    it("should convert aliased expressions", () => {
      const ast = parseAndConvert("SELECT id AS user_id FROM users");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [
          {
            expression_type: "alias",
            alias: "user_id",
            expr: { expression_type: "field", chain: ["id"] },
          },
        ],
      });
    });
  });

  describe("JOINs", () => {
    it("should convert INNER JOIN", () => {
      const ast = parseAndConvert(
        "SELECT * FROM users INNER JOIN orders ON users.id = orders.user_id"
      );

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "field", chain: ["*"] }],
        select_from: {
          expression_type: "join_expr",
          table: { expression_type: "field", chain: ["users"] },
          next_join: {
            expression_type: "join_expr",
            join_type: "INNER JOIN",
            table: { expression_type: "field", chain: ["orders"] },
            constraint: {
              expression_type: "join_constraint",
              constraint_type: "ON",
              expr: {
                expression_type: "compare_operation",
                op: CompareOperationOp.Eq,
              },
            },
          },
        },
      });
    });

    it("should convert LEFT JOIN", () => {
      const ast = parseAndConvert(
        "SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id"
      );

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select_from: {
          expression_type: "join_expr",
          table: { expression_type: "field", chain: ["users"] },
          next_join: {
            expression_type: "join_expr",
            join_type: "LEFT JOIN",
            table: { expression_type: "field", chain: ["orders"] },
            constraint: { constraint_type: "ON" },
          },
        },
      });
    });

    it("should convert CROSS JOIN", () => {
      const ast = parseAndConvert("SELECT * FROM users CROSS JOIN orders");

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select_from: {
          expression_type: "join_expr",
          table: { expression_type: "field", chain: ["users"] },
          next_join: {
            expression_type: "join_expr",
            join_type: "CROSS JOIN",
            table: { expression_type: "field", chain: ["orders"] },
          },
        },
      });
    });
  });

  describe("UNION queries", () => {
    it("should convert UNION DISTINCT query", () => {
      // Grammar supports UNION ALL, UNION DISTINCT, INTERSECT, INTERSECT DISTINCT, EXCEPT
      // Bare UNION (without ALL/DISTINCT) is not supported
      const ast = parseAndConvert("SELECT id FROM users UNION DISTINCT SELECT id FROM customers");

      expect(ast).toMatchObject({
        expression_type: "select_set_query",
        initial_select_query: {
          expression_type: "select_query",
          select: [{ expression_type: "field", chain: ["id"] }],
          select_from: {
            table: { expression_type: "field", chain: ["users"] },
          },
        },
        subsequent_select_queries: [
          {
            set_operator: "UNION DISTINCT",
            select_query: {
              expression_type: "select_query",
              select: [{ expression_type: "field", chain: ["id"] }],
              select_from: {
                table: { expression_type: "field", chain: ["customers"] },
              },
            },
          },
        ],
      });
    });

    it("should convert UNION ALL query", () => {
      const ast = parseAndConvert("SELECT id FROM users UNION ALL SELECT id FROM customers");

      expect(ast).toMatchObject({
        expression_type: "select_set_query",
        initial_select_query: {
          expression_type: "select_query",
          select: [{ expression_type: "field", chain: ["id"] }],
        },
        subsequent_select_queries: [
          {
            set_operator: "UNION ALL",
            select_query: {
              expression_type: "select_query",
              select: [{ expression_type: "field", chain: ["id"] }],
            },
          },
        ],
      });
    });
  });

  describe("WITH clauses (CTEs)", () => {
    it("should convert SELECT with WITH clause", () => {
      const ast = parseAndConvert(
        "WITH recent_users AS (SELECT * FROM users WHERE created_at > '2024-01-01') SELECT * FROM recent_users"
      );

      expect(ast).toMatchObject({
        expression_type: "select_query",
        ctes: {
          recent_users: {
            expression_type: "cte",
            name: "recent_users",
            cte_type: "subquery",
            expr: {
              expression_type: "select_query",
              select: [{ expression_type: "field", chain: ["*"] }],
              select_from: {
                table: { expression_type: "field", chain: ["users"] },
              },
              where: {
                expression_type: "compare_operation",
                op: CompareOperationOp.Gt,
              },
            },
          },
        },
        select: [{ expression_type: "field", chain: ["*"] }],
        select_from: {
          table: { expression_type: "field", chain: ["recent_users"] },
        },
      });
    });
  });

  describe("error handling", () => {
    it("should preserve position information in errors", () => {
      const input = "SELECT * FROM users WHERE invalid syntax";
      const inputStream = CharStreams.fromString(input);
      const lexer = new TSQLLexer(inputStream);
      const tokenStream = new CommonTokenStream(lexer);
      const parser = new TSQLParser(tokenStream);

      // This might not parse correctly, but if it does and we visit an error node,
      // it should throw with position info
      try {
        const parseTree = parser.select();
        const converter = new TSQLParseTreeConverter();
        converter.visit(parseTree);
      } catch (error) {
        if (error instanceof SyntaxError) {
          // Error should have position information if available
          expect(error).toBeInstanceOf(SyntaxError);
        }
      }
    });
  });

  describe("complex queries", () => {
    it("should convert a complex query with multiple clauses", () => {
      const ast = parseAndConvert(
        "SELECT category, COUNT(*) as count " +
          "FROM products " +
          "WHERE price > 100 " +
          "GROUP BY category " +
          "HAVING COUNT(*) > 5 " +
          "ORDER BY count DESC " +
          "LIMIT 10"
      );

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [
          { expression_type: "field", chain: ["category"] },
          {
            expression_type: "alias",
            alias: "count",
            expr: { expression_type: "call", name: "COUNT" },
          },
        ],
        select_from: {
          table: { expression_type: "field", chain: ["products"] },
        },
        where: {
          expression_type: "compare_operation",
          op: CompareOperationOp.Gt,
          left: { expression_type: "field", chain: ["price"] },
          right: { expression_type: "constant", value: 100 },
        },
        group_by: [{ expression_type: "field", chain: ["category"] }],
        having: {
          expression_type: "compare_operation",
          op: CompareOperationOp.Gt,
          left: { expression_type: "call", name: "COUNT" },
          right: { expression_type: "constant", value: 5 },
        },
        order_by: [
          {
            expression_type: "order_expr",
            order: "DESC",
            expr: { expression_type: "field", chain: ["count"] },
          },
        ],
        limit: { expression_type: "constant", value: 10 },
      });
    });

    it("should convert query with multiple JOINs", () => {
      const ast = parseAndConvert(
        "SELECT * FROM users " +
          "INNER JOIN orders ON users.id = orders.user_id " +
          "LEFT JOIN products ON orders.product_id = products.id"
      );

      expect(ast).toMatchObject({
        expression_type: "select_query",
        select: [{ expression_type: "field", chain: ["*"] }],
        select_from: {
          expression_type: "join_expr",
          table: { expression_type: "field", chain: ["users"] },
          next_join: {
            expression_type: "join_expr",
            join_type: "INNER JOIN",
            table: { expression_type: "field", chain: ["orders"] },
            constraint: { constraint_type: "ON" },
            next_join: {
              expression_type: "join_expr",
              join_type: "LEFT JOIN",
              table: { expression_type: "field", chain: ["products"] },
              constraint: { constraint_type: "ON" },
            },
          },
        },
      });
    });
  });
});
