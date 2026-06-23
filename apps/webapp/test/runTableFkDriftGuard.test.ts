import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// internal-packages/database/prisma/migrations, resolved from this test file
// (apps/webapp/test) up to the repo root.
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../internal-packages/database/prisma/migrations"
);

// The migration that physically dropped every incoming foreign key to TaskRun,
// decoupling the run tables so a run can live in either TaskRun or task_run_v2.
const DROP_FKS_MIGRATION = "20260619120042_drop_taskrun_incoming_fks";

/**
 * Guard against the Prisma FK-drift footgun for the parallel run tables.
 *
 * schema.prisma still declares the (deliberately dropped) incoming relations to
 * TaskRun AND mirror relations to task_run_v2, so a routine `prisma migrate dev`
 * for any unrelated change regenerates a migration that re-adds those foreign
 * keys. Re-adding them is destructive:
 *  - a re-added TaskRun incoming FK silently re-couples the two tables, defeating
 *    the whole parallel-table design; and
 *  - any FK referencing task_run_v2 fails on existing legacy-pointing child rows
 *    and then rejects every cross-table child insert.
 *
 * Whoever generates a migration must strip these (the established practice).
 * This test fails CI if an unstripped migration ever lands, so the parity can't
 * silently drift back.
 */
describe("run-table FK-drift guard", () => {
  const migrationDirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const sqlOf = (name: string) =>
    readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");

  // A statement that ADDs a foreign key referencing `table`. Checked per
  // statement (split on ;) so FOREIGN KEY in one statement can't pair with
  // REFERENCES in a later one.
  const addsForeignKeyReferencing = (sql: string, table: string) =>
    sql
      .split(";")
      .some(
        (stmt) => /FOREIGN KEY/i.test(stmt) && new RegExp(`REFERENCES\\s+"${table}"`, "i").test(stmt)
      );

  it("finds the migrations directory and the FK-drop migration", () => {
    expect(migrationDirs.length).toBeGreaterThan(0);
    expect(migrationDirs).toContain(DROP_FKS_MIGRATION);
  });

  it("no migration EVER adds a foreign key referencing task_run_v2", () => {
    const offenders = migrationDirs.filter((dir) => addsForeignKeyReferencing(sqlOf(dir), "task_run_v2"));
    expect(
      offenders,
      `These migrations add a destructive FK referencing task_run_v2 (a child row can point at a legacy run, so the constraint fails on existing data): ${offenders.join(", ")}. Strip the *_v2_fkey constraints from the generated migration.`
    ).toEqual([]);
  });

  it("no migration after the FK-drop re-adds an incoming foreign key to TaskRun", () => {
    const dropIdx = migrationDirs.indexOf(DROP_FKS_MIGRATION);
    const after = migrationDirs.slice(dropIdx + 1);
    const offenders = after.filter((dir) => addsForeignKeyReferencing(sqlOf(dir), "TaskRun"));
    expect(
      offenders,
      `These migrations re-add an incoming FK to TaskRun that was deliberately dropped (it re-couples the run tables): ${offenders.join(", ")}. Strip the TaskRun *_fkey constraints from the generated migration.`
    ).toEqual([]);
  });
});
