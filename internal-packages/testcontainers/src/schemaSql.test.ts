import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { generateSchemaSql } from "./utils";

const prismaBin = path.resolve(__dirname, "../../database/node_modules/.bin/prisma");

test("generates the whole schema SQL when it exceeds 128 KiB", async () => {
  const models = Array.from(
    { length: 400 },
    (_, i) => `model Model${i} {
  id String @id
  name String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([name])
}`
  );
  const dir = mkdtempSync(path.join(tmpdir(), "schema-sql-"));
  const schemaPath = path.join(dir, "schema.prisma");
  writeFileSync(
    schemaPath,
    `datasource db {\n  provider = "postgresql"\n  url = "postgresql://x"\n}\n\n${models.join("\n")}\n`
  );

  const sql = await generateSchemaSql(prismaBin, schemaPath);

  expect(sql.length).toBeGreaterThan(131_072);
  expect(sql.match(/CREATE TABLE/g)).toHaveLength(models.length);
  expect(sql.trimEnd().endsWith(";")).toBe(true);
});
