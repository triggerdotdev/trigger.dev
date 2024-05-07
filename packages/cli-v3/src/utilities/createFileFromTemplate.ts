import fs from "fs/promises";
import { pathExists, readFile } from "./fileSystem";
import path from "path";

type Result =
  | {
      success: true;
      alreadyExisted: boolean;
    }
  | {
      success: false;
      error: string;
    };

export async function createFileFromTemplate(params: {
  templatePath: string;
  replacements: Record<string, string>;
  outputPath: string;
  override?: boolean;
}): Promise<Result> {
  let template = await readFile(params.templatePath);

  if ((await pathExists(params.outputPath)) && !params.override) {
    return {
      success: true,
      alreadyExisted: true,
    };
  }

  try {
    const output = replaceAll(template, params.replacements);

    const directoryName = path.dirname(params.outputPath);
    await fs.mkdir(directoryName, { recursive: true });
    await fs.writeFile(params.outputPath, output);

    return {
      success: true,
      alreadyExisted: false,
    };
  } catch (e) {
    if (e instanceof Error) {
      return {
        success: false,
        error: e.message,
      };
    }
    return {
      success: false,
      error: JSON.stringify(e),
    };
  }
}

// find strings that match ${varName} and replace with the value from a Record<string, string> where { varName: "value" }
export function replaceAll(input: string, replacements: Record<string, string>) {
  let output = input;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replace(new RegExp(`\\$\\{${key}\\}`, "g"), value);
  }
  return output;
}
