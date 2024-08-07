import dotenv from "dotenv";
import { resolve } from "node:path";

export function resolveDotEnvVars(cwd?: string) {
  const result: { [key: string]: string } = {};

  dotenv.config({
    processEnv: result,
    path: [".env", ".env.local", ".env.development.local"].map((p) =>
      resolve(cwd ?? process.cwd(), p)
    ),
  });

  process.env.TRIGGER_API_URL && (result.TRIGGER_API_URL = process.env.TRIGGER_API_URL);

  // remove TRIGGER_API_URL and TRIGGER_SECRET_KEY, since those should be coming from the worker
  delete result.TRIGGER_API_URL;
  delete result.TRIGGER_SECRET_KEY;

  return result;
}
