import pathModule from "path";
import { pathExists } from "./fileSystem";
import { parse } from "tsconfck";

type Options = { projectPath: string; isTypescriptProject: boolean; usesSrcDir: boolean };

// Find the alias that points to the "src" directory.
// So for example, the paths object could be:
// {
//   "@/*": ["./src/*"]
// }
// In this case, we would return "@"
export async function getPathAlias({ projectPath, isTypescriptProject, usesSrcDir }: Options) {
  const configFileName = isTypescriptProject ? "tsconfig.json" : "jsconfig.json";
  const tsConfigPath = pathModule.join(projectPath, configFileName);
  const configFileExists = await pathExists(tsConfigPath);

  //no config and javascript, no alias
  if (!isTypescriptProject && !configFileExists) {
    return;
  }

  const { tsconfig } = await parse(tsConfigPath);

  const paths = tsconfig?.compilerOptions?.paths;
  if (paths === undefined) {
    return;
  }

  const alias = Object.keys(paths).find((key) => {
    const value = paths[key];

    if (value.length === 0) {
      return false;
    }

    const path = value[0];
    if (usesSrcDir) {
      return path === "./src/*";
    } else {
      return path === "./*";
    }
  });

  // Make sure to remove the trailing "/*"
  if (alias) {
    return alias.slice(0, -2);
  }

  return;
}
