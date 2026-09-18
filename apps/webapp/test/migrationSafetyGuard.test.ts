import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkMigration,
  parseMigration,
  splitStatements,
} from "../scripts/migrationSafetyGuard.core";

function rules(sql: string): string[] {
  return checkMigration(sql).violations.map((v) => v.rule);
}

describe("splitStatements", () => {
  it("splits on top-level semicolons and records start lines", () => {
    const stmts = splitStatements(
      `-- comment\nALTER TABLE "A" ADD COLUMN "x" TEXT;\n\nCREATE INDEX "i" ON "A"("x");`
    );
    expect(stmts.map((s) => s.line)).toEqual([2, 4]);
    expect(stmts[0].sql).toBe(`ALTER TABLE "A" ADD COLUMN "x" TEXT`);
  });

  it("does not split inside strings, quoted identifiers, comments or dollar quotes", () => {
    const stmts = splitStatements(`
      UPDATE "T" SET "a" = 'x;y', "b;c" = 1; /* a ; b */
      -- trailing ; comment
      DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;
      DO $body$ BEGIN PERFORM 1; END $body$;
      SELECT E'it\\'s; fine';
    `);
    expect(stmts).toHaveLength(4);
    expect(stmts[1].sql.startsWith("DO $$")).toBe(true);
    expect(stmts[1].sql.endsWith("END $$")).toBe(true);
    expect(stmts[3].sql).toBe(`SELECT E'it\\'s; fine'`);
  });

  it("attaches an allow directive to the following statement", () => {
    const stmts = splitStatements(`
      -- migration-guard: allow renames are not idempotent, table is tiny
      ALTER TABLE "A" RENAME COLUMN "x" TO "y";
      ALTER TABLE "A" ADD COLUMN "z" TEXT;
    `);
    expect(stmts[0].allow).toEqual({
      reason: "renames are not idempotent, table is tiny",
      line: 2,
    });
    expect(stmts[1].allow).toBeNull();
  });

  it("attaches a same-line trailing directive to the statement it follows", () => {
    const stmts = splitStatements(
      `ALTER TABLE "A" ADD COLUMN "x" TEXT; -- migration-guard: allow covers x\nALTER TABLE "A" ADD COLUMN "y" TEXT;`
    );
    expect(stmts[0].allow?.reason).toBe("covers x");
    expect(stmts[1].allow).toBeNull();
  });

  it("reports directives attached to no statement: dangling, stacked, or trailing an allowed one", () => {
    const dangling = parseMigration(
      `CREATE TABLE IF NOT EXISTS "A" ("id" TEXT);\n-- migration-guard: allow orphan\n`
    );
    expect(dangling.statements[0].allow).toBeNull();
    expect(dangling.unattachedAllows).toEqual([{ reason: "orphan", line: 2 }]);

    const stacked = parseMigration(
      `-- migration-guard: allow first\n-- migration-guard: allow second\nCREATE TABLE "X" ("id" TEXT);`
    );
    expect(stacked.statements[0].allow?.reason).toBe("second");
    expect(stacked.unattachedAllows).toEqual([{ reason: "first", line: 1 }]);

    const trailing = parseMigration(
      `-- migration-guard: allow a\nCREATE TABLE "X" ("id" TEXT); -- migration-guard: allow b\nCREATE TABLE "Y" ("id" TEXT);`
    );
    expect(trailing.statements[0].allow?.reason).toBe("a");
    expect(trailing.statements[1].allow).toBeNull();
    expect(trailing.unattachedAllows).toEqual([{ reason: "b", line: 2 }]);
  });

  it("keeps line numbers right after an escaped newline in an E-string", () => {
    const stmts = splitStatements(`SELECT E'a\\\nb';\nCREATE TABLE "X" ("id" TEXT);`);
    expect(stmts.map((s) => s.line)).toEqual([1, 3]);
  });

  it("keeps line numbers right across a multi-line block comment", () => {
    const v = checkMigration(
      `ALTER TABLE "T" /* a\nb\nc */\n  ADD COLUMN "x" TEXT,\n  ADD COLUMN "y" TEXT;`
    ).violations;
    expect(v.map((x) => x.line)).toEqual([4, 5]);
  });

  it("recognises a directive on a CRLF-terminated line", () => {
    const stmts = splitStatements(
      `-- migration-guard: allow crlf\r\nCREATE TABLE "X" ("id" TEXT);\r\n`
    );
    expect(stmts[0].allow).toEqual({ reason: "crlf", line: 1 });
  });

  it("attributes a statement that opens with a multi-line quoted token to its first line", () => {
    const stmts = splitStatements(`SELECT 1;\n"weird\nname";\nSELECT 2;`);
    expect(stmts.map((s) => s.line)).toEqual([1, 2, 4]);
  });
});

