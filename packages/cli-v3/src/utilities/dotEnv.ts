import dotenv from "dotenv";
import { resolve } from "node:path";
import { env } from "std-env";

const ENVVAR_FILES = [
  ".env",
  ".env.development",
  ".env.local",
  ".env.development.local",
  "dev.vars",
];

export function resolveDotEnvVars(cwd?: string, envFile?: string) {
  const result: { [key: string]: string } = {};

  const envFilePath = envFile
    ? resolve(cwd ?? process.cwd(), envFile)
    : ENVVAR_FILES.map((p) => resolve(cwd ?? process.cwd(), p));

  dotenv.config({
    processEnv: result,
    path: envFilePath,
  });

  env.TRIGGER_API_URL && (result.TRIGGER_API_URL = env.TRIGGER_API_URL);

  // remove TRIGGER_API_URL and TRIGGER_SECRET_KEY, since those should be coming from the worker
  delete result.TRIGGER_API_URL;
  delete result.TRIGGER_SECRET_KEY;
  delete result.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (result.OTEL_RESOURCE_ATTRIBUTES) {
    result.CUSTOM_OTEL_RESOURCE_ATTRIBUTES = result.OTEL_RESOURCE_ATTRIBUTES;
    delete result.OTEL_RESOURCE_ATTRIBUTES;
  }

  return result;
}

export function loadDotEnvVars(cwd?: string, envFile?: string) {
  const envFilePath = envFile
    ? resolve(cwd ?? process.cwd(), envFile)
    : ENVVAR_FILES.map((p) => resolve(cwd ?? process.cwd(), p));

  dotenv.config({
    path: envFilePath,
  });
}
