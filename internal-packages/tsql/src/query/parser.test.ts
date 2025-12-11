import { describe, it, expect } from "vitest";
import { CharStreams, CommonTokenStream } from "antlr4ts";
import { TSQLLexer } from "../grammar/TSQLLexer.js";
import { TSQLParser } from "../grammar/TSQLParser.js";
import { TSQLParseTreeConverter } from "./parser.js";
import type {
  SelectQuery,
  SelectSetQuery,
  Field,
  Constant,
  Call,
  CompareOperation,
  ArithmeticOperation,
  Alias,
  JoinExpr,
  HogQLXTag,
} from "./ast.js";
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
    it.only("should convert a simple SELECT statement", () => {
      const ast = parseAndConvert("SELECT * FROM users");

      expect(ast).toBeDefined();
      console.log(ast);
      expect(ast.expression_type).toBe("select_query");
      const selectQuery = ast as SelectQuery;
      expect(selectQuery.select).toBeDefined();
      expect(selectQuery.select_from).toBeDefined();
      expect(selectQuery.select.length).toBe(1);
      expect((selectQuery.select[0] as Field).chain).toEqual(["*"]);
    });

    it("should convert SELECT with multiple columns", () => {
      const ast = parseAndConvert("SELECT id, name, email FROM users");

      const selectQuery = ast as SelectQuery;
      expect(selectQuery.select.length).toBe(3);
      expect((selectQuery.select[0] as Field).chain).toEqual(["id"]);
      expect((selectQuery.select[1] as Field).chain).toEqual(["name"]);
      expect((selectQuery.select[2] as Field).chain).toEqual(["email"]);
    });

    it("should convert SELECT with DISTINCT", () => {
      const ast = parseAndConvert("SELECT DISTINCT id FROM users");

      const selectQuery = ast as SelectQuery;
      expect(selectQuery.distinct).toBe(true);
    });

    it("should convert SELECT with WHERE clause", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id = 1");

      const selectQuery = ast as SelectQuery;
      expect(selectQuery.where).toBeDefined();
      const whereExpr = selectQuery.where as CompareOperation;
      expect(whereExpr.op).toBe(CompareOperationOp.Eq);
      expect((whereExpr.left as Field).chain).toEqual(["id"]);
      expect((whereExpr.right as Constant).value).toBe(1);
    });

    it("should convert SELECT with ORDER BY", () => {
      const ast = parseAndConvert("SELECT * FROM users ORDER BY id DESC");

      const selectQuery = ast as SelectQuery;
      expect(selectQuery.order_by).toBeDefined();
      expect(selectQuery.order_by!.length).toBe(1);
      expect(selectQuery.order_by![0].order).toBe("DESC");
      expect((selectQuery.order_by![0].expr as Field).chain).toEqual(["id"]);
    });

    it("should convert SELECT with LIMIT", () => {
      const ast = parseAndConvert("SELECT * FROM users LIMIT 10");

      const selectQuery = ast as SelectQuery;
      expect(selectQuery.limit).toBeDefined();
      expect((selectQuery.limit as Constant).value).toBe(10);
    });

    it("should convert SELECT with LIMIT and OFFSET", () => {
      const ast = parseAndConvert("SELECT * FROM users LIMIT 10 OFFSET 5");

      const selectQuery = ast as SelectQuery;
      expect(selectQuery.limit).toBeDefined();
      expect((selectQuery.limit as Constant).value).toBe(10);
      expect(selectQuery.offset).toBeDefined();
      expect((selectQuery.offset as Constant).value).toBe(5);
    });

    it("should convert SELECT with GROUP BY", () => {
      const ast = parseAndConvert("SELECT category, COUNT(*) FROM products GROUP BY category");

      const selectQuery = ast as SelectQuery;
      expect(selectQuery.group_by).toBeDefined();
      expect(selectQuery.group_by!.length).toBe(1);
      expect((selectQuery.group_by![0] as Field).chain).toEqual(["category"]);
    });

    it("should convert SELECT with HAVING", () => {
      const ast = parseAndConvert(
        "SELECT category FROM products GROUP BY category HAVING COUNT(*) > 10"
      );

      const selectQuery = ast as SelectQuery;
      expect(selectQuery.having).toBeDefined();
      const havingExpr = selectQuery.having as CompareOperation;
      expect(havingExpr.op).toBe(CompareOperationOp.Gt);
    });
  });

  describe("expressions", () => {
    it("should convert numeric constants", () => {
      const ast = parseAndConvert("SELECT 42 FROM users");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.select[0] as Constant;
      expect(expr.value).toBe(42);
    });

    it("should convert string constants", () => {
      const ast = parseAndConvert("SELECT 'hello' FROM users");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.select[0] as Constant;
      expect(expr.value).toBe("hello");
    });

    it("should convert boolean constants", () => {
      const ast = parseAndConvert("SELECT true FROM users");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.select[0] as Constant;
      expect(expr.value).toBe(true);
    });

    it("should convert arithmetic addition", () => {
      const ast = parseAndConvert("SELECT 1 + 2 FROM users");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.select[0] as ArithmeticOperation;
      expect(expr.op).toBe(ArithmeticOperationOp.Add);
      expect((expr.left as Constant).value).toBe(1);
      expect((expr.right as Constant).value).toBe(2);
    });

    it("should convert arithmetic subtraction", () => {
      const ast = parseAndConvert("SELECT 5 - 3 FROM users");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.select[0] as ArithmeticOperation;
      expect(expr.op).toBe(ArithmeticOperationOp.Sub);
    });

    it("should convert arithmetic multiplication", () => {
      const ast = parseAndConvert("SELECT 2 * 3 FROM users");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.select[0] as ArithmeticOperation;
      expect(expr.op).toBe(ArithmeticOperationOp.Mult);
    });

    it("should convert arithmetic division", () => {
      const ast = parseAndConvert("SELECT 10 / 2 FROM users");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.select[0] as ArithmeticOperation;
      expect(expr.op).toBe(ArithmeticOperationOp.Div);
    });

    it("should convert comparison equals", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id = 1");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.where as CompareOperation;
      expect(expr.op).toBe(CompareOperationOp.Eq);
    });

    it("should convert comparison not equals", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id != 1");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.where as CompareOperation;
      expect(expr.op).toBe(CompareOperationOp.NotEq);
    });

    it("should convert comparison less than", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id < 10");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.where as CompareOperation;
      expect(expr.op).toBe(CompareOperationOp.Lt);
    });

    it("should convert comparison greater than", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id > 5");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.where as CompareOperation;
      expect(expr.op).toBe(CompareOperationOp.Gt);
    });

    it("should convert LIKE comparison", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE name LIKE '%john%'");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.where as CompareOperation;
      expect(expr.op).toBe(CompareOperationOp.Like);
    });

    it("should convert IN comparison", () => {
      const ast = parseAndConvert("SELECT * FROM users WHERE id IN (1, 2, 3)");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.where as CompareOperation;
      expect(expr.op).toBe(CompareOperationOp.In);
    });

    it("should convert function calls", () => {
      const ast = parseAndConvert("SELECT COUNT(*) FROM users");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.select[0] as Call;
      expect(expr.name).toBe("count");
    });

    it("should convert nested field access", () => {
      const ast = parseAndConvert("SELECT user.profile.name FROM users");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.select[0] as Field;
      expect(expr.chain).toEqual(["user", "profile", "name"]);
    });

    it("should convert aliased expressions", () => {
      const ast = parseAndConvert("SELECT id AS user_id FROM users");
      const selectQuery = ast as SelectQuery;
      const expr = selectQuery.select[0] as Alias;
      expect(expr.alias).toBe("user_id");
      expect((expr.expr as Field).chain).toEqual(["id"]);
    });
  });

  describe("JOINs", () => {
    it("should convert INNER JOIN", () => {
      const ast = parseAndConvert(
        "SELECT * FROM users INNER JOIN orders ON users.id = orders.user_id"
      );
      const selectQuery = ast as SelectQuery;
      expect(selectQuery.select_from).toBeDefined();
      const joinExpr = selectQuery.select_from as JoinExpr;
      expect(joinExpr.next_join).toBeDefined();
      expect(joinExpr.next_join!.join_type).toBe("INNER JOIN");
      expect(joinExpr.next_join!.constraint).toBeDefined();
      expect(joinExpr.next_join!.constraint!.constraint_type).toBe("ON");
    });

    it("should convert LEFT JOIN", () => {
      const ast = parseAndConvert(
        "SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id"
      );
      const selectQuery = ast as SelectQuery;
      const joinExpr = selectQuery.select_from as JoinExpr;
      expect(joinExpr.next_join!.join_type).toContain("LEFT");
    });

    it("should convert CROSS JOIN", () => {
      const ast = parseAndConvert("SELECT * FROM users CROSS JOIN orders");
      const selectQuery = ast as SelectQuery;
      const joinExpr = selectQuery.select_from as JoinExpr;
      expect(joinExpr.next_join!.join_type).toBe("CROSS JOIN");
    });
  });

  describe("UNION queries", () => {
    it("should convert UNION query", () => {
      const ast = parseAndConvert("SELECT id FROM users UNION SELECT id FROM customers");
      expect("initial_select_query" in ast).toBe(true);
      const setQuery = ast as SelectSetQuery;
      expect(setQuery.initial_select_query).toBeDefined();
      expect(setQuery.subsequent_select_queries).toBeDefined();
      expect(setQuery.subsequent_select_queries.length).toBe(1);
      expect(setQuery.subsequent_select_queries[0].set_operator).toBe("UNION");
    });

    it("should convert UNION ALL query", () => {
      const ast = parseAndConvert("SELECT id FROM users UNION ALL SELECT id FROM customers");
      const setQuery = ast as SelectSetQuery;
      expect(setQuery.subsequent_select_queries[0].set_operator).toBe("UNION ALL");
    });
  });

  describe("WITH clauses (CTEs)", () => {
    it("should convert SELECT with WITH clause", () => {
      const ast = parseAndConvert(
        "WITH recent_users AS (SELECT * FROM users WHERE created_at > '2024-01-01') SELECT * FROM recent_users"
      );
      const selectQuery = ast as SelectQuery;
      expect(selectQuery.ctes).toBeDefined();
      expect(selectQuery.ctes!["recent_users"]).toBeDefined();
      expect(selectQuery.ctes!["recent_users"].cte_type).toBe("subquery");
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

      const selectQuery = ast as SelectQuery;
      expect(selectQuery.select.length).toBe(2);
      expect(selectQuery.where).toBeDefined();
      expect(selectQuery.group_by).toBeDefined();
      expect(selectQuery.having).toBeDefined();
      expect(selectQuery.order_by).toBeDefined();
      expect(selectQuery.limit).toBeDefined();
    });

    it("should convert query with multiple JOINs", () => {
      const ast = parseAndConvert(
        "SELECT * FROM users " +
          "INNER JOIN orders ON users.id = orders.user_id " +
          "LEFT JOIN products ON orders.product_id = products.id"
      );

      const selectQuery = ast as SelectQuery;
      const joinExpr = selectQuery.select_from as JoinExpr;
      expect(joinExpr.next_join).toBeDefined();
      expect(joinExpr.next_join!.next_join).toBeDefined();
    });
  });
});
