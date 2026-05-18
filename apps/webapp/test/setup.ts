// Load apps/webapp/.env into process.env so env.server's top-level
// EnvironmentSchema.parse(process.env) succeeds in vitest workers.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(__dirname, "../.env") });