describe("checkMigration: creates", () => {
  it("requires IF NOT EXISTS on CREATE TABLE", () => {
    expect(
      rules(
        `CREATE TABLE "public"."T" ("id" TEXT NOT NULL, CONSTRAINT "T_pkey" PRIMARY KEY ("id"));`
      )
    ).toEqual(["create-if-not-exists"]);
    expect(rules(`CREATE TABLE IF NOT EXISTS "T" ("id" TEXT NOT NULL);`)).toEqual([]);
  });

  it("requires IF NOT EXISTS on ADD COLUMN, per action", () => {
    const sql = `ALTER TABLE "public"."TaskSchedule"
      ADD COLUMN "defaultWindowDurationSeconds" INTEGER,
      ADD COLUMN IF NOT EXISTS "ok" INTEGER,
      ADD "bare" NUMERIC(10,2) DEFAULT 1;`;
    const v = checkMigration(sql).violations;
    expect(v.map((x) => x.rule)).toEqual(["add-column-if-not-exists", "add-column-if-not-exists"]);
    expect(v[0].message).toContain('"defaultWindowDurationSeconds"');
    expect(v[0].line).toBe(2);
    expect(v[1].message).toContain('"bare"');
    expect(v[1].line).toBe(4);
  });

  it("accepts guarded ADD COLUMN whose default contains commas, parentheses or brackets", () => {
    expect(
      rules(
        `ALTER TABLE "T" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY['a', 'b']::TEXT[], ADD COLUMN IF NOT EXISTS "n" NUMERIC(10,2), ADD COLUMN "flagged" TEXT DEFAULT 'x,y';`
      )
    ).toEqual(["add-column-if-not-exists"]);
  });

  it("honours allow directives inside a DO block and reports violations at the inner line", () => {
    const allowed = checkMigration(
      `DO $$ BEGIN\n-- migration-guard: allow tiny enum\nCREATE TYPE "B" AS ENUM ('y');\nEND $$;`
    );
    expect(allowed.violations).toEqual([]);
    expect(allowed.suppressed).toBe(1);
    expect(rules(`DO $$ BEGIN\n-- migration-guard: allow x\nEND $$;`)).toEqual(["allow-unused"]);
    const located = checkMigration(
      `SELECT 1;\n\n\nDO $$ BEGIN\n\n\n CREATE TYPE "B" AS ENUM ('y');\nEND $$;`
    );
    expect(located.violations.map((v) => [v.line, v.rule])).toEqual([[7, "create-type-guarded"]]);
  });

  it("scopes EXCEPTION handlers to their own block and ignores re-raise-only handlers", () => {
    expect(
      rules(`DO $$ BEGIN
        BEGIN ALTER TABLE "T" ADD CONSTRAINT c CHECK (x > 0); EXCEPTION WHEN duplicate_object THEN NULL; END;
        CREATE TYPE "B" AS ENUM ('y');
      END $$;`)
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(`DO $$ BEGIN CREATE TYPE "B" AS ENUM ('y'); EXCEPTION WHEN OTHERS THEN RAISE; END $$;`)
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1) THEN CREATE INDEX IF NOT EXISTS p ON ONLY "Part"("x"); END IF; END $$;`
      )
    ).toEqual([]);
    expect(
      rules(
        `DO $$ BEGIN CREATE TABLE IF NOT EXISTS "Z" ("id" TEXT); END $$;\nCREATE INDEX IF NOT EXISTS zi ON "Z"("id");`
      )
    ).toEqual([]);
  });

  it("does not mistake CASE arms or re-raising handlers for a guarding EXCEPTION handler", () => {
    expect(
      rules(
        `DO $$ BEGIN CASE WHEN true THEN PERFORM 1; WHEN false THEN PERFORM 2; END CASE; CREATE TYPE "B" AS ENUM ('y'); END $$;`
      )
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `DO $$ BEGIN CREATE TYPE "B" AS ENUM ('y'); EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'boom'; END $$;`
      )
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `DO $$ BEGIN CREATE TYPE "B" AS ENUM ('y'); EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'exists'; END $$;`
      )
    ).toEqual([]);
    const inner = checkMigration(`DO $$ BEGIN CREATE TYPE "B" AS ENUM ('y'); END $$;`)
      .violations[0];
    expect(inner.statement).toBe(`CREATE TYPE "B" AS ENUM ('y')`);
  });

  it("handles labelled blocks, late re-raises, CONCURRENTLY and per-action lines inside DO blocks", () => {
    expect(
      rules(
        `DO $$ BEGIN <<blk>> BEGIN ALTER TABLE "T" ADD CONSTRAINT c CHECK (x > 0); EXCEPTION WHEN duplicate_object THEN NULL; END blk; CREATE TYPE "B" AS ENUM ('y'); END $$;`
      )
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `DO $$ BEGIN CREATE TYPE "B" AS ENUM ('y'); EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'x'; RAISE; END $$;`
      )
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `CREATE TABLE IF NOT EXISTS "N" ("id" TEXT);\nDO $$ BEGIN CREATE INDEX CONCURRENTLY IF NOT EXISTS ni ON "N"("id"); END $$;`
      )
    ).toEqual(["concurrently-in-do-block"]);
    const v = checkMigration(
      `DO $$ BEGIN\nALTER TABLE "T"\n  ADD COLUMN "a" TEXT,\n  ADD COLUMN "b" TEXT;\nEND $$;`
    ).violations;
    expect(v.map((x) => x.line)).toEqual([3, 4]);
  });

  it("only treats IF predicates that read retry state, and handlers that name a duplicate condition, as guards", () => {
    expect(
      rules(`DO $$ BEGIN IF true THEN CREATE TYPE "Status" AS ENUM ('A'); END IF; END $$;`)
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `DO $$ BEGIN IF (SELECT count(*) FROM pg_type WHERE typname = 'Status') = 0 THEN CREATE TYPE "Status" AS ENUM ('A'); END IF; END $$;`
      )
    ).toEqual([]);
    expect(
      rules(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'T' AND column_name = 'x') THEN ALTER TABLE "T" ADD COLUMN "x" TEXT; END IF; END $$;`
      )
    ).toEqual([]);
    expect(
      rules(
        `DO $$ BEGIN CREATE TYPE "Status" AS ENUM ('A'); EXCEPTION WHEN division_by_zero THEN NULL; END $$;`
      )
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `DO $$ BEGIN CREATE TYPE "Status" AS ENUM ('A'); EXCEPTION WHEN OTHERS THEN NULL; END $$;`
      )
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `DO $$ BEGIN CREATE TYPE "Status" AS ENUM ('A'); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;`
      )
    ).toEqual([]);
    expect(
      rules(
        `CREATE TABLE IF NOT EXISTS "N" ("id" TEXT);\nDO $$ BEGIN IF true THEN CREATE INDEX CONCURRENTLY IF NOT EXISTS ni ON "N"("id"); END IF; END $$;`
      )
    ).toEqual(["concurrently-in-do-block"]);
  });

  it("recognises SQLSTATE duplicate handlers and to_regclass predicates, and reports each inner problem once", () => {
    expect(
      rules(
        `DO $$ BEGIN CREATE TYPE "S" AS ENUM ('A'); EXCEPTION WHEN SQLSTATE '42710' THEN NULL; END $$;`
      )
    ).toEqual([]);
    expect(
      rules(
        `DO $$ BEGIN IF to_regclass('public."T"') IS NULL THEN CREATE TABLE "T" ("id" TEXT); END IF; END $$;`
      )
    ).toEqual([]);
    expect(
      rules(`DO $$ BEGIN IF true THEN CREATE INDEX i ON "Existing"("x"); END IF; END $$;`)
    ).toEqual(["create-index-concurrently", "create-index-if-not-exists"]);
    const v = checkMigration(
      `DO $$ BEGIN\nIF true THEN\nALTER TABLE "T"\n  ADD COLUMN "a" TEXT,\n  ADD COLUMN "b" TEXT;\nEND IF;\nEND $$;`
    ).violations;
    expect(v.map((x) => x.line)).toEqual([4, 5]);
  });

  it("handles nested IF headers in one chunk, SQLSTATE function codes and labelled block lines", () => {
    expect(
      rules(
        `DO $$ BEGIN IF true THEN IF true THEN CREATE TYPE "X" AS ENUM ('A'); END IF; END IF; END $$;`
      )
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1) THEN PERFORM 1; ELSE IF true THEN CREATE TYPE "Y" AS ENUM ('A'); END IF; END IF; CREATE TYPE "Z" AS ENUM ('A'); END $$;`
      )
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'x') THEN RAISE NOTICE 'skip'; ELSE CREATE TYPE "X" AS ENUM ('A'); END IF; END $$;`
      )
    ).toEqual([]);
    expect(
      rules(
        `DO $$ DECLARE v int := 1; BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'x') THEN CASE v WHEN 1 THEN PERFORM 1; ELSE PERFORM 2; END CASE; CREATE TYPE "X" AS ENUM ('A'); END IF; END $$;`
      )
    ).toEqual([]);
    expect(
      rules(
        `DO $$ DECLARE v int := 1; BEGIN CASE v WHEN 1 THEN CREATE TYPE "X" AS ENUM ('A'); END CASE; END $$;`
      )
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `ALTER TABLE "T" ADD COLUMN IF NOT EXISTS "c" TEXT DEFAULT E'it\\'s, x', ADD COLUMN "d" INT;`
      )
    ).toEqual(["add-column-if-not-exists"]);
    expect(
      rules(`DO $$ BEGIN DROP FUNCTION f(); EXCEPTION WHEN SQLSTATE '42883' THEN NULL; END $$;`)
    ).toEqual([]);
    const v = checkMigration(
      `DO $$\n<<lbl>>\nBEGIN\n  CREATE TYPE "X" AS ENUM ('A');\nEND $$;`
    ).violations;
    expect(v.map((x) => [x.line, x.rule])).toEqual([[4, "create-type-guarded"]]);
  });

  it("flags a second DDL statement relying on one EXCEPTION handler, and reads single-quoted and unicode-tagged bodies", () => {
    expect(
      rules(
        `DO $$ BEGIN CREATE TYPE "A" AS ENUM ('x'); CREATE TYPE "B" AS ENUM ('y'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
      )
    ).toEqual(["exception-block-multiple-ddl"]);
    expect(
      rules(`DO $$ BEGIN
        BEGIN CREATE TYPE "A" AS ENUM ('x'); EXCEPTION WHEN duplicate_object THEN NULL; END;
        BEGIN CREATE TYPE "B" AS ENUM ('y'); EXCEPTION WHEN duplicate_object THEN NULL; END;
      END $$;`)
    ).toEqual([]);
    expect(rules(`DO 'BEGIN CREATE TYPE "A" AS ENUM (''x''); END';`)).toEqual([
      "create-type-guarded",
    ]);
    expect(rules(`DO $é$ BEGIN CREATE TABLE "T" ("id" INT); END $é$;`)).toEqual([
      "create-if-not-exists",
    ]);
    expect(rules(`ALTER INDEX "p_idx" ATTACH PARTITION "p_2026_idx";`)).toEqual([
      "alter-action-guarded",
    ]);
  });

  it("counts only handler-dependent statements, rejects escape-string bodies, and reads long or unicode-adjacent tags", () => {
    expect(
      rules(
        `DO $$ BEGIN CREATE TABLE IF NOT EXISTS a (id int); CREATE TYPE b AS ENUM ('x'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
      )
    ).toEqual([]);
    expect(rules(`DO E'BEGIN \\x43REATE TYPE "Status" AS ENUM (''A''); END';`)).toEqual([
      "do-body-unsupported",
    ]);
    expect(rules(`DO U&'BEGIN NULL; END';`)).toEqual(["do-body-unsupported"]);
    const tag = "$" + "t".repeat(63) + "$";
    expect(rules(`DO ${tag} BEGIN CREATE TYPE "X" AS ENUM ('A'); END ${tag};`)).toEqual([
      "create-type-guarded",
    ]);
    expect(rules(`SELECT é$body$;\nCREATE TYPE "Status" AS ENUM ('A');\nSELECT é$body$;`)).toEqual([
      "create-type-guarded",
    ]);
  });

  it("checks DO blocks statement by statement", () => {
    expect(rules(`DO $$ BEGIN CREATE TYPE "Status" AS ENUM ('A'); END $$;`)).toEqual([
      "create-type-guarded",
    ]);
    expect(
      rules(
        `DO $$ BEGIN PERFORM 1 FROM pg_type WHERE typname = 'Status'; IF NOT FOUND THEN CREATE TYPE "Status" AS ENUM ('A'); END IF; END $$;`
      )
    ).toEqual([]);
    expect(
      rules(`DO $$ DECLARE r record; BEGIN UPDATE "T" SET "x" = 1 WHERE "x" IS NULL; END $$;`)
    ).toEqual([]);
    expect(rules(`DO $$ BEGIN ALTER TABLE "T" ADD COLUMN IF NOT EXISTS "x" TEXT; END $$;`)).toEqual(
      []
    );
    expect(
      rules(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'A') THEN CREATE TYPE "A" AS ENUM ('x'); END IF;
        CREATE TYPE "B" AS ENUM ('y');
      END $$;`)
    ).toEqual(["create-type-guarded"]);
    expect(
      rules(
        `DO $$ BEGIN CREATE TYPE "A" AS ENUM ('x'); CREATE TYPE "B" AS ENUM ('y'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
      )
    ).toEqual(["exception-block-multiple-ddl"]);
    expect(
      rules(
        `DO $$ BEGIN CREATE INDEX "i" ON "BigTable"("x"); EXCEPTION WHEN duplicate_table THEN NULL; END $$;`
      )
    ).toEqual(["create-index-concurrently"]);
    expect(rules(`DO $$ BEGIN CREATE INDEX "i" ON "BigTable"("x"); END $$;`)).toEqual([
      "create-index-concurrently",
      "create-index-if-not-exists",
    ]);
    expect(
      rules(`
        CREATE TABLE IF NOT EXISTS "Fresh" ("id" TEXT);
        DO $$ BEGIN CREATE INDEX "i" ON "Fresh"("id"); EXCEPTION WHEN duplicate_table THEN NULL; END $$;
      `)
    ).toEqual([]);
  });

  it("requires a DO block for CREATE TYPE and ADD CONSTRAINT", () => {
    expect(rules(`CREATE TYPE "public"."Status" AS ENUM ('A', 'B');`)).toEqual([
      "create-type-guarded",
    ]);
    expect(
      rules(
        `ALTER TABLE "T" ADD CONSTRAINT "T_fk" FOREIGN KEY ("x") REFERENCES "U"("id") ON DELETE CASCADE ON UPDATE CASCADE;`
      )
    ).toEqual(["add-constraint-guarded"]);
    expect(rules(`ALTER TABLE "T" ADD CHECK ("a" > 0) NOT VALID;`)).toEqual([
      "add-constraint-guarded",
    ]);
    expect(
      rules(
        `DO $$ BEGIN CREATE TYPE "Status" AS ENUM ('A'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
      )
    ).toEqual([]);
    expect(
      rules(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'T_fk') THEN
            ALTER TABLE "T" ADD CONSTRAINT "T_fk" FOREIGN KEY ("x") REFERENCES "U"("id");
          END IF;
        END $$;`)
    ).toEqual([]);
  });

  it("accepts DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT of the same name only on a table created in the file", () => {
    const pair = `ALTER TABLE "T" DROP CONSTRAINT IF EXISTS "T_fk", ADD CONSTRAINT "T_fk" FOREIGN KEY ("x") REFERENCES "U"("id");`;
    expect(rules(`CREATE TABLE IF NOT EXISTS "T" ("id" TEXT);\n${pair}`)).toEqual([]);
    expect(rules(pair)).toEqual(["add-constraint-guarded"]);
    expect(
      rules(
        `CREATE TABLE IF NOT EXISTS "T" ("id" TEXT);\nALTER TABLE "T" DROP CONSTRAINT IF EXISTS "other", ADD CONSTRAINT "T_fk" FOREIGN KEY ("x") REFERENCES "U"("id");`
      )
    ).toEqual(["add-constraint-guarded"]);
  });

  it("keys same-file tables by exact case for quoted names and folded case for unquoted ones", () => {
    expect(
      rules(
        `CREATE TABLE IF NOT EXISTS "Foo" ("id" TEXT);\nCREATE INDEX IF NOT EXISTS i ON foo("id");`
      )
    ).toEqual(["create-index-concurrently"]);
    expect(
      rules(
        `CREATE TABLE IF NOT EXISTS foo ("id" TEXT);\nCREATE INDEX IF NOT EXISTS i ON "FOO"("id");`
      )
    ).toEqual(["create-index-concurrently"]);
    expect(
      rules(
        `CREATE TABLE IF NOT EXISTS Foo ("id" TEXT);\nCREATE INDEX IF NOT EXISTS i ON "foo"("id");`
      )
    ).toEqual([]);
  });

  it("keys same-file tables by schema", () => {
    expect(
      rules(
        `CREATE TABLE IF NOT EXISTS "billing"."Foo" ("id" TEXT);\nCREATE INDEX IF NOT EXISTS "i" ON "public"."Foo"("id");`
      )
    ).toEqual(["create-index-concurrently"]);
    expect(
      rules(
        `CREATE TABLE IF NOT EXISTS "Foo" ("id" TEXT);\nCREATE INDEX IF NOT EXISTS "i" ON "public"."Foo"("id");`
      )
    ).toEqual([]);
  });

  it("anchors RENAME to the ALTER grammar", () => {
    expect(rules(`ALTER TABLE "T" ADD COLUMN IF NOT EXISTS rename TEXT;`)).toEqual([]);
    expect(rules(`ALTER TABLE "T" RENAME TO "U";`)).toEqual(["rename-guarded"]);
    expect(
      rules(`ALTER TABLE "T" ADD COLUMN IF NOT EXISTS "x" TEXT, RENAME COLUMN "a" TO "b";`)
    ).toEqual(["rename-guarded"]);
  });

  it("ignores keywords inside string literals and quoted identifiers", () => {
    expect(rules(`ALTER TYPE "Kind" ADD VALUE IF NOT EXISTS 'RENAME';`)).toEqual([]);
    expect(rules(`ALTER TABLE "T" ADD COLUMN IF NOT EXISTS "rename" TEXT;`)).toEqual([]);
    expect(rules(`INSERT INTO "T" ("note") VALUES ('ON CONFLICT');`)).toEqual([
      "insert-on-conflict",
    ]);
  });

  it("flags SET SCHEMA and INHERIT", () => {
    expect(rules(`ALTER TABLE "T" SET SCHEMA "billing";`)).toEqual(["alter-action-guarded"]);
    expect(rules(`ALTER TABLE "C" INHERIT "P";`)).toEqual(["alter-action-guarded"]);
    expect(rules(`ALTER TABLE "C" NO INHERIT "P";`)).toEqual(["alter-action-guarded"]);
  });

  it("flags ATTACH and DETACH PARTITION", () => {
    expect(
      rules(
        `ALTER TABLE "P" ATTACH PARTITION "P_2026" FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');`
      )
    ).toEqual(["alter-action-guarded"]);
    expect(rules(`ALTER TABLE "P" DETACH PARTITION "P_2025";`)).toEqual(["alter-action-guarded"]);
  });

  it("fails closed on CREATE kinds it does not know", () => {
    expect(rules(`CREATE FOREIGN TABLE ft ("id" TEXT) SERVER s;`)).toEqual(["create-unrecognized"]);
  });

  it("treats CREATE POLICY like CREATE TYPE, and CREATE STATISTICS like CREATE SEQUENCE", () => {
    expect(rules(`CREATE POLICY p ON "T" USING (true);`)).toEqual(["create-type-guarded"]);
    expect(rules(`CREATE STATISTICS IF NOT EXISTS s1 ON a, b FROM "T";`)).toEqual([]);
    expect(rules(`CREATE STATISTICS s1 ON a, b FROM "T";`)).toEqual(["create-if-not-exists"]);
  });

  it("requires IF NOT EXISTS on ALTER TYPE ADD VALUE", () => {
    expect(rules(`ALTER TYPE "public"."TaskRunStatus" ADD VALUE 'NEW';`)).toEqual([
      "add-value-if-not-exists",
    ]);
    expect(rules(`ALTER TYPE "TaskRunStatus" ADD VALUE IF NOT EXISTS 'NEW';`)).toEqual([]);
  });

  it("requires IF NOT EXISTS / OR REPLACE on other creatable objects", () => {
    expect(rules(`CREATE SCHEMA "billing";`)).toEqual(["create-if-not-exists"]);
    expect(rules(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`)).toEqual([]);
    expect(rules(`CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;`)).toEqual([
      "create-or-replace",
    ]);
    expect(rules(`CREATE OR REPLACE VIEW v AS SELECT 1;`)).toEqual([]);
  });
});

describe("checkMigration: indexes", () => {
  it("requires CONCURRENTLY IF NOT EXISTS on an index over an existing table", () => {
    expect(rules(`CREATE INDEX "T_x_idx" ON "public"."T"("x");`)).toEqual([
      "create-index-concurrently",
      "create-index-if-not-exists",
    ]);
    expect(
      rules(`CREATE UNIQUE INDEX CONCURRENTLY "T_x_key" ON "T"("x") WHERE "y" IS NULL;`)
    ).toEqual(["create-index-if-not-exists"]);
    expect(
      rules(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "T_x_idx" ON "public"."T"("x", "y" DESC);`)
    ).toEqual([]);
  });

  it("exempts ON ONLY (partitioned parent) indexes from CONCURRENTLY", () => {
    expect(
      rules(`CREATE INDEX IF NOT EXISTS "p_idx" ON ONLY "public"."Partitioned"("x");`)
    ).toEqual([]);
  });

  it("exempts indexes on a table created in the same file from CONCURRENTLY", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS "public"."api_keys" ("id" TEXT NOT NULL, "key_hash" TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_key" ON "public"."api_keys"("key_hash");
      CREATE INDEX "api_keys_env_idx" ON "api_keys"("id");
    `;
    expect(rules(sql)).toEqual(["create-index-if-not-exists"]);
  });

  it("rejects CONCURRENTLY in a multi-statement file", () => {
    const sql = `
      SET lock_timeout = '5s';
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "T_x_idx" ON "T"("x");
    `;
    expect(rules(sql)).toEqual(["concurrently-single-statement"]);
    expect(
      rules(
        `ALTER TABLE "T" ADD COLUMN IF NOT EXISTS "x" TEXT;\nCREATE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "T"("x");`
      )
    ).toEqual(["concurrently-single-statement"]);
  });

  it("treats a trailing comment-only tail as no extra statement", () => {
    expect(rules(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "T"("x");\n-- done\n`)).toEqual(
      []
    );
  });
});

