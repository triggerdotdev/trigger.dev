import fs from "fs/promises";
import pathModule from "path";
import { pathExists } from "./fileSystem";
import { logger } from "./logger";
import { renderApiKey } from "./renderApiKey";

export async function getEnvFilename(
  directory: string,
  possibleNames: string[]
): Promise<string | undefined> {
  if (possibleNames.length === 0) {
    throw new Error("No possible names provided");
  }

  for (let index = 0; index < possibleNames.length; index++) {
    const name = possibleNames[index];
    if (!name) continue;

    const path = pathModule.join(directory, name);
    const envFileExists = await pathExists(path);
    if (envFileExists) {
      return name;
    }
  }

  return undefined;
}

export async function setApiKeyEnvironmentVariable(dir: string, fileName: string, apiKey: string) {
  await setEnvironmentVariable(dir, fileName, "TRIGGER_API_KEY", apiKey, true, renderApiKey);
}

export async function setApiUrlEnvironmentVariable(dir: string, fileName: string, apiUrl: string) {
  await setEnvironmentVariable(dir, fileName, "TRIGGER_API_URL", apiUrl, true);
}

export async function setPublicApiKeyEnvironmentVariable(
  dir: string,
  fileName: string,
  varName: string | undefined,
  publicApiKey: string
) {
  await setEnvironmentVariable(
    dir,
    fileName,
    varName ?? "TRIGGER_PUBLIC_API_KEY",
    publicApiKey,
    true,
    renderApiKey
  );
}

async function setEnvironmentVariable(
  dir: string,
  fileName: string,
  variableName: string,
  value: string,
  replaceValue: boolean = true,
  renderer: (value: string) => string = (value) => value
) {
  const path = pathModule.join(dir, fileName);
  const envFileExists = await pathExists(path);

  if (!envFileExists) {
    await fs.writeFile(path, "");
  }

  const envFileContent = await fs.readFile(path, "utf-8");

  if (envFileContent.includes(variableName)) {
    if (!replaceValue) {
      logger.info(
        `☑ Skipping setting ${variableName}=${renderer(value)} because it already exists`
      );
      return;
    }
    // Update the existing value
    const updatedEnvFileContent = envFileContent.replace(
      new RegExp(`${variableName}=.*\\n`, "g"),
      `${variableName}=${value}\n`
    );

    await fs.writeFile(path, updatedEnvFileContent);

    logger.success(`✔ Set ${variableName}=${renderer(value)} in ${fileName}`);
  } else {
    await fs.appendFile(path, `\n${variableName}=${value}`);

    logger.success(`✔ Added ${variableName}=${renderer(value)} to ${fileName}`);
  }
}
