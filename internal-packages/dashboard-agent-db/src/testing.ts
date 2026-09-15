import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Runs one statement. Lets a suite replay with whatever client it already has. */
export type MigrationExecutor = (statement: string) => Promise<unknown>;

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

/** Replays every migration in order, so a new migration can't leave a suite on a stale schema. */
export async function applyDashboardAgentMigrations(execute: MigrationExecutor): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const migration = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await execute(trimmed);
    }
  }
}
