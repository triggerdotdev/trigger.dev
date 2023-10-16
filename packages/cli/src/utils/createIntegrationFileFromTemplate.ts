import fs from "fs/promises";
import { Liquid } from "liquidjs";
import path from "path";

import { pathExists } from "./fileSystem";
import { templatesPath } from "../paths";

type Result =
  | {
      success: true;
      alreadyExisted: boolean;
    }
  | {
      success: false;
      error: string;
    };

const templatesDir = path.join(templatesPath(), "integration");

const liquid = new Liquid({
  root: templatesDir,
  trimTagRight: true,
  trimOutputRight: true,
});

export async function createIntegrationFileFromTemplate(params: {
  relativeTemplatePath: string;
  variables?: Record<string, any>;
  outputPath: string;
}): Promise<Result> {
  if (await pathExists(params.outputPath)) {
    return {
      success: true,
      alreadyExisted: true,
    };
  }

  try {
    const output = await liquid.renderFile(params.relativeTemplatePath, params.variables);

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
