import dotenv from "dotenv";
import { resolve } from "node:path";
import { env } from "std-env";

const ENVVAR_FILES = [".env", ".env.development", ".env.local", ".env.development.local"];

export function resolveDotEnvVars(cwd?: string) {
  const result: { [key: string]: string } = {};

  dotenv.config({
    processEnv: result,
    path: ENVVAR_FILES.map((p) => resolve(cwd ?? process.cwd(), p)),
  });

  env.TRIGGER_API_URL && (result.TRIGGER_API_URL = env.TRIGGER_API_URL);

  // remove TRIGGER_API_URL and TRIGGER_SECRET_KEY, since those should be coming from the worker
  delete result.TRIGGER_API_URL;
  delete result.TRIGGER_SECRET_KEY;

  return result;
}

export function loadDotEnvVars(cwd?: string) {
  dotenv.config({
    path: ENVVAR_FILES.map((p) => resolve(cwd ?? process.cwd(), p)),
  });
}