describe("checkMigration: drops", () => {
  it("requires IF EXISTS on drops and CONCURRENTLY on DROP INDEX", () => {
    expect(rules(`DROP TABLE "public"."Old";`)).toEqual(["drop-if-exists"]);
    expect(rules(`DROP TABLE IF EXISTS "Old";`)).toEqual([]);
    expect(rules(`DROP INDEX "T_x_idx";`)).toEqual(["drop-if-exists", "drop-index-concurrently"]);
    expect(rules(`DROP INDEX CONCURRENTLY IF EXISTS "T_x_idx";`)).toEqual([]);
    expect(rules(`ALTER TABLE "T" DROP COLUMN "x", DROP CONSTRAINT "T_fk";`)).toEqual([
      "drop-if-exists",
      "drop-if-exists",
    ]);
    expect(
      rules(`ALTER TABLE "T" DROP COLUMN IF EXISTS "x", DROP CONSTRAINT IF EXISTS "T_fk";`)
    ).toEqual([]);
    expect(rules(`DROP TYPE "Status";`)).toEqual(["drop-if-exists"]);
  });
});

describe("checkMigration: unchecked statements and directives", () => {
  it("leaves data changes, transaction control and column alterations alone", () => {
    expect(
      rules(`
        BEGIN;
        SET lock_timeout = '5s';
        UPDATE "T" SET "x" = 1 WHERE "x" IS NULL;
        INSERT INTO "T" ("id") VALUES ('a') ON CONFLICT DO NOTHING;
        ALTER TABLE "T" ALTER COLUMN "x" SET NOT NULL, ALTER COLUMN "y" DROP DEFAULT;
        ALTER TABLE "T" VALIDATE CONSTRAINT "T_check";
        COMMIT;
      `)
    ).toEqual([]);
  });

  it("flags renames and bare inserts, which fail or duplicate on a second run", () => {
    expect(rules(`ALTER TABLE "T" RENAME COLUMN "a" TO "b";`)).toEqual(["rename-guarded"]);
    expect(rules(`ALTER TYPE "Status_new" RENAME TO "Status";`)).toEqual(["rename-guarded"]);
    expect(rules(`ALTER INDEX "old_idx" RENAME TO "new_idx";`)).toEqual(["rename-guarded"]);
    expect(rules(`INSERT INTO "T" ("id") SELECT "id" FROM "U";`)).toEqual(["insert-on-conflict"]);
    expect(rules(`INSERT INTO "T" ("id") VALUES ('a') ON CONFLICT ("id") DO NOTHING;`)).toEqual([]);
    expect(
      rules(
        `INSERT INTO "T" ("id") SELECT 'a' WHERE NOT EXISTS (SELECT 1 FROM "T" WHERE "id" = 'a');`
      )
    ).toEqual([]);
    expect(
      rules(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = '"T"'::regclass AND attname = 'a') THEN
        ALTER TABLE "T" RENAME COLUMN "a" TO "b"; END IF; END $$;`)
    ).toEqual([]);
  });

  it("applies the INSERT rule behind a leading CTE and ignores dollar-quoted literals", () => {
    expect(
      rules(`WITH source AS (SELECT 'a' AS id) INSERT INTO "T" ("id") SELECT id FROM source;`)
    ).toEqual(["insert-on-conflict"]);
    expect(
      rules(
        `WITH source AS (SELECT 'a' AS id) INSERT INTO "T" ("id") SELECT id FROM source ON CONFLICT DO NOTHING;`
      )
    ).toEqual([]);
    expect(rules(`INSERT INTO "T" ("note") VALUES ($$ON CONFLICT$$);`)).toEqual([
      "insert-on-conflict",
    ]);
    expect(rules(`INSERT INTO "T" ("note") VALUES ($q$WHERE NOT EXISTS (x)$q$);`)).toEqual([
      "insert-on-conflict",
    ]);
  });

  it("does not treat two dollar signs in separate string literals as one dollar-quoted body", () => {
    expect(
      rules(
        `INSERT INTO "T" ("a", "b") VALUES ('$$', 'x') ON CONFLICT ("a") DO UPDATE SET "b" = '$$';`
      )
    ).toEqual([]);
  });

  it("masks E-strings with backslash escapes without swallowing the rest of the statement", () => {
    expect(rules(`INSERT INTO "T" ("a") VALUES (E'it\\'s') ON CONFLICT DO NOTHING;`)).toEqual([]);
    expect(rules(`INSERT INTO "T" ("a") VALUES (E'it\\'s');`)).toEqual(["insert-on-conflict"]);
  });

  it("suppresses violations on a statement with an allow directive and a reason", () => {
    const result = checkMigration(`
      -- migration-guard: allow one-off backfill table that must not pre-exist
      CREATE TABLE "Scratch" ("id" TEXT);
      CREATE TABLE "Other" ("id" TEXT);
    `);
    expect(result.violations.map((v) => v.rule)).toEqual(["create-if-not-exists"]);
    expect(result.violations[0].line).toBe(4);
    expect(result.suppressed).toBe(1);
  });

  it("rejects an allow directive without a reason and keeps the underlying violations", () => {
    expect(rules(`-- migration-guard: allow\nCREATE TABLE "Scratch" ("id" TEXT);`)).toEqual([
      "allow-reason-required",
      "create-if-not-exists",
    ]);
  });

  it("flags an allow directive that suppresses nothing", () => {
    expect(
      rules(`-- migration-guard: allow stale\nALTER TABLE "T" ADD COLUMN IF NOT EXISTS "x" TEXT;`)
    ).toEqual(["allow-unused"]);
    const dangling = checkMigration(
      `CREATE TABLE IF NOT EXISTS "T" ("id" TEXT);\n-- migration-guard: allow orphan\n`
    );
    expect(dangling.violations.map((v) => [v.line, v.rule])).toEqual([[2, "allow-unused"]]);
  });

  it("does not treat an allow directive inside a string as a directive", () => {
    expect(
      rules(
        `INSERT INTO "T" ("note") VALUES ('-- migration-guard: allow nope') ON CONFLICT DO NOTHING;\nCREATE TABLE "X" ("id" TEXT);`
      )
    ).toEqual(["create-if-not-exists"]);
  });
});

describe("checkMigration: realistic files", () => {
  it("passes a compliant two-step column + index pair as separate files", () => {
    expect(
      rules(`ALTER TABLE "public"."WorkerDeployment" ADD COLUMN IF NOT EXISTS "externalId" TEXT;`)
    ).toEqual([]);
    expect(
      rules(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "WorkerDeployment_environmentId_externalId_idx" ON "public"."WorkerDeployment"("environmentId", "externalId");`
      )
    ).toEqual([]);
  });

  it("flags every problem in a raw Prisma-generated create-table migration", () => {
    const sql = `
      -- CreateTable
      CREATE TABLE "public"."api_keys" (
          "id" TEXT NOT NULL,
          "scopes" TEXT[] NOT NULL,
          "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

          CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
      );

      -- CreateIndex
      CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "public"."api_keys"("key_hash");

      -- AddForeignKey
      ALTER TABLE "public"."api_keys" ADD CONSTRAINT "api_keys_runtime_environment_id_fkey" FOREIGN KEY ("runtime_environment_id") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    `;
    const v = checkMigration(sql).violations;
    expect(v.map((x) => [x.line, x.rule])).toEqual([
      [3, "create-if-not-exists"],
      [12, "create-index-if-not-exists"],
      [15, "add-constraint-guarded"],
    ]);
  });
});

describe("CLI", () => {
  const script = path.resolve(__dirname, "../scripts/migrationSafetyGuard.ts");
  const tsx = path.resolve(__dirname, "../node_modules/.bin/tsx");
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(tsx, [script, ...args], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ...env },
      encoding: "utf8",
    });

  it("refuses to run without a cutoff, --all, or files", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--cutoff");
  });

  it("checks explicit files relative to the invoking directory and exits 1 on violations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-guard-"));
    try {
      fs.writeFileSync(path.join(dir, "bad.sql"), `ALTER TABLE "T" ADD COLUMN "x" TEXT;\n`);
      fs.writeFileSync(
        path.join(dir, "good.sql"),
        `ALTER TABLE "T" ADD COLUMN IF NOT EXISTS "x" TEXT;\n`
      );
      const bad = run(["bad.sql"], { INIT_CWD: dir });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("bad.sql:1  [add-column-if-not-exists]");
      const good = run(["good.sql"], { INIT_CWD: dir });
      expect(good.status).toBe(0);
      expect(good.stdout).toContain("OK (1 migration(s) checked, given)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes cleanly for a cutoff in the far future", () => {
    const r = run(["--", "--cutoff", "29990101"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("0 migration(s) checked, cutoff 29990101");
  });
});
