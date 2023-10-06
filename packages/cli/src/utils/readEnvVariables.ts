import pathModule from "path";
import { pathExists, readFile } from "./fileSystem";
import dotenv from "dotenv";

const ENV_FILES_FALLBACK = [".env", ".env.local", ".env.development.local"];

export type EnvVarSourceRuntime = {
  type: "runtime";
};

export type EnvVarSourceFile = {
  type: "file";
  name: string;
};

export type EnvVarSource = EnvVarSourceRuntime | EnvVarSourceFile;

export type EnvironmentVariable = {
  value: string;
  source: EnvVarSource;
};

export type EnvironmentVariables = {
  [name: string]: EnvironmentVariable | undefined;
};

// Reads `varsToRead` from `process.env` and `envFile` (with fallbacks).
// `process.env` takes precedence over the `envFile`.
export async function readEnvVariables(
  path: string,
  envFile: string,
  varsToRead: string[]
): Promise<EnvironmentVariables> {
  const resolvedEnvFile = await readEnvFilesWithBackups(path, envFile);
  const parsedEnvFile = resolvedEnvFile
    ? { output: dotenv.parse(resolvedEnvFile.content), filename: resolvedEnvFile.fileName }
    : {};

  return Object.fromEntries(
    varsToRead.map((envVar) => [
      envVar,
      readFromRuntime(envVar) ?? readFromFile(envVar, parsedEnvFile),
    ])
  );
}

async function readEnvFilesWithBackups(
  path: string,
  envFile: string
): Promise<{ content: string; fileName: string } | undefined> {
  const envFilePath = pathModule.join(path, envFile);
  const envFileExists = await pathExists(envFilePath);

  if (envFileExists) {
    const content = await readFile(envFilePath);

    return { content, fileName: envFile };
  }

  for (const fallBack of ENV_FILES_FALLBACK) {
    const fallbackPath = pathModule.join(path, fallBack);
    const fallbackExists = await pathExists(fallbackPath);

    if (fallbackExists) {
      const content = await readFile(fallbackPath);

      return { content, fileName: fallBack };
    }
  }

  return;
}

function readFromRuntime(envVar: string): EnvironmentVariable | undefined {
  const val = process.env[envVar];
  if (!val) {
    return;
  }
  return {
    value: val,
    source: {
      type: "runtime",
    } as EnvVarSourceRuntime,
  };
}

function readFromFile(
  envVar: string,
  parsedEnvFile: { output?: dotenv.DotenvParseOutput; filename?: string }
): EnvironmentVariable | undefined {
  const val = parsedEnvFile.output ? parsedEnvFile.output[envVar] : undefined;
  if (!val) {
    return;
  }
  return {
    value: val,
    source: {
      type: "file",
      name: parsedEnvFile.filename,
    } as EnvVarSourceFile,
  };
}
