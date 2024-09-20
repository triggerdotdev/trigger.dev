import dotenv from "dotenv";
import { resolve } from "node:path";
import { env } from "std-env";

const ENVVAR_FILES = [".env", ".env.development", ".env.local", ".env.development.local"];

export function resolveDotEnvVars(cwd?: string, envFile?: string) {
  const result: { [key: string]: string } = {};

  const envFilePath = envFile
    ? resolve(cwd ?? process.cwd(), envFile)
    : ENVVAR_FILES.map((p) => resolve(cwd ?? process.cwd(), p));

  // Load environment variables from the first found .env file
  const { parsed } = dotenv.config({
    path: Array.isArray(envFilePath) ? envFilePath.find(path => fs.existsSync(path)) : envFilePath,
  });

  if (parsed) {
    Object.assign(result, parsed);
  }

  env.TRIGGER_API_URL && (result.TRIGGER_API_URL = env.TRIGGER_API_URL);

  // Remove sensitive environment variables
  delete result.TRIGGER_API_URL;
  delete result.TRIGGER_SECRET_KEY;
  delete result.OTEL_EXPORTER_OTLP_ENDPOINT;

  return result;
}

export function loadDotEnvVars(cwd?: string, envFile?: string) {
  const envFilePath = envFile
    ? resolve(cwd ?? process.cwd(), envFile)
    : ENVVAR_FILES.map((p) => resolve(cwd ?? process.cwd(), p));

  // Load the first found .env file
  dotenv.config({
    path: Array.isArray(envFilePath) ? envFilePath.find(path => fs.existsSync(path)) : envFilePath,
  });
}
