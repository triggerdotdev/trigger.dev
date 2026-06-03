import path from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  engine: "classic",
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/trigger",
    directUrl: process.env.DIRECT_URL,
  },
});
