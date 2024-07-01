import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ReadConfigResult } from "../src/utilities/configFiles";

type CreateContainerFileOptions = {
  resolvedConfig: ReadConfigResult;
  tempDir: string;
};

export async function createContainerFile(options: CreateContainerFileOptions) {
  if (options.resolvedConfig.status === "error") {
    throw new Error("cannot resolve config");
  }
  const {
    resolvedConfig: { config },
    tempDir,
  } = options;

  // COPIED FROM compileProject()
  // Write the Containerfile to /mpt / dir / Containerfile;
  // const containerFilePath = join(cliRootPath(), "Containerfile.prod");
  const containerFilePath = resolve("./src/Containerfile.prod");

  let containerFileContents = readFileSync(containerFilePath, "utf-8");

  await writeFile(join(tempDir, "Containerfile"), containerFileContents);
}
